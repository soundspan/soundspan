import {
    normalizeAlbumTitle,
    normalizeArtistName,
} from "../../utils/artistNormalization";
import { logger } from "../../utils/logger";
import { rgMbidKind } from "../../utils/musicIds";
import { redisClient } from "../../utils/redis";
import { coverArtService } from "../coverArt";
import { deezerService } from "../deezer";
import { fanartService } from "../fanart";

const log = logger.child("AlbumCoverResolver");
const OVERALL_BUDGET_MS = 8_000;
const CACHE_OPERATION_BUDGET_MS = 250;
const POSITIVE_TTL_SECONDS = 7 * 24 * 60 * 60;
const NEGATIVE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = "metadata:album-cover:";
const MAX_IN_FLIGHT = 1_000;

/** Provider rung that produced an album cover. */
export type AlbumCoverSource = "coverartarchive" | "deezer" | "fanart";

/** Album identity accepted by the canonical cover resolver. */
export interface AlbumCoverInput {
    artistName: string;
    albumTitle: string;
    rgMbid?: string | null;
}

/** Canonical album cover and the provider that supplied it. */
export interface AlbumCoverResolution {
    url: string;
    source: AlbumCoverSource;
}

type CacheLookup =
    | { found: false }
    | { found: true; value: AlbumCoverResolution | null };

type RungResult =
    | { status: "resolved"; value: AlbumCoverResolution }
    | { status: "miss"; transient: boolean };

type AlbumCoverRung = Readonly<{
    source: AlbumCoverSource;
    requiresMbid: boolean;
    fetch: (
        input: AlbumCoverInput,
        mbid: string | null,
    ) => Promise<string | null>;
}>;

class BudgetExpiredError extends Error {}

function cacheKeyFor(artistName: string, albumTitle: string): string {
    const artist = encodeURIComponent(normalizeArtistName(artistName));
    const album = encodeURIComponent(normalizeAlbumTitle(albumTitle));
    return `${CACHE_PREFIX}${artist}::${album}`;
}

function isResolution(value: unknown): value is AlbumCoverResolution {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.url === "string" &&
        candidate.url.length > 0 &&
        ["coverartarchive", "deezer", "fanart"].includes(
            candidate.source as string,
        )
    );
}

async function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
): Promise<T> {
    if (timeoutMs <= 0) throw new BudgetExpiredError("Budget expired");
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new BudgetExpiredError("Budget expired")),
                    timeoutMs,
                );
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function remainingBudget(deadlineMs: number): number {
    return Math.max(0, deadlineMs - Date.now());
}

async function readCache(
    key: string,
    deadlineMs: number,
): Promise<CacheLookup> {
    try {
        const timeout = Math.min(
            CACHE_OPERATION_BUDGET_MS,
            remainingBudget(deadlineMs),
        );
        const raw = await withTimeout(() => redisClient.get(key), timeout);
        if (!raw) return { found: false };
        const parsed: unknown = JSON.parse(raw);
        if ((parsed as { status?: unknown })?.status === "miss") {
            return { found: true, value: null };
        }
        const value = (parsed as { value?: unknown })?.value;
        return isResolution(value) ? { found: true, value } : { found: false };
    } catch (error) {
        log.debug("Album cover cache read failed", error);
        return { found: false };
    }
}

async function writeCache(
    key: string,
    value: AlbumCoverResolution | null,
    deadlineMs: number,
): Promise<void> {
    const ttl = value ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS;
    const payload = value
        ? JSON.stringify({ status: "hit", value })
        : JSON.stringify({ status: "miss" });
    try {
        const timeout = Math.min(
            CACHE_OPERATION_BUDGET_MS,
            remainingBudget(deadlineMs),
        );
        await withTimeout(() => redisClient.setEx(key, ttl, payload), timeout);
    } catch (error) {
        log.debug("Album cover cache write failed", error);
    }
}

const ALBUM_COVER_RUNGS: readonly AlbumCoverRung[] = [
    {
        source: "coverartarchive",
        requiresMbid: true,
        fetch: async (_input, mbid) => {
            if (!mbid) return null;
            return coverArtService.getCoverArt(mbid);
        },
    },
    {
        source: "deezer",
        requiresMbid: false,
        fetch: (input) =>
            deezerService.getAlbumCover(input.artistName, input.albumTitle),
    },
    {
        source: "fanart",
        requiresMbid: true,
        fetch: async (_input, mbid) => {
            if (!mbid) return null;
            return fanartService.getAlbumCover(mbid);
        },
    },
];

async function tryRung(
    rung: AlbumCoverRung,
    input: AlbumCoverInput,
    realMbid: string | null,
    deadlineMs: number,
): Promise<RungResult> {
    try {
        const url = await withTimeout(
            () => rung.fetch(input, realMbid),
            remainingBudget(deadlineMs),
        );
        return url
            ? { status: "resolved", value: { url, source: rung.source } }
            : { status: "miss", transient: false };
    } catch (error) {
        if (error instanceof BudgetExpiredError) throw error;
        log.debug(`Album cover lookup failed at ${rung.source}`, error);
        return { status: "miss", transient: true };
    }
}

function realReleaseGroupMbid(
    rgMbid: string | null | undefined,
): string | null {
    if (!rgMbid || rgMbidKind(rgMbid) !== "musicbrainz") return null;
    return rgMbid;
}

async function runLadder(
    input: AlbumCoverInput,
    deadlineMs: number,
): Promise<RungResult> {
    const realMbid = realReleaseGroupMbid(input.rgMbid);
    let transient = false;
    for (let index = 0; index < ALBUM_COVER_RUNGS.length; index += 1) {
        const rung = ALBUM_COVER_RUNGS[index];
        if (rung.requiresMbid && !realMbid) continue;
        const result = await tryRung(rung, input, realMbid, deadlineMs);
        if (result.status === "resolved") return result;
        transient ||= result.transient;
    }
    return { status: "miss", transient };
}

async function resolveWithoutDedupe(
    input: AlbumCoverInput,
    cacheKey: string,
): Promise<AlbumCoverResolution | null> {
    const deadlineMs = Date.now() + OVERALL_BUDGET_MS;
    const cached = await readCache(cacheKey, deadlineMs);
    if (cached.found) return cached.value;

    try {
        const result = await runLadder(input, deadlineMs);
        if (result.status === "resolved") {
            await writeCache(cacheKey, result.value, deadlineMs);
            return result.value;
        }
        if (!result.transient) await writeCache(cacheKey, null, deadlineMs);
        return null;
    } catch (error) {
        if (error instanceof BudgetExpiredError) {
            log.debug("Album cover resolution budget expired");
            return null;
        }
        throw error;
    }
}

const inFlight = new Map<string, Promise<AlbumCoverResolution | null>>();

/** Resolve an album cover through the canonical bounded provider ladder. */
export async function resolveAlbumCover(
    input: AlbumCoverInput,
): Promise<AlbumCoverResolution | null> {
    if (
        typeof input.artistName !== "string" ||
        !input.artistName.trim() ||
        typeof input.albumTitle !== "string" ||
        !input.albumTitle.trim()
    ) {
        return null;
    }
    const cacheKey = cacheKeyFor(input.artistName, input.albumTitle);
    const existing = inFlight.get(cacheKey);
    if (existing) return existing;
    if (inFlight.size >= MAX_IN_FLIGHT) {
        return resolveWithoutDedupe(input, cacheKey);
    }

    const task = resolveWithoutDedupe(input, cacheKey);
    inFlight.set(cacheKey, task);
    try {
        return await task;
    } finally {
        if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey);
    }
}
