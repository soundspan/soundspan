import axios from "axios";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { BRAND_USER_AGENT } from "../config/brand";

const LRCLIB_BASE_URL = "https://lrclib.net/api";
const LRCLIB_USER_AGENT = BRAND_USER_AGENT;
const EMBEDDED_LOOKUP_TIMEOUT_MS = 5000;
const LRCLIB_LOOKUP_TIMEOUT_MS = 12000;
// Lyrics are effectively immutable for our usage; cache aggressively.
const EXTERNAL_LYRICS_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60;
const EXTERNAL_LYRICS_MISS_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const LRCLIB_MAX_CONCURRENCY = 2;
const LRCLIB_MIN_REQUEST_INTERVAL_MS = 250;
const LRCLIB_BACKOFF_KEY = "lyrics:lrclib:backoff_until";
const LRCLIB_DEFAULT_429_BACKOFF_SECONDS = 120;
const LRCLIB_DEFAULT_5XX_BACKOFF_SECONDS = 30;
const LRCLIB_MAX_BACKOFF_SECONDS = 15 * 60;

let lrclibActiveRequests = 0;
let lrclibNextDispatchAt = 0;
let lrclibDispatchTimer: NodeJS.Timeout | null = null;
const lrclibWaitQueue: Array<() => void> = [];

interface LrclibResponse {
    id: number;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: number;
    instrumental: boolean;
    plainLyrics: string | null;
    syncedLyrics: string | null;
}

export interface LyricsResult {
    syncedLyrics: string | null;
    plainLyrics: string | null;
    source: string; // "lrclib", "embedded", "none"
    synced: boolean;
}

interface LyricsPayload {
    syncedLyrics: string | null;
    plainLyrics: string | null;
}

export interface LyricsLookupContext {
    artistName?: string;
    trackName?: string;
    albumName?: string;
    duration?: number;
}

function withTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    onTimeout: () => T
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(onTimeout());
        }, timeoutMs);

        fn()
            .then((value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(value);
            })
            .catch((error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            });
    });
}

async function cacheLyrics(
    trackId: string,
    source: "lrclib" | "embedded" | "none",
    payload: LyricsPayload
): Promise<void> {
    await prisma.trackLyrics.upsert({
        where: { trackId },
        update: {
            syncedLyrics: payload.syncedLyrics,
            plainLyrics: payload.plainLyrics,
            source,
        },
        create: {
            trackId,
            syncedLyrics: payload.syncedLyrics,
            plainLyrics: payload.plainLyrics,
            source,
        },
    });
}

function normalizeLyricsCachePart(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function buildExternalLyricsCacheKey(context: LyricsLookupContext): string {
    const artist = normalizeLyricsCachePart(context.artistName || "");
    const track = normalizeLyricsCachePart(context.trackName || "");
    const album = normalizeLyricsCachePart(context.albumName || "");
    const roundedDuration =
        typeof context.duration === "number" && context.duration > 0
            ? Math.round(context.duration)
            : 0;

    return `lyrics:external:${artist}:${track}:${album}:${roundedDuration}`;
}

function buildLrclibDurationCandidates(duration?: number): number[] {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
        return [];
    }

    const rounded = Math.max(1, Math.round(duration));
    return Array.from(
        new Set(
            [rounded, rounded - 1, rounded + 1, rounded - 2, rounded + 2].filter(
                (value) => value > 0
            )
        )
    );
}

function normalizeLrclibMatchValue(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function scoreLrclibCandidate(
    candidate: LrclibResponse,
    artistName: string,
    trackName: string,
    albumName?: string
): number {
    const candidateArtist = normalizeLrclibMatchValue(candidate.artistName || "");
    const candidateTrack = normalizeLrclibMatchValue(candidate.trackName || "");
    const candidateAlbum = normalizeLrclibMatchValue(candidate.albumName || "");
    const targetArtist = normalizeLrclibMatchValue(artistName);
    const targetTrack = normalizeLrclibMatchValue(trackName);
    const targetAlbum = normalizeLrclibMatchValue(albumName || "");

    let score = 0;

    if (candidateTrack === targetTrack) score += 6;
    else if (candidateTrack.includes(targetTrack) || targetTrack.includes(candidateTrack))
        score += 2;

    if (candidateArtist === targetArtist) score += 5;
    else if (
        candidateArtist.includes(targetArtist) ||
        targetArtist.includes(candidateArtist)
    )
        score += 2;

    if (targetAlbum) {
        if (candidateAlbum === targetAlbum) score += 3;
        else if (
            candidateAlbum &&
            (candidateAlbum.includes(targetAlbum) ||
                targetAlbum.includes(candidateAlbum))
        )
            score += 1;
    }

    if (candidate.syncedLyrics) score += 1;
    return score;
}

async function cacheExternalLyricsResult(
    cacheKey: string,
    result: LyricsResult
): Promise<void> {
    try {
        const ttlSeconds =
            result.source === "none"
                ? EXTERNAL_LYRICS_MISS_CACHE_TTL_SECONDS
                : EXTERNAL_LYRICS_CACHE_TTL_SECONDS;
        await redisClient.setEx(cacheKey, ttlSeconds, JSON.stringify(result));
    } catch (error) {
        logger.warn(`[Lyrics] Failed to cache external lyrics result: ${error}`);
    }
}

async function getExternalLyricsFromCache(
    cacheKey: string
): Promise<LyricsResult | null> {
    try {
        const cached = await redisClient.get(cacheKey);
        if (!cached) return null;

        const parsed = JSON.parse(cached) as LyricsResult;
        if (
            typeof parsed?.source === "string" &&
            typeof parsed?.synced === "boolean"
        ) {
            return {
                syncedLyrics: parsed.syncedLyrics ?? null,
                plainLyrics: parsed.plainLyrics ?? null,
                source: parsed.source,
                synced: parsed.synced,
            };
        }
    } catch (error) {
        logger.warn(`[Lyrics] Failed to read external lyrics cache: ${error}`);
    }
    return null;
}

function parseRetryAfterSeconds(value: unknown): number | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string" && typeof raw !== "number") {
        return null;
    }

    const asString = String(raw).trim();
    if (!asString) return null;

    const deltaSeconds = Number(asString);
    if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
        return Math.floor(deltaSeconds);
    }

    const retryDateMs = Date.parse(asString);
    if (Number.isNaN(retryDateMs)) {
        return null;
    }

    const remainingSeconds = Math.ceil((retryDateMs - Date.now()) / 1000);
    return remainingSeconds > 0 ? remainingSeconds : 0;
}

async function getLrclibBackoffUntilMs(): Promise<number> {
    try {
        const value = await redisClient.get(LRCLIB_BACKOFF_KEY);
        if (!value) return 0;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return 0;
        return parsed;
    } catch (error) {
        logger.warn(`[Lyrics] Failed to read LRCLIB backoff state: ${error}`);
        return 0;
    }
}

async function setLrclibBackoff(seconds: number, reason: string): Promise<void> {
    const clamped = Math.max(1, Math.min(LRCLIB_MAX_BACKOFF_SECONDS, Math.floor(seconds)));
    const backoffUntil = Date.now() + clamped * 1000;

    try {
        const existingUntil = await getLrclibBackoffUntilMs();
        // Do not shorten an existing backoff period.
        if (existingUntil >= backoffUntil) return;

        await redisClient.setEx(
            LRCLIB_BACKOFF_KEY,
            clamped,
            String(backoffUntil)
        );
        logger.warn(
            `[Lyrics] LRCLIB backoff enabled for ${clamped}s (${reason})`
        );
    } catch (error) {
        logger.warn(`[Lyrics] Failed to set LRCLIB backoff state: ${error}`);
    }
}

async function shouldSkipLrclibRequest(requestLabel: string): Promise<boolean> {
    const backoffUntil = await getLrclibBackoffUntilMs();
    if (backoffUntil <= Date.now()) return false;

    logger.debug(
        `[Lyrics] Skipping LRCLIB request during backoff for ${requestLabel}`
    );
    return true;
}

async function applyLrclibBackoffForError(
    error: any,
    requestLabel: string
): Promise<void> {
    const status = error?.response?.status;
    if (status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(
            error?.response?.headers?.["retry-after"]
        );
        await setLrclibBackoff(
            retryAfterSeconds ?? LRCLIB_DEFAULT_429_BACKOFF_SECONDS,
            `429 on ${requestLabel}`
        );
        return;
    }

    if (status >= 500 && status < 600) {
        await setLrclibBackoff(
            LRCLIB_DEFAULT_5XX_BACKOFF_SECONDS,
            `${status} on ${requestLabel}`
        );
    }
}

function scheduleLrclibDispatch(): void {
    if (lrclibDispatchTimer) return;

    const dispatch = () => {
        lrclibDispatchTimer = null;

        while (
            lrclibActiveRequests < LRCLIB_MAX_CONCURRENCY &&
            lrclibWaitQueue.length > 0
        ) {
            const now = Date.now();
            if (now < lrclibNextDispatchAt) {
                lrclibDispatchTimer = setTimeout(
                    dispatch,
                    lrclibNextDispatchAt - now
                );
                return;
            }

            const resolveNext = lrclibWaitQueue.shift();
            if (!resolveNext) return;

            lrclibActiveRequests += 1;
            lrclibNextDispatchAt = Date.now() + LRCLIB_MIN_REQUEST_INTERVAL_MS;
            resolveNext();
        }
    };

    dispatch();
}

async function acquireLrclibPermit(): Promise<() => void> {
    await new Promise<void>((resolve) => {
        lrclibWaitQueue.push(resolve);
        scheduleLrclibDispatch();
    });

    let released = false;
    return () => {
        if (released) return;
        released = true;
        lrclibActiveRequests = Math.max(0, lrclibActiveRequests - 1);
        scheduleLrclibDispatch();
    };
}

async function runLrclibRequest<T>(
    requestLabel: string,
    request: () => Promise<T>
): Promise<T | null> {
    if (await shouldSkipLrclibRequest(requestLabel)) {
        return null;
    }

    const release = await acquireLrclibPermit();
    try {
        return await request();
    } finally {
        release();
    }
}

async function resolveFromLrclib(
    artistName: string,
    trackName: string,
    duration?: number,
    albumName?: string
): Promise<LyricsPayload | null> {
    const durationCandidates = buildLrclibDurationCandidates(duration);
    if (durationCandidates.length > 0) {
        for (const candidateDuration of durationCandidates) {
            const result = await fetchFromLrclib(
                artistName,
                trackName,
                candidateDuration
            );

            if (result && (result.syncedLyrics || result.plainLyrics)) {
                return result;
            }
        }
    } else {
        logger.debug(
            `[Lyrics] Skipping LRCLIB lookup for "${trackName}" by "${artistName}" because duration is missing`
        );
    }

    const search = await searchFromLrclib(artistName, trackName, albumName);
    if (search && (search.syncedLyrics || search.plainLyrics)) {
        return search;
    }

    return null;
}

async function getExternalLyrics(
    context: LyricsLookupContext,
    logLabel: string
): Promise<LyricsResult> {
    const artistName = context.artistName?.trim();
    const trackName = context.trackName?.trim();

    if (!artistName || !trackName) {
        return { syncedLyrics: null, plainLyrics: null, source: "none", synced: false };
    }

    const cacheKey = buildExternalLyricsCacheKey(context);
    const cached = await getExternalLyricsFromCache(cacheKey);
    if (cached) {
        logger.debug(
            `[Lyrics] External cache hit for ${logLabel} (${artistName} - ${trackName})`
        );
        return cached;
    }

    const lrclib = await withTimeout(
        () =>
            resolveFromLrclib(
                artistName,
                trackName,
                context.duration,
                context.albumName
            ),
        LRCLIB_LOOKUP_TIMEOUT_MS,
        () => {
            logger.warn(
                `[Lyrics] LRCLIB lookup timed out for ${logLabel} (${artistName} - ${trackName}) after ${LRCLIB_LOOKUP_TIMEOUT_MS}ms`
            );
            return null;
        }
    );
    const result: LyricsResult = lrclib
        ? {
              syncedLyrics: lrclib.syncedLyrics,
              plainLyrics: lrclib.plainLyrics,
              source: "lrclib",
              synced: !!lrclib.syncedLyrics,
          }
        : {
              syncedLyrics: null,
              plainLyrics: null,
              source: "none",
              synced: false,
          };

    await cacheExternalLyricsResult(cacheKey, result);
    return result;
}

async function searchFromLrclib(
    artistName: string,
    trackName: string,
    albumName?: string
): Promise<LyricsPayload | null> {
    const requestLabel = `search "${trackName}" by "${artistName}"`;
    try {
        const response = await runLrclibRequest(requestLabel, () =>
            axios.get<LrclibResponse[]>(`${LRCLIB_BASE_URL}/search`, {
                params: {
                    artist_name: artistName,
                    track_name: trackName,
                    ...(albumName ? { album_name: albumName } : {}),
                },
                headers: {
                    "User-Agent": LRCLIB_USER_AGENT,
                },
                timeout: 10000,
            })
        );
        if (!response) return null;

        const candidates = Array.isArray(response.data) ? response.data : [];
        if (candidates.length === 0) {
            logger.debug(
                `[Lyrics] No LRCLIB search results for "${trackName}" by "${artistName}"`
            );
            return null;
        }

        const withLyrics = candidates.filter(
            (candidate) => candidate?.syncedLyrics || candidate?.plainLyrics
        );
        if (withLyrics.length === 0) {
            return null;
        }

        const best = withLyrics
            .map((candidate) => ({
                candidate,
                score: scoreLrclibCandidate(
                    candidate,
                    artistName,
                    trackName,
                    albumName
                ),
            }))
            .sort((a, b) => b.score - a.score)[0]?.candidate;

        if (!best) {
            return null;
        }

        return {
            syncedLyrics: best.syncedLyrics || null,
            plainLyrics: best.plainLyrics || null,
        };
    } catch (error: any) {
        await applyLrclibBackoffForError(error, requestLabel);
        if (error?.response?.status === 404) {
            logger.debug(
                `[Lyrics] No LRCLIB search match for "${trackName}" by "${artistName}"`
            );
            return null;
        }

        logger.warn(
            `[Lyrics] LRCLIB search failed for "${trackName}" by "${artistName}": ${error.message}`
        );
        return null;
    }
}

/**
 * Fetch lyrics from LRCLIB API.
 * LRCLIB is free and public; we still throttle and back off on upstream pressure.
 * Duration match is attempted within ±2 seconds.
 */
async function fetchFromLrclib(
    artistName: string,
    trackName: string,
    duration: number
): Promise<{ syncedLyrics: string | null; plainLyrics: string | null } | null> {
    const requestLabel = `get "${trackName}" by "${artistName}" (${duration}s)`;
    try {
        const response = await runLrclibRequest(requestLabel, () =>
            axios.get<LrclibResponse>(`${LRCLIB_BASE_URL}/get`, {
                params: {
                    artist_name: artistName,
                    track_name: trackName,
                    duration: duration,
                },
                headers: {
                    "User-Agent": LRCLIB_USER_AGENT,
                },
                timeout: 10000,
            })
        );
        if (!response) return null;

        if (response.data) {
            return {
                syncedLyrics: response.data.syncedLyrics || null,
                plainLyrics: response.data.plainLyrics || null,
            };
        }
        return null;
    } catch (error: any) {
        if (error?.response?.status === 404) {
            // No lyrics found — not an error
            logger.debug(
                `[Lyrics] No lyrics found on LRCLIB for "${trackName}" by "${artistName}"`
            );
            return null;
        }
        await applyLrclibBackoffForError(error, requestLabel);
        logger.warn(
            `[Lyrics] LRCLIB request failed for "${trackName}" by "${artistName}": ${error.message}`
        );
        return null;
    }
}

/**
 * Extract embedded lyrics from an audio file's metadata tags.
 * Supports USLT (ID3v2), LYRICS (Vorbis/FLAC), and similar tags.
 */
async function extractEmbeddedLyrics(
    filePath: string
): Promise<{ syncedLyrics: string | null; plainLyrics: string | null } | null> {
    try {
        const fs = await import("fs");
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const { parseFile } = await import("music-metadata");
        const metadata = await parseFile(filePath, {
            duration: false,
            skipCovers: true,
        });

        // music-metadata exposes lyrics in common.lyrics as ILyricsTag[]
        // Each entry has: .text (plain string), .syncText (ILyricsText[]), .timeStampFormat
        const lyricsTag = metadata.common.lyrics;
        if (lyricsTag && lyricsTag.length > 0) {
            const entry = lyricsTag[0];

            // Check for synchronized lyrics (SYLT) with timestamp data
            if (entry.syncText && entry.syncText.length > 0) {
                // Convert syncText entries to LRC format for consistent frontend rendering
                const lrcLines = entry.syncText
                    .filter((line) => line.text && line.text.trim())
                    .map((line) => {
                        const ms = line.timestamp || 0;
                        const mins = Math.floor(ms / 60000);
                        const secs = Math.floor((ms % 60000) / 1000);
                        const centis = Math.floor((ms % 1000) / 10);
                        return `[${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}] ${line.text}`;
                    });

                if (lrcLines.length > 0) {
                    return {
                        syncedLyrics: lrcLines.join("\n"),
                        plainLyrics: entry.syncText.map((l) => l.text).join("\n"),
                    };
                }
            }

            // Fall back to unsynchronized text (USLT / Vorbis LYRICS / MP4 ©lyr)
            const lyricsText = entry.text;
            if (lyricsText) {
                // Check if the text is already in LRC format
                const isLrc = /\[\d{2}:\d{2}[.:]\d{2,3}\]/.test(lyricsText);

                return {
                    syncedLyrics: isLrc ? lyricsText : null,
                    plainLyrics: isLrc ? null : lyricsText,
                };
            }
        }

        return null;
    } catch (error: any) {
        logger.warn(
            `[Lyrics] Failed to extract embedded lyrics from "${filePath}": ${error.message}`
        );
        return null;
    }
}

/**
 * Get lyrics for a track using waterfall strategy:
 * 1. Check DB cache
 * 2. Try embedded lyrics from file tags (local files only)
 * 3. Fetch from LRCLIB API
 * 4. Cache result in DB
 */
export async function getLyrics(
    trackId: string,
    lookupContext?: LyricsLookupContext
): Promise<LyricsResult> {
    const startedAt = Date.now();

    // 1. Check DB cache
    const cached = await prisma.trackLyrics.findUnique({
        where: { trackId },
    });

    if (cached) {
        logger.debug(
            `[Lyrics] Cache hit for track "${trackId}" (${Date.now() - startedAt}ms)`
        );
        return {
            syncedLyrics: cached.syncedLyrics,
            plainLyrics: cached.plainLyrics,
            source: cached.source,
            synced: !!cached.syncedLyrics,
        };
    }

    // 2. Fetch the track info for the lookup
    const track = await prisma.track.findUnique({
        where: { id: trackId },
        include: {
            album: {
                include: {
                    artist: true,
                },
            },
        },
    });

    if (!track) {
        const external = await getExternalLyrics(
            lookupContext || {},
            `track "${trackId}"`
        );
        logger.debug(
            `[Lyrics] External lookup for track "${trackId}" source=${external.source} (${Date.now() - startedAt}ms)`
        );
        return external;
    }

    const artistName = track.album.artist.name || lookupContext?.artistName || "";
    const trackName = track.displayTitle || track.title || lookupContext?.trackName || "";
    const albumName = track.album.title || lookupContext?.albumName;
    const trackDuration =
        typeof track.duration === "number" && track.duration > 0
            ? track.duration
            : lookupContext?.duration;

    // 3. Try embedded lyrics from file tags (local files only)
    if (track.filePath) {
        const embedded = await withTimeout(
            () => extractEmbeddedLyrics(track.filePath as string),
            EMBEDDED_LOOKUP_TIMEOUT_MS,
            () => {
                logger.warn(
                    `[Lyrics] Embedded lyrics lookup timed out for track "${trackId}" after ${EMBEDDED_LOOKUP_TIMEOUT_MS}ms`
                );
                return null;
            }
        );
        if (embedded && (embedded.syncedLyrics || embedded.plainLyrics)) {
            // Cache it
            await cacheLyrics(trackId, "embedded", embedded);

            logger.debug(
                `[Lyrics] Resolved from embedded tags for track "${trackId}" (${Date.now() - startedAt}ms)`
            );

            return {
                syncedLyrics: embedded.syncedLyrics,
                plainLyrics: embedded.plainLyrics,
                source: "embedded",
                synced: !!embedded.syncedLyrics,
            };
        }
    }

    // 4. Fetch from LRCLIB
    const lrclib = await withTimeout(
        () => resolveFromLrclib(artistName, trackName, trackDuration, albumName),
        LRCLIB_LOOKUP_TIMEOUT_MS,
        () => {
            logger.warn(
                `[Lyrics] LRCLIB lookup timed out for track "${trackId}" after ${LRCLIB_LOOKUP_TIMEOUT_MS}ms`
            );
            return null;
        }
    );
    if (lrclib && (lrclib.syncedLyrics || lrclib.plainLyrics)) {
        // Cache it
        await cacheLyrics(trackId, "lrclib", lrclib);

        logger.debug(
            `[Lyrics] Resolved from LRCLIB for track "${trackId}" (${Date.now() - startedAt}ms)`
        );

        return {
            syncedLyrics: lrclib.syncedLyrics,
            plainLyrics: lrclib.plainLyrics,
            source: "lrclib",
            synced: !!lrclib.syncedLyrics,
        };
    }

    // 5. No lyrics found — cache the miss to avoid repeated lookups
    await cacheLyrics(trackId, "none", {
        syncedLyrics: null,
        plainLyrics: null,
    });

    logger.debug(
        `[Lyrics] No lyrics found for track "${trackId}" (${Date.now() - startedAt}ms)`
    );

    return { syncedLyrics: null, plainLyrics: null, source: "none", synced: false };
}

/**
 * Clear cached lyrics for a track (e.g., after re-scanning).
 * Forces a fresh lookup on next request.
 */
export async function clearLyricsCache(trackId: string): Promise<void> {
    await prisma.trackLyrics.deleteMany({
        where: { trackId },
    });
}
