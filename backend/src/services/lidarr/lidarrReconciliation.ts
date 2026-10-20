import { normalizeForExactKey } from "../../utils/artistNormalization";
import { logger } from "../../utils/logger";
import type { ReconciliationScope } from "../download/reconciliationScope";
import {
    fetchReconciliationAlbumMaps,
    indexReconciliationAlbum,
} from "./reconciliationAlbumStream";
import {
    allSettledWithConcurrency,
    lidarrErrorLogFields,
    type LidarrHttpClient,
} from "./lidarrHttpClient";

/** Maximum distinct album MBIDs queried during one snapshot. */
export const RECONCILIATION_MAX_MBID_LOOKUPS = 200;
/** Maximum distinct artist catalogs queried during one snapshot. */
export const RECONCILIATION_MAX_ARTIST_FETCHES = 10;
/** Largest artist catalog eligible for title-fallback indexing. */
export const RECONCILIATION_MAX_ARTIST_ALBUMS = 1000;
const RECONCILIATION_MBID_CONCURRENCY = 4;
const RECONCILIATION_ARTIST_CONCURRENCY = 2;

/** Snapshot of Lidarr state for efficient batch reconciliation. */
export interface ReconciliationSnapshot {
    queue: Map<string, QueueSnapshotItem>;
    albumsByMbid: Map<string, AlbumSnapshotInfo>;
    albumsByTitle: Map<string, AlbumSnapshotInfo>;
    fetchedAt: Date;
}

/** Queue entry indexed by download identifier. */
export interface QueueSnapshotItem {
    id: number;
    downloadId: string;
    status: string;
    progress?: number;
    title: string;
}

/** Downloaded album entry indexed by MBID and normalized title. */
export interface AlbumSnapshotInfo {
    id: number;
    title: string;
    foreignAlbumId: string;
    artistName: string;
    hasFiles: boolean;
}

interface QueueRecord extends QueueSnapshotItem {
    size?: number;
    sizeleft?: number;
}

interface ArtistFetchTarget {
    id: number;
    artistName: string;
    albumCount: number;
}

interface RequestCounter {
    value: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function emptySnapshot(): ReconciliationSnapshot {
    return {
        queue: new Map(),
        albumsByMbid: new Map(),
        albumsByTitle: new Map(),
        fetchedAt: new Date(),
    };
}

function indexQueue(
    snapshot: ReconciliationSnapshot,
    records: QueueRecord[],
): void {
    for (const item of records) {
        if (!item.downloadId) continue;
        const progress =
            item.sizeleft && item.size
                ? Math.round(((item.size - item.sizeleft) / item.size) * 100)
                : undefined;
        snapshot.queue.set(item.downloadId, {
            id: item.id,
            downloadId: item.downloadId,
            status: item.status,
            progress,
            title: item.title,
        });
    }
}

async function fetchQueue(
    client: LidarrHttpClient,
    snapshot: ReconciliationSnapshot,
    signal: AbortSignal,
    requests: RequestCounter,
): Promise<void> {
    requests.value += 1;
    const response = await client.get<{ records?: QueueRecord[] }>(
        "/api/v1/queue",
        {
            params: {
                page: 1,
                pageSize: 1000,
                includeUnknownArtistItems: true,
            },
            signal,
        },
    );
    indexQueue(snapshot, response.data.records || []);
}

function scopedMbids(scope: ReconciliationScope): string[] {
    const distinct = [
        ...new Set(
            scope.albumTargets.flatMap(({ mbids }) => mbids.filter(Boolean)),
        ),
    ];
    const dropped = distinct.length - RECONCILIATION_MAX_MBID_LOOKUPS;
    if (dropped > 0) {
        logger.debug(
            `[LIDARR] Reconciliation MBID lookup cap dropped ${dropped} target(s)`,
        );
    }
    return distinct.slice(0, RECONCILIATION_MAX_MBID_LOOKUPS);
}

function throwFirstRejection(results: PromiseSettledResult<void>[]): void {
    const rejected = results.find(
        (result): result is PromiseRejectedResult =>
            result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
}

async function fetchMbidAlbums(
    client: LidarrHttpClient,
    snapshot: ReconciliationSnapshot,
    scope: ReconciliationScope,
    signal: AbortSignal,
    requests: RequestCounter,
): Promise<void> {
    const results = await allSettledWithConcurrency(
        scopedMbids(scope),
        RECONCILIATION_MBID_CONCURRENCY,
        async (foreignAlbumId) => {
            requests.value += 1;
            const response = await client.get<unknown>("/api/v1/album", {
                params: { foreignAlbumId },
                signal,
            });
            if (!Array.isArray(response.data)) {
                throw new Error("Lidarr album lookup was not an array");
            }
            for (const value of response.data) {
                indexReconciliationAlbum(snapshot, value);
            }
        },
    );
    throwFirstRejection(results);
}

function unresolvedArtistKeys(
    scope: ReconciliationScope,
    snapshot: ReconciliationSnapshot,
): string[] {
    const keys = scope.albumTargets
        .filter(
            ({ mbids, artistName }) =>
                Boolean(artistName) &&
                !mbids.some((mbid) => snapshot.albumsByMbid.has(mbid)),
        )
        .map(({ artistName }) => normalizeForExactKey(artistName || ""));
    return [...new Set(keys.filter(Boolean))];
}

function parseArtist(value: unknown): ArtistFetchTarget | null {
    if (!isRecord(value) || !isRecord(value.statistics)) return null;
    const albumCount = value.statistics.albumCount;
    if (
        typeof value.id !== "number" ||
        !Number.isSafeInteger(value.id) ||
        typeof value.artistName !== "string" ||
        typeof albumCount !== "number" ||
        !Number.isSafeInteger(albumCount) ||
        albumCount < 0
    ) {
        return null;
    }
    return { id: value.id, artistName: value.artistName, albumCount };
}

function matchArtists(
    artistKeys: string[],
    values: unknown[],
): ArtistFetchTarget[] {
    const byName = new Map<string, ArtistFetchTarget>();
    for (const value of values) {
        const artist = parseArtist(value);
        if (!artist) continue;
        const key = normalizeForExactKey(artist.artistName);
        if (key && !byName.has(key)) byName.set(key, artist);
    }
    const matched: ArtistFetchTarget[] = [];
    const ids = new Set<number>();
    for (const key of artistKeys) {
        const artist = byName.get(key);
        if (!artist || ids.has(artist.id)) continue;
        matched.push(artist);
        ids.add(artist.id);
        if (matched.length === RECONCILIATION_MAX_ARTIST_FETCHES) break;
    }
    return matched;
}

async function fetchArtistAlbums(
    client: LidarrHttpClient,
    snapshot: ReconciliationSnapshot,
    artists: ArtistFetchTarget[],
    signal: AbortSignal,
    requests: RequestCounter,
): Promise<void> {
    const eligible = artists.filter(
        ({ albumCount }) => albumCount <= RECONCILIATION_MAX_ARTIST_ALBUMS,
    );
    const skipped = artists.length - eligible.length;
    if (skipped > 0) {
        logger.debug(
            `[LIDARR] Reconciliation skipped ${skipped} oversized artist catalog(s)`,
        );
    }
    const results = await allSettledWithConcurrency(
        eligible,
        RECONCILIATION_ARTIST_CONCURRENCY,
        async ({ id }) => {
            requests.value += 1;
            await fetchReconciliationAlbumMaps(client, snapshot, signal, {
                artistId: id,
            });
        },
    );
    throwFirstRejection(results);
}

async function fetchTitleFallbacks(
    client: LidarrHttpClient,
    snapshot: ReconciliationSnapshot,
    scope: ReconciliationScope,
    signal: AbortSignal,
    requests: RequestCounter,
): Promise<void> {
    const artistKeys = unresolvedArtistKeys(scope, snapshot);
    if (artistKeys.length === 0) return;
    requests.value += 1;
    const response = await client.get<unknown>("/api/v1/artist", { signal });
    if (!Array.isArray(response.data)) {
        throw new Error("Lidarr artist response was not an array");
    }
    const artists = matchArtists(artistKeys, response.data);
    await fetchArtistAlbums(client, snapshot, artists, signal, requests);
}

/** Fetches queue and downloaded-album state in one bounded snapshot. */
export async function getReconciliationSnapshot(
    client: LidarrHttpClient | null,
    enabled: boolean,
    scope: ReconciliationScope,
    signal?: AbortSignal,
): Promise<ReconciliationSnapshot> {
    const snapshot = emptySnapshot();
    if (!enabled || !client) return snapshot;
    if (!scope.needsQueue && scope.albumTargets.length === 0) {
        logger.debug(
            "[LIDARR] Snapshot fetched: 0 queue items, 0 albums with files, 0 Lidarr requests",
        );
        return snapshot;
    }
    const ownedController = new AbortController();
    const requestSignal = signal
        ? AbortSignal.any([signal, ownedController.signal])
        : ownedController.signal;
    try {
        const requests: RequestCounter = { value: 0 };
        if (scope.needsQueue) {
            await fetchQueue(client, snapshot, requestSignal, requests);
        }
        await fetchMbidAlbums(client, snapshot, scope, requestSignal, requests);
        await fetchTitleFallbacks(
            client,
            snapshot,
            scope,
            requestSignal,
            requests,
        );
        logger.debug(
            `[LIDARR] Snapshot fetched: ${snapshot.queue.size} queue items, ${snapshot.albumsByMbid.size} albums with files, ${requests.value} Lidarr requests`,
        );
        return snapshot;
    } catch (error: unknown) {
        ownedController.abort(error);
        logger.error(
            "[LIDARR] Failed to create reconciliation snapshot:",
            lidarrErrorLogFields(error),
        );
        throw error;
    }
}

/** Checks whether a snapshot contains a downloaded album. */
export function isAlbumAvailableInSnapshot(
    snapshot: ReconciliationSnapshot,
    mbid?: string,
    artistName?: string,
    albumTitle?: string,
): boolean {
    if (mbid && snapshot.albumsByMbid.has(mbid)) return true;
    if (!artistName || !albumTitle) return false;
    const artist = normalizeForExactKey(artistName);
    const album = normalizeForExactKey(albumTitle);
    if (snapshot.albumsByTitle.has(`${artist}|${album}`)) return true;
    for (const titleKey of snapshot.albumsByTitle.keys()) {
        const [keyArtist, keyAlbum] = titleKey.split("|");
        if (
            keyArtist === artist &&
            (keyAlbum.includes(album) || album.includes(keyAlbum))
        ) {
            return true;
        }
    }
    return false;
}

/** Checks whether a snapshot contains a non-failed queue download. */
export function isDownloadActiveInSnapshot(
    snapshot: ReconciliationSnapshot,
    downloadId: string,
): { active: boolean; progress?: number } {
    const item = snapshot.queue.get(downloadId);
    if (!item) return { active: false };
    const active = item.status !== "failed" && item.status !== "warning";
    return { active, progress: item.progress };
}
