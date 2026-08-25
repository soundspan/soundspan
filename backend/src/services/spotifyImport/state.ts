import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import { createPlaylistLogger } from "../../utils/playlistLogger";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import {
    isRetryablePrismaError,
    withPrismaRetry,
} from "../../utils/prismaRetry";
import type { ImportJob } from "./types";

// Store loggers for each job
export const jobLoggers = new Map<
    string,
    ReturnType<typeof createPlaylistLogger>
>();
export const MATCHABLE_TRACK_WHERE = {
    removedAt: null,
    origin: "LOCAL",
} satisfies Prisma.TrackWhereInput;
const spotifyImportBasePrisma = prisma;
let spotifyImportRedis: typeof redisClient = redisClient;

export const isRetryableSpotifyImportPrismaError = isRetryablePrismaError;

export function createPrismaRetryProxy<T extends object>(
    client: T,
    namespace: string,
): T {
    return new Proxy(client, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);

            if (typeof value === "function" && typeof property === "string") {
                return (...args: unknown[]) =>
                    withPrismaRetry(`${namespace}.${property}`, () =>
                        value.apply(target, args),
                    );
            }

            if (
                value &&
                typeof value === "object" &&
                typeof property === "string"
            ) {
                return new Proxy(value as object, {
                    get(modelTarget, modelProperty, modelReceiver) {
                        const modelValue = Reflect.get(
                            modelTarget,
                            modelProperty,
                            modelReceiver,
                        );

                        if (
                            typeof modelValue === "function" &&
                            typeof modelProperty === "string"
                        ) {
                            return (...args: unknown[]) =>
                                withPrismaRetry(
                                    `${namespace}.${property}.${modelProperty}`,
                                    () => modelValue.apply(modelTarget, args),
                                );
                        }

                        return modelValue;
                    },
                });
            }

            return value;
        },
    }) as T;
}

export function isRetryableSpotifyImportRedisError(error: unknown): boolean {
    const message =
        error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Connection is closed") ||
        message.includes("Socket closed unexpectedly") ||
        message.includes("The client is closed")
    );
}

async function recreateSpotifyImportRedisClient(): Promise<void> {
    const nextClient = redisClient.duplicate();
    await nextClient.connect();
    spotifyImportRedis = nextClient;
}

async function withSpotifyImportRedisRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isRetryableSpotifyImportRedisError(error)) {
            throw error;
        }

        logger.warn(
            `[SpotifyImport/Redis] ${operationName} failed due to Redis connection closure; recreating client and retrying once`,
            error,
        );
        await recreateSpotifyImportRedisClient();
        return operation();
    }
}

export const spotifyImportPrisma = createPrismaRetryProxy(
    spotifyImportBasePrisma,
    "spotifyImport",
);

// Redis key pattern for import jobs
const IMPORT_JOB_KEY = (id: string) => `import:job:${id}`;
const IMPORT_JOB_TTL = 24 * 60 * 60; // 24 hours

/**
 * Save import job to both database and Redis cache for cross-process sharing
 */
export async function saveImportJob(job: ImportJob): Promise<void> {
    // Save to database for durability
    await spotifyImportPrisma.spotifyImportJob.upsert({
        where: { id: job.id },
        create: {
            id: job.id,
            userId: job.userId,
            spotifyPlaylistId: job.spotifyPlaylistId,
            playlistName: job.playlistName,
            status: job.status,
            progress: job.progress,
            albumsTotal: job.albumsTotal,
            albumsCompleted: job.albumsCompleted,
            tracksMatched: job.tracksMatched,
            tracksTotal: job.tracksTotal,
            tracksDownloadable: job.tracksDownloadable,
            createdPlaylistId: job.createdPlaylistId,
            error: job.error,
            pendingTracks: job.pendingTracks as any,
        },
        update: {
            status: job.status,
            progress: job.progress,
            albumsCompleted: job.albumsCompleted,
            tracksMatched: job.tracksMatched,
            createdPlaylistId: job.createdPlaylistId,
            error: job.error,
            updatedAt: new Date(),
        },
    });

    // Save to Redis for cross-process sharing
    try {
        await withSpotifyImportRedisRetry("saveImportJob.redis.setEx", () =>
            spotifyImportRedis.setEx(
                IMPORT_JOB_KEY(job.id),
                IMPORT_JOB_TTL,
                JSON.stringify(job),
            ),
        );
    } catch (error) {
        logger?.warn(
            `⚠️  Failed to cache import job ${job.id} in Redis:`,
            error,
        );
        // Continue - Redis is optional, DB is source of truth
    }
}

/**
 * Get import job from Redis cache or database
 * Redis provides cross-process sharing between API and worker processes
 */
export async function getImportJob(
    importJobId: string,
): Promise<ImportJob | null> {
    // Try Redis cache first (shared across all processes)
    try {
        const cached = await withSpotifyImportRedisRetry(
            "getImportJob.redis.get",
            () => spotifyImportRedis.get(IMPORT_JOB_KEY(importJobId)),
        );
        if (cached) {
            return JSON.parse(cached);
        }
    } catch (error) {
        logger?.warn(
            `⚠️  Failed to read import job ${importJobId} from Redis:`,
            error,
        );
        // Fall through to DB
    }

    // Load from database as fallback
    const dbJob = await spotifyImportPrisma.spotifyImportJob.findUnique({
        where: { id: importJobId },
    });

    if (!dbJob) return null;

    // Convert database job to ImportJob format
    const job: ImportJob = {
        id: dbJob.id,
        userId: dbJob.userId,
        spotifyPlaylistId: dbJob.spotifyPlaylistId,
        playlistName: dbJob.playlistName,
        status: dbJob.status as ImportJob["status"],
        progress: dbJob.progress,
        albumsTotal: dbJob.albumsTotal,
        albumsCompleted: dbJob.albumsCompleted,
        tracksMatched: dbJob.tracksMatched,
        tracksTotal: dbJob.tracksTotal,
        tracksDownloadable: dbJob.tracksDownloadable,
        createdPlaylistId: dbJob.createdPlaylistId,
        error: dbJob.error,
        createdAt: dbJob.createdAt,
        updatedAt: dbJob.updatedAt,
        pendingTracks: (dbJob.pendingTracks as any) || [],
    };

    // Populate Redis for next time
    try {
        await withSpotifyImportRedisRetry("getImportJob.redis.setEx", () =>
            spotifyImportRedis.setEx(
                IMPORT_JOB_KEY(importJobId),
                IMPORT_JOB_TTL,
                JSON.stringify(job),
            ),
        );
    } catch (error) {
        logger?.warn(
            `⚠️  Failed to cache import job ${importJobId} in Redis:`,
            error,
        );
        // Continue - Redis is optional
    }

    return job;
}
