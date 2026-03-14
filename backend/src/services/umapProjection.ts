import path from "path";
import { Worker } from "worker_threads";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";

const MIN_TRACKS_FOR_UMAP = 5;
const MAX_EMBEDDINGS = 15000;
const CACHE_KEY = "vibe:map:v3:projection";
const TRACK_IDS_KEY = "vibe:map:v3:track_ids";
const CACHE_TTL_SECONDS = 86400;
const UMAP_TIMEOUT_MS = 15 * 60 * 1000;
const UMAP_WARN_MS = 5 * 60 * 1000;

export interface VibeMapTrack {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
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

function getDominantMood(
    track: Record<string, unknown>
): { mood: string; score: number } {
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
    result: VibeMapResponse,
    trackIds: string[]
): Promise<void> {
    try {
        const pipeline = redisClient.multi();
        pipeline.setEx(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(result));
        pipeline.del(TRACK_IDS_KEY);
        if (trackIds.length > 0) {
            pipeline.sAdd(TRACK_IDS_KEY, trackIds);
            pipeline.expire(TRACK_IDS_KEY, CACHE_TTL_SECONDS);
        }
        await pipeline.exec();
    } catch (error) {
        logger.warn(
            "[VIBE-MAP] Failed to cache projection:",
            error instanceof Error ? error.message : String(error)
        );
    }
}

function buildMapTrack(
    row: TrackRow,
    x: number,
    y: number
): VibeMapTrack {
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
        dominantMood: dominant.mood,
        moodScore: dominant.score,
        moods: getMoodScores(row as Record<string, unknown>),
        energy: row.energy,
        valence: row.valence,
    };
}

async function buildCircularLayout(rows: Array<TrackRow & { embedding: string }>): Promise<VibeMapResponse> {
    const result: VibeMapResponse = {
        tracks: rows.map((row, index) => {
            const angle = (2 * Math.PI * index) / rows.length;
            return buildMapTrack(
                row,
                0.5 + 0.3 * Math.cos(angle),
                0.5 + 0.3 * Math.sin(angle)
            );
        }),
        trackCount: rows.length,
        computedAt: new Date().toISOString(),
    };

    await cacheResult(
        result,
        rows.map((row) => row.track_id)
    );

    return result;
}

function runUmapInWorker(
    embeddings: number[][],
    nNeighbors: number
): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            path.join(__dirname, "../workers/umapWorker.js"),
            {
                workerData: { embeddings, nNeighbors },
            }
        );

        let settled = false;

        const warnTimer = setTimeout(() => {
            logger.warn(
                `[VIBE-MAP] UMAP worker running for 5+ minutes (${embeddings.length} tracks)`
            );
        }, UMAP_WARN_MS);

        const timeoutTimer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            worker.terminate();
            reject(
                new Error(
                    `UMAP worker timed out after ${UMAP_TIMEOUT_MS / 60000} minutes`
                )
            );
        }, UMAP_TIMEOUT_MS);

        worker.on("message", (result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            clearTimeout(timeoutTimer);

            const payload = result as { error?: string } | number[][];
            if (!Array.isArray(payload) && payload?.error) {
                reject(new Error(payload.error));
                return;
            }

            resolve(payload as number[][]);
        });

        worker.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            clearTimeout(timeoutTimer);
            reject(error);
        });

        worker.on("exit", (code) => {
            if (settled || code === 0) {
                return;
            }
            settled = true;
            clearTimeout(warnTimer);
            clearTimeout(timeoutTimer);
            reject(new Error(`UMAP worker exited with code ${code}`));
        });
    });
}

async function doCompute(): Promise<VibeMapResponse> {
    const startedAt = Date.now();

    const rows = await prisma.$queryRaw<Array<TrackRow & { embedding: string }>>`
        SELECT
            te.track_id,
            t.title,
            ar.name as "artistName",
            ar.id as "artistId",
            a.id as "albumId",
            a."coverUrl",
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
        ORDER BY RANDOM()
        LIMIT ${MAX_EMBEDDINGS}
    `;

    if (rows.length === 0) {
        return {
            tracks: [],
            trackCount: 0,
            computedAt: new Date().toISOString(),
        };
    }

    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        return buildCircularLayout(rows);
    }

    const sampled = rows.length === MAX_EMBEDDINGS;
    logger.info(
        `[VIBE-MAP] Computing UMAP projection for ${rows.length} tracks${sampled ? " (sampled)" : ""}`
    );

    const embeddings = rows.map((row) => parseEmbedding(row.embedding));
    const nNeighbors = Math.min(15, Math.max(2, Math.floor(rows.length / 2)));
    const projection = await runUmapInWorker(embeddings, nNeighbors);

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

    const tracks = rows.map((row, index) =>
        buildMapTrack(
            row,
            (projection[index][0] - minX) / rangeX,
            (projection[index][1] - minY) / rangeY
        )
    );

    const result: VibeMapResponse = {
        tracks,
        trackCount: tracks.length,
        ...(sampled ? { sampled: true } : {}),
        computedAt: new Date().toISOString(),
    };

    await cacheResult(
        result,
        rows.map((row) => row.track_id)
    );

    logger.info(
        `[VIBE-MAP] UMAP projection computed in ${Date.now() - startedAt}ms for ${tracks.length} tracks`
    );

    return result;
}

export async function computeMapProjection(): Promise<VibeMapResponse> {
    const cached = await redisClient.get(CACHE_KEY);
    if (cached) {
        logger.debug("[VIBE-MAP] Cache hit (stable key)");
        return JSON.parse(cached) as VibeMapResponse;
    }

    if (computePromise) {
        logger.info("[VIBE-MAP] Waiting for in-progress computation");
        return computePromise;
    }

    computePromise = doCompute();
    try {
        return await computePromise;
    } finally {
        computePromise = null;
    }
}
