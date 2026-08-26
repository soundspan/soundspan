import { normalizeForExactKey } from "../../utils/artistNormalization";
import { logger } from "../../utils/logger";
import { fetchReconciliationAlbumMaps } from "./reconciliationAlbumStream";
import {
    lidarrErrorLogFields,
    type LidarrHttpClient,
} from "./lidarrHttpClient";

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

/** Fetches queue and downloaded-album state in one bounded snapshot. */
export async function getReconciliationSnapshot(
    client: LidarrHttpClient | null,
    enabled: boolean,
    signal?: AbortSignal,
): Promise<ReconciliationSnapshot> {
    const snapshot = emptySnapshot();
    if (!enabled || !client) return snapshot;
    const ownedController = new AbortController();
    const requestSignal = signal
        ? AbortSignal.any([signal, ownedController.signal])
        : ownedController.signal;
    try {
        const [queueResponse] = await Promise.all([
            client.get<{ records?: QueueRecord[] }>("/api/v1/queue", {
                params: {
                    page: 1,
                    pageSize: 1000,
                    includeUnknownArtistItems: true,
                },
                signal: requestSignal,
            }),
            fetchReconciliationAlbumMaps(client, snapshot, requestSignal),
        ]);
        indexQueue(snapshot, queueResponse.data.records || []);
        logger.debug(
            `[LIDARR] Snapshot fetched: ${snapshot.queue.size} queue items, ${snapshot.albumsByMbid.size} albums with files`,
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
