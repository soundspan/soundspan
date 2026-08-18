import { existsSync } from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { config } from "../config";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";
import { TRACK_BROWSE_SQL } from "../utils/libraryRadioPredicates";
import { getActiveSpace } from "./embeddingSpaces";

const MIN_TRACKS_FOR_UMAP = 5;
const MAX_EMBEDDINGS = 15000;
// Space-scoped keys: a cutover to a new embedding space starts writing to
// fresh keys instead of serving the retired space's projection for a day.
const CACHE_KEY_PREFIX = "vibe:map:v5:projection";
const TRACK_IDS_KEY_PREFIX = "vibe:map:v5:track_ids";
const CACHE_TTL_SECONDS = 86400;
const EMPTY_CACHE_TTL_SECONDS = 300;
const UMAP_TIMEOUT_MS = 15 * 60 * 1000;
const UMAP_WARN_MS = 5 * 60 * 1000;
// When the worker dies on its heap ceiling, retry with a smaller sample
// before giving up: full size, then half, then a quarter.
const OOM_RETRY_DIVISORS = [1, 2, 4] as const;
const MIN_OOM_SAMPLE = 2000;

function cacheKeyForSpace(spaceId: string): string {
    return `${CACHE_KEY_PREFIX}:${spaceId}`;
}

function trackIdsKeyForSpace(spaceId: string): string {
    return `${TRACK_IDS_KEY_PREFIX}:${spaceId}`;
}

export interface VibeMapTrack {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    albumLoudnessLufs?: number | null;
    albumTruePeakDb?: number | null;
    dominantMood: string;
    moodScore: number;
    moods: Record<string, number>;
    energy: number | null;
    valence: number | null;
}

export interface VibeMapResponse {
    tracks: VibeMapTrack[];
    trackCount: number;
    sampled?: boolean;
    computedAt: string;
}

type TrackRow = {
    track_id: string;
    title: string;
    artistName: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    loudnessLufs: number | null;
    truePeakDb: number | null;
    albumLoudnessLufs: number | null;
    albumTruePeakDb: number | null;
    energy: number | null;
    valence: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
};

const MOOD_FIELDS = [
    "moodHappy",
    "moodSad",
    "moodRelaxed",
    "moodAggressive",
    "moodParty",
    "moodAcoustic",
    "moodElectronic",
] as const;

let computePromise: Promise<VibeMapResponse> | null = null;

/** Worker data plus the optional development loader registration. */
export interface UmapWorkerOptions {
    workerData: { embeddings: number[][]; nNeighbors: number };
    execArgv?: string[];
}

/** Build worker options, registering tsx only for an uncompiled TypeScript worker. */
export function umapWorkerOptions(
    workerPath: string,
    embeddings: number[][],
    nNeighbors: number,
): UmapWorkerOptions {
    const workerData = { embeddings, nNeighbors };
    return workerPath.endsWith(".ts")
        ? { workerData, execArgv: ["--import", "tsx"] }
        : { workerData };
}

function resolveUmapWorkerPath(): string {
    const candidatePaths = [
        path.join(__dirname, "../workers/umapWorker.js"),
        path.join(__dirname, "../workers/umapWorker.ts"),
    ];

    return (
        candidatePaths.find((candidatePath) => existsSync(candidatePath)) ??
        candidatePaths[0]
    );
}

function getDominantMood(track: Record<string, unknown>): {
    mood: string;
    score: number;
} {
    let best = { mood: "neutral", score: 0 };

    for (const field of MOOD_FIELDS) {
        const value = track[field] as number | null | undefined;
        if (value != null && value > best.score) {
            best = { mood: field, score: value };
        }
    }

    return best;
}

function getMoodScores(track: Record<string, unknown>): Record<string, number> {
    const moods: Record<string, number> = {};

    for (const field of MOOD_FIELDS) {
        const value = track[field] as number | null | undefined;
        if (value != null) {
            moods[field] = value;
        }
    }

    return moods;
}

async function cacheResult(
    spaceId: string,
    result: VibeMapResponse,
    trackIds: string[],
    ttlSeconds: number = CACHE_TTL_SECONDS,
): Promise<void> {
    try {
        const cacheKey = cacheKeyForSpace(spaceId);
        const trackIdsKey = trackIdsKeyForSpace(spaceId);
        const pipeline = redisClient.multi();
        pipeline.setEx(cacheKey, ttlSeconds, JSON.stringify(result));
        pipeline.del(trackIdsKey);
        if (trackIds.length > 0) {
            pipeline.sAdd(trackIdsKey, trackIds);
            pipeline.expire(trackIdsKey, CACHE_TTL_SECONDS);
        }
        await pipeline.exec();
    } catch (error) {
        logger.warn(
            "[VIBE-MAP] Failed to cache projection:",
            error instanceof Error ? error.message : String(error),
        );
    }
}

function buildMapTrack(row: TrackRow, x: number, y: number): VibeMapTrack {
    const dominant = getDominantMood(row as Record<string, unknown>);

    return {
        id: row.track_id,
        x,
        y,
        title: row.title,
        artist: row.artistName,
        artistId: row.artistId,
        albumId: row.albumId,
        coverUrl: row.coverUrl,
        loudnessLufs: row.loudnessLufs,
        truePeakDb: row.truePeakDb,
        albumLoudnessLufs: row.albumLoudnessLufs,
        albumTruePeakDb: row.albumTruePeakDb,
        dominantMood: dominant.mood,
        moodScore: dominant.score,
        moods: getMoodScores(row as Record<string, unknown>),
        energy: row.energy,
        valence: row.valence,
    };
}

async function buildCircularLayout(
    spaceId: string,
    rows: Array<TrackRow & { embedding: string }>,
): Promise<VibeMapResponse> {
    const result: VibeMapResponse = {
        tracks: rows.map((row, index) => {
            const angle = (2 * Math.PI * index) / rows.length;
            return buildMapTrack(
                row,
                0.5 + 0.3 * Math.cos(angle),
                0.5 + 0.3 * Math.sin(angle),
            );
        }),
        trackCount: rows.length,
        computedAt: new Date().toISOString(),
    };

    await cacheResult(
        spaceId,
        result,
        rows.map((row) => row.track_id),
    );

    return result;
}

function monitorUmapWorker(
    worker: Worker,
    trackCount: number,
    resolve: (value: number[][]) => void,
    reject: (reason: Error) => void,
): void {
    let settled = false;
    const warnTimer = setTimeout(
        () =>
            logger.warn(
                `[VIBE-MAP] UMAP worker running for 5+ minutes (${trackCount} tracks)`,
            ),
        UMAP_WARN_MS,
    );
    const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(warnTimer);
        void worker.terminate();
        reject(
            new Error(
                `UMAP worker timed out after ${UMAP_TIMEOUT_MS / 60000} minutes`,
            ),
        );
    }, UMAP_TIMEOUT_MS);
    const clearTimers = () => {
        clearTimeout(warnTimer);
        clearTimeout(timeoutTimer);
    };
    worker.on("message", (result) => {
        if (settled) return;
        settled = true;
        clearTimers();
        const payload = result as { error?: string } | number[][];
        if (!Array.isArray(payload) && payload?.error)
            reject(new Error(payload.error));
        else resolve(payload as number[][]);
    });
    worker.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
    });
    worker.on("exit", (code) => {
        if (settled || code === 0) return;
        settled = true;
        clearTimers();
        reject(new Error(`UMAP worker exited with code ${code}`));
    });
}

function runUmapInWorker(
    embeddings: number[][],
    nNeighbors: number,
): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        const workerPath = resolveUmapWorkerPath();
        const options = umapWorkerOptions(workerPath, embeddings, nNeighbors);
        const worker = new Worker(workerPath, {
            ...options,
            resourceLimits: {
                maxOldGenerationSizeMb: config.vibeMapWorkerMemoryMb,
            },
        });
        monitorUmapWorker(worker, embeddings.length, resolve, reject);
    });
}

function isWorkerOutOfMemory(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as NodeJS.ErrnoException).code;
    return (
        code === "ERR_WORKER_OUT_OF_MEMORY" ||
        error.message.includes("memory limit")
    );
}

/**
 * Run UMAP over the rows, halving the sample on worker out-of-memory so a
 * memory-constrained deployment degrades to a sparser map instead of failing.
 */
async function projectWithOomDegradation(
    rows: Array<TrackRow & { embedding: string }>,
): Promise<{
    projectedRows: Array<TrackRow & { embedding: string }>;
    projection: number[][];
}> {
    let lastError: unknown = null;
    for (const divisor of OOM_RETRY_DIVISORS) {
        const sampleSize = Math.max(
            MIN_OOM_SAMPLE,
            Math.floor(rows.length / divisor),
        );
        const sample = rows.slice(0, Math.min(sampleSize, rows.length));
        const embeddings = sample.map((row) => parseEmbedding(row.embedding));
        const nNeighbors = Math.min(
            15,
            Math.max(2, Math.floor(sample.length / 2)),
        );
        try {
            const projection = await runUmapInWorker(embeddings, nNeighbors);
            return { projectedRows: sample, projection };
        } catch (error) {
            lastError = error;
            if (
                !isWorkerOutOfMemory(error) ||
                sample.length <= MIN_OOM_SAMPLE
            ) {
                throw error;
            }
            logger.warn(
                `[VIBE-MAP] UMAP worker hit its ${config.vibeMapWorkerMemoryMb}MB heap ceiling at ${sample.length} tracks; retrying with a smaller sample`,
            );
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("UMAP projection failed");
}

async function doCompute(): Promise<VibeMapResponse> {
    const startedAt = Date.now();
    const activeSpace = await getActiveSpace();

    const rows = await prisma.$queryRaw<
        Array<TrackRow & { embedding: string }>
    >`
        SELECT
            te.track_id,
            t.title,
            ar.name as "artistName",
            ar.id as "artistId",
            a.id as "albumId",
            a."coverUrl",
            t."loudnessLufs",
            t."truePeakDb",
            a."albumLoudnessLufs",
            a."albumTruePeakDb",
            t.energy,
            t.valence,
            t."moodHappy",
            t."moodSad",
            t."moodRelaxed",
            t."moodAggressive",
            t."moodParty",
            t."moodAcoustic",
            t."moodElectronic",
            te.embedding::text as embedding
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.space_id = ${activeSpace.id}
        ORDER BY RANDOM()
        LIMIT ${MAX_EMBEDDINGS}
    `;

    if (rows.length === 0) {
        const empty: VibeMapResponse = {
            tracks: [],
            trackCount: 0,
            computedAt: new Date().toISOString(),
        };
        // Cache briefly so an empty library resolves to "no tracks" instead
        // of a building loop, while new embeds still appear quickly.
        await cacheResult(activeSpace.id, empty, [], EMPTY_CACHE_TTL_SECONDS);
        return empty;
    }

    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        return buildCircularLayout(activeSpace.id, rows);
    }

    const sampled = rows.length === MAX_EMBEDDINGS;
    logger.info(
        `[VIBE-MAP] Computing UMAP projection for ${rows.length} tracks${sampled ? " (sampled)" : ""}`,
    );

    const { projectedRows, projection } = await projectWithOomDegradation(rows);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const [x, y] of projection) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const tracks = projectedRows.map((row, index) =>
        buildMapTrack(
            row,
            (projection[index][0] - minX) / rangeX,
            (projection[index][1] - minY) / rangeY,
        ),
    );

    const result: VibeMapResponse = {
        tracks,
        trackCount: tracks.length,
        ...(sampled || projectedRows.length < rows.length
            ? { sampled: true }
            : {}),
        computedAt: new Date().toISOString(),
    };

    await cacheResult(
        activeSpace.id,
        result,
        projectedRows.map((row) => row.track_id),
    );

    logger.info(
        `[VIBE-MAP] UMAP projection computed in ${Date.now() - startedAt}ms for ${tracks.length} tracks`,
    );

    return result;
}

/** Either a served projection or a signal that the build is still running. */
export type VibeMapProjectionState =
    | { status: "ready"; data: VibeMapResponse }
    | { status: "building" };

/**
 * Serve the cached projection for the active space, or start a background
 * build and report "building" instead of holding the request open for a
 * computation that can outlive any client timeout.
 */
export async function computeMapProjection(): Promise<VibeMapProjectionState> {
    const activeSpace = await getActiveSpace();
    const cached = await redisClient.get(cacheKeyForSpace(activeSpace.id));
    if (cached) {
        logger.debug("[VIBE-MAP] Cache hit (space-scoped key)");
        return {
            status: "ready",
            data: JSON.parse(cached) as VibeMapResponse,
        };
    }

    if (!computePromise) {
        computePromise = doCompute()
            .catch((error) => {
                logger.error("Vibe map error:", error);
                throw error;
            })
            .finally(() => {
                computePromise = null;
            });
        // The request returns "building" immediately; surface compute
        // failures through the log line above, not an unhandled rejection.
        computePromise.catch(() => undefined);
    } else {
        logger.debug("[VIBE-MAP] Build already in progress");
    }

    return { status: "building" };
}
