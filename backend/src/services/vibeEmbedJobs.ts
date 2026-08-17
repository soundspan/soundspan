import { z } from "zod";
import { recordVibeEmbedJobOutcome } from "../metrics";
import type { VibeEmbedJobOutcome } from "../metrics/vibeEmbedMetrics";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "./enrichmentFailureService";
import { upsertTrackEmbedding } from "./trackEmbeddings";
import { embedAudio, VibeProviderError } from "./vibeProvider";
import type { EmbeddingVectorSpace } from "./vibeProvider";
import { vibeEmbeddingTargetGateWhere } from "./vibeEmbeddingEligibility";

const VIBE_QUEUE = "audio:clap:queue";
const MAX_ERROR_LENGTH = 500;
const INVALID_PAYLOAD_ERROR = "Invalid vibe embedding job payload";
export const MAX_VIBE_ANALYSIS_RETRIES = 3;
const jobLog =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("VibeEmbedJobs")
        : logger;
const trackIdSchema = z.string().min(1);

function isSyntacticallyContainedPath(filePath: string): boolean {
    if (filePath.includes("\0")) return false;
    const normalizedPath = filePath.replaceAll("\\", "/");
    return (
        !normalizedPath.startsWith("/") &&
        !/(?:^|\/)\.{1,2}(?:\/|$)/.test(normalizedPath)
    );
}

const vibeEmbedJobSchema = z.strictObject({
    trackId: trackIdSchema,
    filePath: z.string().min(1).refine(isSyntacticallyContainedPath),
    duration: z.number().finite().nonnegative().optional(),
});
const vibeEmbedTrackIdSchema = z.object({ trackId: trackIdSchema });

type VibeEmbedJob = z.infer<typeof vibeEmbedJobSchema>;
type TrackSnapshot = {
    id: string;
    title: string;
    vibeAnalysisRetryCount?: number;
    vibeAnalysisStatus?: string | null;
    vibeAnalysisGeneration?: number;
    embeddings?: Array<{ spaceId: string }>;
};
type ParsedVibeEmbedJob =
    | { kind: "valid"; job: VibeEmbedJob }
    | { kind: "invalid"; trackId: string | null };

interface VibeEmbedPrismaPort {
    track: {
        findFirst(args: unknown): Promise<TrackSnapshot | null>;
        updateMany(args: unknown): Promise<{ count: number }>;
        update(args: unknown): Promise<unknown>;
    };
}

interface FailureServicePort {
    recordFailure(input: {
        entityType: "vibe";
        entityId: string;
        entityName: string;
        errorMessage: string;
        errorCode: "VIBE_EMBEDDING_FAILED";
    }): Promise<unknown>;
    resolveByEntity(entityType: "vibe", entityId: string): Promise<boolean>;
}

interface VibeEmbedJobDependencies {
    targetSpaceId: string;
    targetSpaceDim: number;
    prisma: VibeEmbedPrismaPort;
    embedAudio(
        trackRef: string,
        targetSpace: EmbeddingVectorSpace,
    ): Promise<number[]>;
    upsertTrackEmbedding(
        trackId: string,
        embedding: readonly number[],
        spaceId: string,
    ): Promise<void>;
    failureService: FailureServicePort;
    releaseReservation(trackId: string): Promise<void>;
    recordOutcome(outcome: VibeEmbedJobOutcome): void;
    describeFailure(error: unknown): string;
    isTransientFailure(error: unknown): boolean;
    now(): Date;
}

/** Worker-resolved registry target carried through claim, validation, and write. */
export interface VibeEmbedJobTargetSpace extends EmbeddingVectorSpace {
    status: "active" | "migrating";
}

function parseJob(rawJob: string): ParsedVibeEmbedJob {
    try {
        const parsedJson: unknown = JSON.parse(rawJob);
        const parsedJob = vibeEmbedJobSchema.safeParse(parsedJson);
        if (parsedJob.success) return { kind: "valid", job: parsedJob.data };
        const parsedTrackId = vibeEmbedTrackIdSchema.safeParse(parsedJson);
        return {
            kind: "invalid",
            trackId: parsedTrackId.success ? parsedTrackId.data.trackId : null,
        };
    } catch {
        return { kind: "invalid", trackId: null };
    }
}

function activeTrackWhere(trackId: string) {
    return { id: trackId, origin: "LOCAL" as const, removedAt: null };
}

async function findActiveTrack(
    db: VibeEmbedPrismaPort,
    trackId: string,
): Promise<TrackSnapshot | null> {
    return db.track.findFirst({
        where: activeTrackWhere(trackId),
        select: {
            id: true,
            title: true,
            vibeAnalysisRetryCount: true,
            vibeAnalysisStatus: true,
            vibeAnalysisGeneration: true,
        },
    });
}

async function findTrackForInvalidPayload(
    dependencies: VibeEmbedJobDependencies,
    trackId: string,
): Promise<TrackSnapshot | null> {
    return dependencies.prisma.track.findFirst({
        where: activeTrackWhere(trackId),
        select: {
            id: true,
            title: true,
            vibeAnalysisStatus: true,
            vibeAnalysisGeneration: true,
            embeddings: {
                where: { spaceId: dependencies.targetSpaceId },
                select: { spaceId: true },
                take: 1,
            },
        },
    });
}

async function releaseReservation(
    dependencies: VibeEmbedJobDependencies,
    trackId: string,
): Promise<void> {
    try {
        await dependencies.releaseReservation(trackId);
    } catch (error) {
        jobLog.warn("Failed to release vibe queue reservation", {
            trackId,
            error,
        });
    }
}

async function claimTrack(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
): Promise<TrackSnapshot | null> {
    const timestamp = dependencies.now();
    const generation = track.vibeAnalysisGeneration ?? 0;
    const retryCount = track.vibeAnalysisRetryCount ?? 0;
    const freshSpaceAttempt =
        track.vibeAnalysisStatus === null ||
        track.vibeAnalysisStatus === "completed" ||
        retryCount >= MAX_VIBE_ANALYSIS_RETRIES;
    const result = await dependencies.prisma.track.updateMany({
        where: claimTrackWhere(dependencies, track.id, generation),
        data: {
            vibeAnalysisStatus: "processing",
            vibeAnalysisStartedAt: timestamp,
            vibeAnalysisStatusUpdatedAt: timestamp,
            ...(freshSpaceAttempt ? { vibeAnalysisRetryCount: 0 } : {}),
        },
    });
    await releaseReservation(dependencies, track.id);
    if (result.count !== 1) return null;
    return {
        ...track,
        vibeAnalysisGeneration: generation,
        vibeAnalysisRetryCount: freshSpaceAttempt ? 0 : retryCount,
    };
}

function claimTrackWhere(
    dependencies: VibeEmbedJobDependencies,
    trackId: string,
    generation: number,
) {
    return {
        ...activeTrackWhere(trackId),
        vibeAnalysisGeneration: generation,
        ...vibeEmbeddingTargetGateWhere(dependencies.targetSpaceId),
    };
}

function failureStatusWhere() {
    return [
        { vibeAnalysisStatus: null },
        { vibeAnalysisStatus: "pending" },
        { vibeAnalysisStatus: "processing" },
    ];
}

function failureMessage(
    dependencies: VibeEmbedJobDependencies,
    error: unknown,
): string {
    return dependencies.describeFailure(error).slice(0, MAX_ERROR_LENGTH);
}

async function markFailedWithMessage(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
    errorMessage: string,
): Promise<boolean> {
    // Invalid payloads may settle only unfinished rows without target vectors.
    const updated = await dependencies.prisma.track.updateMany({
        where: {
            ...activeTrackWhere(track.id),
            vibeAnalysisGeneration: track.vibeAnalysisGeneration ?? 0,
            OR: failureStatusWhere(),
            embeddings: { none: { spaceId: dependencies.targetSpaceId } },
        },
        data: {
            vibeAnalysisStatus: "failed",
            vibeAnalysisError: errorMessage,
            vibeAnalysisRetryCount: { increment: 1 },
            vibeAnalysisStatusUpdatedAt: dependencies.now(),
        },
    });
    if (updated.count === 0) {
        jobLog.debug("Skipped failure write for a settled track", {
            trackId: track.id,
        });
        return false;
    }
    await dependencies.failureService.recordFailure({
        entityType: "vibe",
        entityId: track.id,
        entityName: track.title,
        errorMessage,
        errorCode: "VIBE_EMBEDDING_FAILED",
    });
    return true;
}

async function markFailed(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
    error: unknown,
): Promise<void> {
    const errorMessage = failureMessage(dependencies, error);
    const retryCount = track.vibeAnalysisRetryCount ?? 0;
    const updated = await dependencies.prisma.track.updateMany({
        where: {
            ...activeTrackWhere(track.id),
            vibeAnalysisStatus: "processing",
            vibeAnalysisRetryCount: retryCount,
            vibeAnalysisGeneration: track.vibeAnalysisGeneration ?? 0,
        },
        data: {
            vibeAnalysisStatus: "failed",
            vibeAnalysisError: errorMessage,
            vibeAnalysisRetryCount: { increment: 1 },
            vibeAnalysisStartedAt: null,
            vibeAnalysisStatusUpdatedAt: dependencies.now(),
        },
    });
    if (updated.count === 0) return;
    await dependencies.failureService.recordFailure({
        entityType: "vibe",
        entityId: track.id,
        entityName: track.title,
        errorMessage,
        errorCode: "VIBE_EMBEDDING_FAILED",
    });
}

async function resetTransientFailure(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
    error: unknown,
): Promise<boolean> {
    const retryCount = track.vibeAnalysisRetryCount ?? 0;
    if (
        !dependencies.isTransientFailure(error) ||
        retryCount + 1 >= MAX_VIBE_ANALYSIS_RETRIES
    ) {
        return false;
    }
    const updated = await dependencies.prisma.track.updateMany({
        where: {
            ...activeTrackWhere(track.id),
            vibeAnalysisStatus: "processing",
            vibeAnalysisRetryCount: retryCount,
            vibeAnalysisGeneration: track.vibeAnalysisGeneration ?? 0,
        },
        data: {
            vibeAnalysisStatus: "pending",
            vibeAnalysisError: failureMessage(dependencies, error),
            vibeAnalysisRetryCount: { increment: 1 },
            vibeAnalysisStartedAt: null,
            vibeAnalysisStatusUpdatedAt: dependencies.now(),
        },
    });
    return updated.count === 1;
}

async function handleGenerationFailure(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
    error: unknown,
): Promise<void> {
    if (await resetTransientFailure(dependencies, track, error)) return;
    await markFailed(dependencies, track, error);
}

async function markCompleted(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
): Promise<boolean> {
    const updated = await dependencies.prisma.track.updateMany({
        where: {
            ...activeTrackWhere(track.id),
            vibeAnalysisStatus: "processing",
            vibeAnalysisGeneration: track.vibeAnalysisGeneration ?? 0,
        },
        data: {
            vibeAnalysisStatus: "completed",
            vibeAnalysisError: null,
            vibeAnalysisStartedAt: null,
            vibeAnalysisStatusUpdatedAt: dependencies.now(),
        },
    });
    if (updated.count !== 1) return false;
    await dependencies.failureService
        .resolveByEntity("vibe", track.id)
        .catch((error) => {
            jobLog.warn("Failed to resolve stale vibe failure", {
                trackId: track.id,
                error,
            });
        });
    return true;
}

function finish(
    dependencies: VibeEmbedJobDependencies,
    outcome: VibeEmbedJobOutcome,
): VibeEmbedJobOutcome {
    dependencies.recordOutcome(outcome);
    return outcome;
}

async function processValidJob(
    job: VibeEmbedJob,
    dependencies: VibeEmbedJobDependencies,
): Promise<VibeEmbedJobOutcome> {
    const track = await findActiveTrack(dependencies.prisma, job.trackId);
    if (!track) {
        await releaseReservation(dependencies, job.trackId);
        return finish(dependencies, "track_missing");
    }
    const claimedTrack = await claimTrack(dependencies, track);
    if (!claimedTrack) {
        jobLog.debug("Skipped stale vibe embedding job claim", {
            trackId: track.id,
        });
        return finish(dependencies, "stale_claim");
    }

    let vector: number[];
    try {
        vector = await dependencies.embedAudio(job.filePath, {
            id: dependencies.targetSpaceId,
            dim: dependencies.targetSpaceDim,
        });
    } catch (error) {
        await handleGenerationFailure(dependencies, claimedTrack, error);
        return finish(dependencies, "embed_failed");
    }
    try {
        const stillActive = await findActiveTrack(
            dependencies.prisma,
            track.id,
        );
        if (!stillActive) return finish(dependencies, "track_missing");
        // Status fields are intentionally shared across spaces because one
        // provider target is filled at a time in this worker process.
        await dependencies.upsertTrackEmbedding(
            track.id,
            vector,
            dependencies.targetSpaceId,
        );
        if (!(await markCompleted(dependencies, claimedTrack))) {
            return finish(dependencies, "stale_claim");
        }
        return finish(dependencies, "stored");
    } catch (error) {
        await markFailed(dependencies, claimedTrack, error);
        return finish(dependencies, "embed_failed");
    }
}

async function processInvalidJob(
    trackId: string | null,
    dependencies: VibeEmbedJobDependencies,
): Promise<VibeEmbedJobOutcome> {
    jobLog.warn("Dropped invalid vibe embedding job payload");
    if (trackId === null) return finish(dependencies, "invalid_payload");

    await releaseReservation(dependencies, trackId);
    const track = await findTrackForInvalidPayload(dependencies, trackId);
    const protectedTrack =
        track?.vibeAnalysisStatus === "completed" ||
        (track?.embeddings?.length ?? 0) > 0;
    if (track && !protectedTrack) {
        await markFailedWithMessage(dependencies, track, INVALID_PAYLOAD_ERROR);
    } else if (track) {
        jobLog.warn(
            "Dropped invalid vibe embedding job for a protected track",
            {
                trackId,
            },
        );
    }
    return finish(dependencies, "invalid_payload");
}

/** Creates a processor for one untrusted Redis audio-embedding payload. */
export function createVibeEmbedJobProcessor(
    dependencies: VibeEmbedJobDependencies,
): (rawJob: string) => Promise<VibeEmbedJobOutcome> {
    return async (rawJob) => {
        const parsedJob = parseJob(rawJob);
        if (parsedJob.kind === "invalid") {
            return processInvalidJob(parsedJob.trackId, dependencies);
        }
        return processValidJob(parsedJob.job, dependencies);
    };
}

function describeVibeEmbedFailure(error: unknown): string {
    if (!(error instanceof VibeProviderError)) {
        return "Vibe embedding generation failed";
    }
    switch (error.code) {
        case "timeout":
            return "Vibe provider request timed out";
        case "unreachable":
            return "Vibe provider is unreachable";
        case "auth":
            return "Vibe provider authentication failed";
        case "contract":
            return "Vibe provider returned an invalid response";
        case "provider_5xx":
            return "Vibe provider reported an internal failure";
        case "request_rejected":
            return "Vibe provider rejected the audio reference";
        case "space_mismatch":
            return "Vibe provider does not match the active space";
    }
}

/** Classifies provider failures that are safe for bounded automatic retry. */
export function isTransientVibeProviderFailure(error: unknown): boolean {
    return (
        error instanceof VibeProviderError &&
        (error.code === "timeout" ||
            error.code === "unreachable" ||
            error.code === "provider_5xx")
    );
}

/** Process one queued audio-embedding job for an explicit provider space. */
export async function processVibeEmbedJob(
    rawJob: string,
    targetSpace: VibeEmbedJobTargetSpace,
): Promise<VibeEmbedJobOutcome> {
    return createVibeEmbedJobProcessor({
        targetSpaceId: targetSpace.id,
        targetSpaceDim: targetSpace.dim,
        prisma,
        embedAudio,
        upsertTrackEmbedding,
        failureService: enrichmentFailureService,
        releaseReservation: async (trackId) => {
            await redisClient.del(`${VIBE_QUEUE}:reserved:${trackId}`);
        },
        recordOutcome: recordVibeEmbedJobOutcome,
        describeFailure: describeVibeEmbedFailure,
        isTransientFailure: isTransientVibeProviderFailure,
        now: () => new Date(),
    })(rawJob);
}
