/**
 * Enrichment Failure Service
 *
 * Tracks and manages failures during artist/track/audio enrichment.
 * Provides visibility into what failed and allows selective retry.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

const DEFAULT_RECONCILIATION_BATCH_SIZE = 500;

export interface EnrichmentFailure {
    id: string;
    entityType: "artist" | "track" | "audio" | "vibe";
    entityId: string;
    entityName: string | null;
    errorMessage: string | null;
    errorCode: string | null;
    retryCount: number;
    maxRetries: number;
    firstFailedAt: Date;
    lastFailedAt: Date;
    skipped: boolean;
    skippedAt: Date | null;
    resolved: boolean;
    resolvedAt: Date | null;
    metadata: any;
}

export interface RecordFailureInput {
    entityType: "artist" | "track" | "audio" | "vibe";
    entityId: string;
    entityName?: string;
    errorMessage: string;
    errorCode?: string;
    metadata?: any;
}

export interface GetFailuresOptions {
    entityType?: "artist" | "track" | "audio" | "vibe";
    includeSkipped?: boolean;
    includeResolved?: boolean;
    limit?: number;
    offset?: number;
}

type FailureReference = Pick<
    EnrichmentFailure,
    "id" | "entityType" | "entityId"
>;

/** Counts returned after comparing unresolved failures with live entity state. */
export interface ReconciliationResult {
    resolved: number;
    checked: number;
}

function chunkValues<T>(values: T[], batchSize: number): T[][] {
    const chunks: T[][] = [];
    for (let offset = 0; offset < values.length; offset += batchSize) {
        chunks.push(values.slice(offset, offset + batchSize));
    }
    return chunks;
}

function failuresOfType(
    failures: FailureReference[],
    entityType: EnrichmentFailure["entityType"],
): FailureReference[] {
    return failures.filter((failure) => failure.entityType === entityType);
}

async function findVibeFailuresToResolve(
    failures: FailureReference[],
    batchSize: number,
): Promise<string[]> {
    const liveFailures = new Set<string>();
    for (const batch of chunkValues(failures, batchSize)) {
        const tracks = await prisma.track.findMany({
            where: { id: { in: batch.map((failure) => failure.entityId) } },
            select: { id: true, vibeAnalysisStatus: true, removedAt: true },
        });
        for (const track of tracks) {
            // Soft-removed tracks are non-enrichable, so their rows resolve.
            if (
                track.removedAt === null &&
                track.vibeAnalysisStatus === "failed"
            ) {
                liveFailures.add(track.id);
            }
        }
    }
    return failures
        .filter((failure) => !liveFailures.has(failure.entityId))
        .map((failure) => failure.id);
}

async function findAudioFailuresToResolve(
    failures: FailureReference[],
    batchSize: number,
): Promise<string[]> {
    const liveFailures = new Set<string>();
    for (const batch of chunkValues(failures, batchSize)) {
        const tracks = await prisma.track.findMany({
            where: { id: { in: batch.map((failure) => failure.entityId) } },
            select: { id: true, analysisStatus: true, removedAt: true },
        });
        for (const track of tracks) {
            // Soft-removed tracks are non-enrichable, so their rows resolve.
            if (track.removedAt === null && track.analysisStatus === "failed") {
                liveFailures.add(track.id);
            }
        }
    }
    return failures
        .filter((failure) => !liveFailures.has(failure.entityId))
        .map((failure) => failure.id);
}

async function findTrackFailuresToResolve(
    failures: FailureReference[],
    batchSize: number,
): Promise<string[]> {
    const unfinishedIds = new Set<string>();
    for (const batch of chunkValues(failures, batchSize)) {
        const tracks = await prisma.track.findMany({
            where: { id: { in: batch.map((failure) => failure.entityId) } },
            select: { id: true, lastfmTags: true, removedAt: true },
        });
        for (const track of tracks) {
            // Soft-removed tracks are non-enrichable, so their rows resolve.
            if (
                track.removedAt === null &&
                (!Array.isArray(track.lastfmTags) ||
                    track.lastfmTags.length === 0)
            ) {
                unfinishedIds.add(track.id);
            }
        }
    }
    return failures
        .filter((failure) => !unfinishedIds.has(failure.entityId))
        .map((failure) => failure.id);
}

async function findArtistFailuresToResolve(
    failures: FailureReference[],
    batchSize: number,
): Promise<string[]> {
    const reconcilableFailures = failures.filter(
        (failure) => failure.entityId !== "system",
    );
    const unfinishedIds = new Set<string>();
    for (const batch of chunkValues(reconcilableFailures, batchSize)) {
        const artists = await prisma.artist.findMany({
            where: { id: { in: batch.map((failure) => failure.entityId) } },
            select: { id: true, enrichmentStatus: true },
        });
        for (const artist of artists) {
            if (artist.enrichmentStatus !== "completed") {
                unfinishedIds.add(artist.id);
            }
        }
    }
    return reconcilableFailures
        .filter((failure) => !unfinishedIds.has(failure.entityId))
        .map((failure) => failure.id);
}

async function findReconciliationPage(
    batchSize: number,
    startedAt: Date,
    cursor?: string,
): Promise<FailureReference[]> {
    const failures = await prisma.enrichmentFailure.findMany({
        where: {
            resolved: false,
            skipped: false,
            // Fence the scan to the snapshot moment so sustained failure
            // recording cannot keep feeding pages and stall the pass.
            lastFailedAt: { lt: startedAt },
        },
        select: { id: true, entityType: true, entityId: true },
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return failures as FailureReference[];
}

async function findFailureIdsToResolve(
    failures: FailureReference[],
    batchSize: number,
): Promise<string[]> {
    const resolutionGroups = await Promise.all([
        findVibeFailuresToResolve(failuresOfType(failures, "vibe"), batchSize),
        findAudioFailuresToResolve(
            failuresOfType(failures, "audio"),
            batchSize,
        ),
        findTrackFailuresToResolve(
            failuresOfType(failures, "track"),
            batchSize,
        ),
        findArtistFailuresToResolve(
            failuresOfType(failures, "artist"),
            batchSize,
        ),
    ]);
    return resolutionGroups.flat();
}

async function resolveFailureIds(
    ids: string[],
    batchSize: number,
    startedAt: Date,
): Promise<number> {
    let resolved = 0;
    for (const batch of chunkValues(ids, batchSize)) {
        const result = await prisma.enrichmentFailure.updateMany({
            where: {
                id: { in: batch },
                resolved: false,
                skipped: false,
                // Same-millisecond failures are kept for the next pass.
                lastFailedAt: { lt: startedAt },
            },
            data: { resolved: true, resolvedAt: new Date() },
        });
        resolved += result.count;
    }
    return resolved;
}

class EnrichmentFailureService {
    private reconciliationInFlight: Promise<ReconciliationResult> | null = null;
    /**
     * Record a failure (or increment retry count if already exists)
     */
    async recordFailure(input: RecordFailureInput): Promise<EnrichmentFailure> {
        const {
            entityType,
            entityId,
            entityName,
            errorMessage,
            errorCode,
            metadata,
        } = input;

        // Try to find existing failure
        const existing = await prisma.enrichmentFailure.findUnique({
            where: {
                entityType_entityId: {
                    entityType,
                    entityId,
                },
            },
        });

        if (existing) {
            // Update existing failure - cap retry count at maxRetries to prevent unbounded increment
            const newRetryCount = Math.min(
                existing.retryCount + 1,
                existing.maxRetries,
            );

            return (await prisma.enrichmentFailure.update({
                where: { id: existing.id },
                data: {
                    errorMessage,
                    errorCode,
                    retryCount: newRetryCount,
                    lastFailedAt: new Date(),
                    resolved: false,
                    resolvedAt: null,
                    metadata: metadata
                        ? JSON.parse(JSON.stringify(metadata))
                        : existing.metadata,
                },
            })) as EnrichmentFailure;
        } else {
            // Create new failure
            return (await prisma.enrichmentFailure.create({
                data: {
                    entityType,
                    entityId,
                    entityName,
                    errorMessage,
                    errorCode,
                    retryCount: 1,
                    maxRetries: 3,
                    metadata: metadata
                        ? JSON.parse(JSON.stringify(metadata))
                        : null,
                },
            })) as EnrichmentFailure;
        }
    }

    /**
     * Get failures with filtering and pagination
     */
    async getFailures(options: GetFailuresOptions = {}): Promise<{
        failures: EnrichmentFailure[];
        total: number;
    }> {
        const {
            entityType,
            includeSkipped = false,
            includeResolved = false,
            limit = 100,
            offset = 0,
        } = options;

        const where: any = {};

        if (entityType) {
            where.entityType = entityType;
        }

        if (!includeSkipped) {
            where.skipped = false;
        }

        if (!includeResolved) {
            where.resolved = false;
        }

        const [failures, total] = await Promise.all([
            prisma.enrichmentFailure.findMany({
                where,
                orderBy: { lastFailedAt: "desc" },
                take: limit,
                skip: offset,
            }),
            prisma.enrichmentFailure.count({ where }),
        ]);

        return { failures: failures as unknown as EnrichmentFailure[], total };
    }

    /**
     * Get failure counts by type
     */
    async getFailureCounts(): Promise<{
        artist: number;
        track: number;
        audio: number;
        vibe: number;
        total: number;
    }> {
        const [artistCount, trackCount, audioCount, vibeCount] =
            await Promise.all([
                prisma.enrichmentFailure.count({
                    where: {
                        entityType: "artist",
                        resolved: false,
                        skipped: false,
                    },
                }),
                prisma.enrichmentFailure.count({
                    where: {
                        entityType: "track",
                        resolved: false,
                        skipped: false,
                    },
                }),
                prisma.enrichmentFailure.count({
                    where: {
                        entityType: "audio",
                        resolved: false,
                        skipped: false,
                    },
                }),
                prisma.enrichmentFailure.count({
                    where: {
                        entityType: "vibe",
                        resolved: false,
                        skipped: false,
                    },
                }),
            ]);

        return {
            artist: artistCount,
            track: trackCount,
            audio: audioCount,
            vibe: vibeCount,
            total: artistCount + trackCount + audioCount + vibeCount,
        };
    }

    /**
     * Get a single failure by ID
     */
    async getFailure(id: string): Promise<EnrichmentFailure | null> {
        return (await prisma.enrichmentFailure.findUnique({
            where: { id },
        })) as unknown as EnrichmentFailure | null;
    }

    /**
     * Mark failures as skipped (won't be retried automatically)
     */
    async skipFailures(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.updateMany({
            where: { id: { in: ids } },
            data: {
                skipped: true,
                skippedAt: new Date(),
            },
        });

        return result.count;
    }

    /**
     * Mark failures as resolved (manually fixed)
     */
    async resolveFailures(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.updateMany({
            where: { id: { in: ids } },
            data: {
                resolved: true,
                resolvedAt: new Date(),
            },
        });

        return result.count;
    }

    /**
     * Reset retry count for failures (prepare for retry)
     */
    async resetRetryCount(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.updateMany({
            where: { id: { in: ids } },
            data: {
                retryCount: 0,
            },
        });

        return result.count;
    }

    /**
     * Delete failures (cleanup resolved/old failures)
     */
    async deleteFailures(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.deleteMany({
            where: { id: { in: ids } },
        });

        return result.count;
    }

    /**
     * Clear all unresolved failures (optionally filtered by type)
     */
    async clearAllFailures(
        entityType?: "artist" | "track" | "audio" | "vibe",
    ): Promise<number> {
        const where: any = {
            resolved: false,
            skipped: false,
        };

        if (entityType) {
            where.entityType = entityType;
        }

        const result = await prisma.enrichmentFailure.deleteMany({ where });

        logger.info(
            `Cleared ${result.count} enrichment failures${entityType ? ` of type ${entityType}` : ""}`,
        );

        return result.count;
    }

    /**
     * Cleanup old resolved failures (older than specified days)
     */
    async cleanupOldResolved(olderThanDays: number = 30): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

        const result = await prisma.enrichmentFailure.deleteMany({
            where: {
                resolved: true,
                resolvedAt: {
                    lt: cutoffDate,
                },
            },
        });

        logger.debug(
            `[Enrichment Failures] Cleaned up ${result.count} old resolved failures`,
        );
        return result.count;
    }

    /**
     * Check if an entity has failed too many times
     */
    async hasExceededRetries(
        entityType: string,
        entityId: string,
    ): Promise<boolean> {
        const failure = await prisma.enrichmentFailure.findUnique({
            where: {
                entityType_entityId: {
                    entityType: entityType as any,
                    entityId,
                },
            },
        });

        if (!failure) return false;
        return failure.retryCount >= failure.maxRetries;
    }

    /**
     * Clear failure record (reset for fresh retry)
     */
    async clearFailure(entityType: string, entityId: string): Promise<void> {
        await prisma.enrichmentFailure.deleteMany({
            where: {
                entityType: entityType as any,
                entityId,
            },
        });
    }

    private async reconcileOnce(
        batchSize: number,
    ): Promise<ReconciliationResult> {
        const startedAt = new Date();
        let failures = await findReconciliationPage(batchSize, startedAt);
        let checked = 0;
        let resolved = 0;
        while (failures.length > 0) {
            checked += failures.length;
            const cursor = failures[failures.length - 1]?.id;
            if (!cursor) throw new Error("Reconciliation page lacks a cursor");
            const nextPage =
                failures.length === batchSize
                    ? await findReconciliationPage(batchSize, startedAt, cursor)
                    : [];
            const ids = await findFailureIdsToResolve(failures, batchSize);
            resolved += await resolveFailureIds(ids, batchSize, startedAt);
            failures = nextPage;
        }
        logger.debug(
            `Reconciled ${resolved} of ${checked} unresolved enrichment failures`,
        );
        return { resolved, checked };
    }

    /** Resolve stale failure rows against the authoritative live entity state. */
    async reconcileWithLiveState(
        requestedBatchSize: number = DEFAULT_RECONCILIATION_BATCH_SIZE,
    ): Promise<ReconciliationResult> {
        if (this.reconciliationInFlight) return this.reconciliationInFlight;
        const batchSize = Math.max(
            1,
            Math.min(DEFAULT_RECONCILIATION_BATCH_SIZE, requestedBatchSize),
        );
        const operation = this.reconcileOnce(batchSize);
        this.reconciliationInFlight = operation;
        try {
            return await operation;
        } finally {
            if (this.reconciliationInFlight === operation) {
                this.reconciliationInFlight = null;
            }
        }
    }

    /**
     * Resolve failure records for an entity (track/artist) that succeeded.
     * Used when a track's vibe embedding succeeds after previous failures.
     */
    async resolveByEntity(
        entityType: "vibe" | "audio",
        entityId: string,
    ): Promise<boolean> {
        const result = await prisma.enrichmentFailure.updateMany({
            where: {
                entityType,
                entityId,
                resolved: false,
            },
            data: {
                resolved: true,
                resolvedAt: new Date(),
            },
        });

        if (result.count > 0) {
            logger.debug(
                `[Enrichment Failures] Resolved ${result.count} failures for ${entityType}:${entityId}`,
            );
        }

        return result.count > 0;
    }
}

// Singleton instance
export const enrichmentFailureService = new EnrichmentFailureService();
