import { logger } from "../../utils/logger";
import { isRealArtistMbid } from "../../utils/musicIds";
import { redisClient } from "../../utils/redis";
import { normalizeArtistName } from "../../utils/artistNormalization";
import { deezerService } from "../deezer";
import { fanartService } from "../fanart";
import { lastFmService } from "../lastfm";
import { wikidataService } from "../wikidata";

const log = logger.child("ArtistImageResolver");
const OVERALL_BUDGET_MS = 8_000;
const CACHE_OPERATION_BUDGET_MS = 250;
const POSITIVE_TTL_SECONDS = 7 * 24 * 60 * 60;
const NEGATIVE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = "metadata:artist-image:";
const LASTFM_PLACEHOLDER_HASH = "2a96cbd8b46e442fc41c2b86b821562f";
const MAX_IN_FLIGHT = 1_000;

/** Provider rung that produced an artist image. */
export type ArtistImageSource = "wikidata" | "fanart" | "deezer" | "lastfm";

/** Artist identity accepted by the canonical image resolver. */
export interface ArtistImageInput {
    artistName: string;
    mbid?: string | null;
}

/** Canonical artist image and the provider that supplied it. */
export interface ArtistImageResolution {
    url: string;
    source: ArtistImageSource;
}

type CacheLookup =
    | { found: false }
    | { found: true; value: ArtistImageResolution | null };

type RungResult =
    | { status: "resolved"; value: ArtistImageResolution }
    | { status: "miss"; transient: boolean };

type ArtistImageRung = Readonly<{
    source: ArtistImageSource;
    requiresMbid: boolean;
    fetch: (
        input: ArtistImageInput,
        mbid: string | null,
    ) => Promise<string | null>;
}>;

class BudgetExpiredError extends Error {}

function cacheKeyFor(artistName: string): string {
    return `${CACHE_PREFIX}${encodeURIComponent(normalizeArtistName(artistName))}`;
}

function isResolution(value: unknown): value is ArtistImageResolution {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.url === "string" &&
        candidate.url.length > 0 &&
        ["wikidata", "fanart", "deezer", "lastfm"].includes(
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
        // Provider adapters do not expose abort signals. This bounds caller
        // wait time, although timed-out provider work may settle afterward.
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
        log.debug("Artist image cache read failed", error);
        return { found: false };
    }
}

async function writeCache(
    key: string,
    value: ArtistImageResolution | null,
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
        log.debug("Artist image cache write failed", error);
    }
}

function selectLastFmImage(info: unknown): string | null {
    if (!info || typeof info !== "object") return null;
    const rawImages = (info as { image?: unknown }).image;
    const images = Array.isArray(rawImages)
        ? rawImages
        : rawImages
          ? [rawImages]
          : [];
    const sizes = ["extralarge", "mega", "large", "medium", "small"];
    for (let index = 0; index < sizes.length; index += 1) {
        const entry = images.find(
            (image) =>
                image &&
                typeof image === "object" &&
                (image as { size?: unknown }).size === sizes[index],
        ) as { "#text"?: unknown } | undefined;
        const url = entry?.["#text"];
        if (typeof url !== "string" || url.length === 0) continue;
        if (!url.includes(LASTFM_PLACEHOLDER_HASH)) return url;
    }
    return null;
}

const ARTIST_IMAGE_RUNGS: readonly ArtistImageRung[] = [
    {
        source: "wikidata",
        requiresMbid: true,
        fetch: async (input, mbid) => {
            if (!mbid) return null;
            const info = await wikidataService.getArtistInfo(
                input.artistName,
                mbid,
            );
            return info.heroUrl ?? null;
        },
    },
    {
        source: "fanart",
        requiresMbid: true,
        fetch: async (_input, mbid) => {
            if (!mbid) return null;
            return fanartService.getArtistImage(mbid, {
                preference: "square",
            });
        },
    },
    {
        source: "deezer",
        requiresMbid: false,
        fetch: (input) => deezerService.getArtistImage(input.artistName),
    },
    {
        source: "lastfm",
        requiresMbid: false,
        fetch: async (input) =>
            selectLastFmImage(
                await lastFmService.getArtistInfo(input.artistName),
            ),
    },
];

async function tryRung(
    rung: ArtistImageRung,
    input: ArtistImageInput,
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
        log.debug(`Artist image lookup failed at ${rung.source}`, error);
        return { status: "miss", transient: true };
    }
}

async function runLadder(
    input: ArtistImageInput,
    deadlineMs: number,
): Promise<RungResult> {
    const realMbid = isRealArtistMbid(input.mbid) ? input.mbid! : null;
    let transient = false;
    for (let index = 0; index < ARTIST_IMAGE_RUNGS.length; index += 1) {
        const rung = ARTIST_IMAGE_RUNGS[index];
        if (rung.requiresMbid && !realMbid) continue;
        const result = await tryRung(rung, input, realMbid, deadlineMs);
        if (result.status === "resolved") return result;
        transient ||= result.transient;
    }
    return { status: "miss", transient };
}

async function resolveWithoutDedupe(
    input: ArtistImageInput,
    cacheKey: string,
): Promise<ArtistImageResolution | null> {
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
            log.debug("Artist image resolution budget expired");
            return null;
        }
        throw error;
    }
}

const inFlight = new Map<string, Promise<ArtistImageResolution | null>>();

/** Resolve an artist image through the canonical bounded provider ladder. */
export async function resolveArtistImage(
    input: ArtistImageInput,
): Promise<ArtistImageResolution | null> {
    if (typeof input.artistName !== "string" || !input.artistName.trim()) {
        return null;
    }
    const cacheKey = cacheKeyFor(input.artistName);
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
