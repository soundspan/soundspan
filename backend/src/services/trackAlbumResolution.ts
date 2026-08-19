import { createHash } from "crypto";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { isGenericAlbumTitle } from "./albumTitleGuards";
import { deezerService } from "./deezer";
import { lastFmService } from "./lastfm";
import { musicBrainzService } from "./musicbrainz";

const log = logger.child("TrackAlbumResolution");
const OVERALL_BUDGET_MS = 10_000;
const CACHE_OPERATION_BUDGET_MS = 250;
const POSITIVE_TTL_SECONDS = 7 * 24 * 60 * 60;
const NEGATIVE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = "track-album-resolution:";

/** Provider rung that produced an external track album resolution. */
export type TrackAlbumResolutionSource =
    | "musicbrainz-album"
    | "musicbrainz-recording"
    | "lastfm"
    | "deezer";

const RESOLUTION_SOURCES = new Set<TrackAlbumResolutionSource>([
    "musicbrainz-album",
    "musicbrainz-recording",
    "lastfm",
    "deezer",
]);

/** Canonical release-group album resolved for an external track. */
export interface ExternalTrackAlbumResolution {
    albumTitle: string;
    rgMbid: string;
    artistName: string;
    source: TrackAlbumResolutionSource;
}

/** Track identity accepted by the external album resolver. */
export interface ExternalTrackAlbumInput {
    trackTitle: string;
    artistName: string;
    albumTitle?: string;
}

type CacheLookup =
    | { found: false }
    | { found: true; value: ExternalTrackAlbumResolution | null };

class BudgetExpiredError extends Error {}

function normalizeCachePart(value?: string): string {
    return (value ?? "")
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function buildCacheKey(input: ExternalTrackAlbumInput): string {
    const identity = [input.artistName, input.trackTitle, input.albumTitle]
        .map(normalizeCachePart)
        .join("\u0000");
    return `${CACHE_PREFIX}${createHash("sha256").update(identity).digest("hex")}`;
}

function isResolution(value: unknown): value is ExternalTrackAlbumResolution {
    if (!value || typeof value !== "object") return false;
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.albumTitle === "string" &&
        entry.albumTitle.length > 0 &&
        typeof entry.rgMbid === "string" &&
        entry.rgMbid.length > 0 &&
        typeof entry.artistName === "string" &&
        entry.artistName.length > 0 &&
        RESOLUTION_SOURCES.has(entry.source as TrackAlbumResolutionSource)
    );
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number) {
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

async function callWithinBudget<T>(
    operation: () => Promise<T>,
    deadlineMs: number,
): Promise<T> {
    return withTimeout(operation, remainingBudget(deadlineMs));
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
        if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { status?: unknown }).status === "miss"
        ) {
            return { found: true, value: null };
        }
        const value = (parsed as { value?: unknown })?.value;
        return isResolution(value) ? { found: true, value } : { found: false };
    } catch (error) {
        log.debug("Track album cache read failed", error);
        return { found: false };
    }
}

async function writeCache(
    key: string,
    value: ExternalTrackAlbumResolution | null,
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
        log.debug("Track album cache write failed", error);
    }
}

function fromAlbumSearch(
    album: { id: string; title: string } | null,
    artistName: string,
    source: TrackAlbumResolutionSource,
): ExternalTrackAlbumResolution | null {
    if (!album?.id || !album.title) return null;
    return {
        albumTitle: album.title,
        rgMbid: album.id,
        artistName,
        source,
    };
}

async function searchAlbumTitle(
    albumTitle: string,
    input: ExternalTrackAlbumInput,
    source: TrackAlbumResolutionSource,
    deadlineMs: number,
): Promise<ExternalTrackAlbumResolution | null> {
    try {
        const album = await callWithinBudget(
            () =>
                musicBrainzService.searchAlbum(
                    albumTitle.trim(),
                    input.artistName,
                ),
            deadlineMs,
        );
        return fromAlbumSearch(album, input.artistName, source);
    } catch (error) {
        if (error instanceof BudgetExpiredError) throw error;
        log.debug(`Album lookup failed at ${source}`, error);
        return null;
    }
}

async function tryProvidedAlbum(
    input: ExternalTrackAlbumInput,
    deadlineMs: number,
): Promise<ExternalTrackAlbumResolution | null> {
    if (isGenericAlbumTitle(input.albumTitle)) return null;
    return searchAlbumTitle(
        input.albumTitle as string,
        input,
        "musicbrainz-album",
        deadlineMs,
    );
}

async function tryRecording(
    input: ExternalTrackAlbumInput,
    deadlineMs: number,
): Promise<ExternalTrackAlbumResolution | null> {
    try {
        const recording = await callWithinBudget(
            () =>
                musicBrainzService.searchRecording(
                    input.trackTitle,
                    input.artistName,
                ),
            deadlineMs,
        );
        if (!recording?.albumMbid || !recording.albumName) return null;
        return {
            albumTitle: recording.albumName,
            rgMbid: recording.albumMbid,
            artistName: input.artistName,
            source: "musicbrainz-recording",
        };
    } catch (error) {
        if (error instanceof BudgetExpiredError) throw error;
        log.debug("Recording lookup failed", error);
        return null;
    }
}

async function tryLastFm(
    input: ExternalTrackAlbumInput,
    deadlineMs: number,
): Promise<ExternalTrackAlbumResolution | null> {
    try {
        const track = await callWithinBudget(
            () =>
                lastFmService.getTrackInfo(input.artistName, input.trackTitle),
            deadlineMs,
        );
        const title = track?.album?.title;
        if (typeof title !== "string" || isGenericAlbumTitle(title))
            return null;
        return searchAlbumTitle(title, input, "lastfm", deadlineMs);
    } catch (error) {
        if (error instanceof BudgetExpiredError) throw error;
        log.debug("Last.fm track lookup failed", error);
        return null;
    }
}

async function tryDeezer(
    input: ExternalTrackAlbumInput,
    deadlineMs: number,
): Promise<ExternalTrackAlbumResolution | null> {
    try {
        const trackAlbum = await callWithinBudget(
            () =>
                deezerService.getTrackAlbum(input.artistName, input.trackTitle),
            deadlineMs,
        );
        const title = trackAlbum?.albumName;
        if (typeof title !== "string" || isGenericAlbumTitle(title))
            return null;
        return searchAlbumTitle(title, input, "deezer", deadlineMs);
    } catch (error) {
        if (error instanceof BudgetExpiredError) throw error;
        log.debug("Deezer track lookup failed", error);
        return null;
    }
}

async function runResolutionLadder(
    input: ExternalTrackAlbumInput,
    deadlineMs: number,
): Promise<ExternalTrackAlbumResolution | null> {
    const supplied = await tryProvidedAlbum(input, deadlineMs);
    if (supplied) return supplied;
    const recording = await tryRecording(input, deadlineMs);
    if (recording) return recording;
    const lastFm = await tryLastFm(input, deadlineMs);
    if (lastFm) return lastFm;
    return tryDeezer(input, deadlineMs);
}

/** Resolve an external track to a MusicBrainz release-group album. */
export async function resolveAlbumForExternalTrack(
    input: ExternalTrackAlbumInput,
): Promise<ExternalTrackAlbumResolution | null> {
    const deadlineMs = Date.now() + OVERALL_BUDGET_MS;
    const cacheKey = buildCacheKey(input);
    const cached = await readCache(cacheKey, deadlineMs);
    if (cached.found) return cached.value;

    try {
        const result = await runResolutionLadder(input, deadlineMs);
        await writeCache(cacheKey, result, deadlineMs);
        return result;
    } catch (error) {
        if (error instanceof BudgetExpiredError) {
            log.debug("Track album resolution budget expired");
            return null;
        }
        throw error;
    }
}
