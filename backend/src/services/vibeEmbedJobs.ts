import { z } from "zod";
import { recordVibeEmbedJobOutcome } from "../metrics";
import type { VibeEmbedJobOutcome } from "../metrics/vibeEmbedMetrics";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "./enrichmentFailureService";
import {
    EmbeddingTargetInvalidatedError,
    upsertTrackEmbedding,
    VibeEmbeddingGenerationMismatchError,
    type VibeEmbeddingWriteClaim,
} from "./trackEmbeddings";
import {
    embedAudio,
    VibeProviderBackpressureError,
    VibeProviderError,
} from "./vibeProvider";
import type { EmbeddingVectorSpace } from "./vibeProvider";
import { vibeEmbeddingTargetGateWhere } from "./vibeEmbeddingEligibility";

const VIBE_QUEUE = "audio:clap:queue";
const MAX_ERROR_LENGTH = 500;
const INVALID_PAYLOAD_ERROR = "Invalid vibe embedding job payload";
export const MAX_VIBE_ANALYSIS_RETRIES = 3;
const VIBE_RETRY_KEY_PREFIX = "soundspan:vibe-retry-after:v1:";
const VIBE_RETRY_BACKOFF_MS = [30_000, 120_000, 300_000] as const;
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
type VibeRetryCandidate = { id: string };
type VibeRetryStateReader = (keys: string[]) => Promise<Array<string | null>>;

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
        claim: VibeEmbeddingWriteClaim,
    ): Promise<void>;
    failureService: FailureServicePort;
    releaseReservation(trackId: string): Promise<void>;
    recordOutcome(outcome: VibeEmbedJobOutcome): void;
    describeFailure(error: unknown): string;
    isTransientFailure(error: unknown): boolean;
    isRetryEligible(trackId: string): Promise<boolean>;
    scheduleRetry(trackId: string, notBefore: Date): Promise<void>;
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
    const updatedAt = dependencies.now();
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
            vibeAnalysisStatusUpdatedAt: updatedAt,
        },
    });
    if (updated.count !== 1) return false;
    const retryDelayMs = retryDelayForFailure(error, retryCount);
    await dependencies.scheduleRetry(
        track.id,
        new Date(updatedAt.getTime() + retryDelayMs),
    );
    return true;
}

function retryDelayForFailure(error: unknown, retryCount: number): number {
    const baseline =
        VIBE_RETRY_BACKOFF_MS[
            Math.min(retryCount, VIBE_RETRY_BACKOFF_MS.length - 1)
        ];
    if (
        error instanceof VibeProviderBackpressureError &&
        error.retryAfterMs !== undefined
    ) {
        return Math.min(
            VIBE_RETRY_BACKOFF_MS[2],
            Math.max(baseline, error.retryAfterMs),
        );
    }
    return baseline;
}

function retryStateAllowsEnqueue(
    stored: string | null,
    nowMs: number,
): boolean {
    if (stored === null) return true;
    const notBeforeMs = Number(stored);
    return !Number.isFinite(notBeforeMs) || notBeforeMs <= nowMs;
}

/** Batch-read retry state and return only candidates whose not-before elapsed. */
export async function filterVibeRetryEligibleCandidates<
    Candidate extends VibeRetryCandidate,
>(
    candidates: Candidate[],
    readRetryStates: VibeRetryStateReader,
    nowMs: number = Date.now(),
): Promise<Candidate[]> {
    if (candidates.length === 0) return [];
    const keys = candidates.map(
        (candidate) => `${VIBE_RETRY_KEY_PREFIX}${candidate.id}`,
    );
    const states = await readRetryStates(keys);
    if (states.length !== candidates.length) {
        throw new Error("Vibe retry state batch read was incomplete");
    }
    return candidates.filter((_candidate, index) =>
        retryStateAllowsEnqueue(states[index] ?? null, nowMs),
    );
}

async function handleGenerationFailure(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
    error: unknown,
): Promise<void> {
    if (await resetTransientFailure(dependencies, track, error)) return;
    await markFailed(dependencies, track, error);
}

async function resolveStaleFailure(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
): Promise<void> {
    await dependencies.failureService
        .resolveByEntity("vibe", track.id)
        .catch((error) => {
            jobLog.warn("Failed to resolve stale vibe failure", {
                trackId: track.id,
                error,
            });
        });
}

async function resetInvalidatedTargetClaim(
    dependencies: VibeEmbedJobDependencies,
    track: TrackSnapshot,
    error: unknown,
): Promise<void> {
    const updated = await dependencies.prisma.track.updateMany({
        where: {
            ...activeTrackWhere(track.id),
            vibeAnalysisStatus: "processing",
            vibeAnalysisGeneration: track.vibeAnalysisGeneration ?? 0,
        },
        data: {
            vibeAnalysisStatus: "pending",
            vibeAnalysisError: failureMessage(dependencies, error),
            vibeAnalysisStartedAt: null,
            vibeAnalysisStatusUpdatedAt: dependencies.now(),
        },
    });
    if (updated.count < 0 || updated.count > 1) {
        throw new Error("Target invalidation reset was inconsistent");
    }
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
    if (!(await dependencies.isRetryEligible(job.trackId))) {
        await releaseReservation(dependencies, job.trackId);
        jobLog.debug("Skipped vibe embedding job before retry not-before", {
            trackId: job.trackId,
        });
        return finish(dependencies, "stale_claim");
    }
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
        // Status fields are intentionally shared across spaces because one
        // provider target is filled at a time in this worker process.
        await dependencies.upsertTrackEmbedding(
            track.id,
            vector,
            dependencies.targetSpaceId,
            {
                generation: claimedTrack.vibeAnalysisGeneration ?? 0,
                completedAt: dependencies.now(),
            },
        );
        await resolveStaleFailure(dependencies, claimedTrack);
        return finish(dependencies, "stored");
    } catch (error) {
        if (error instanceof VibeEmbeddingGenerationMismatchError) {
            return finish(dependencies, "stale_claim");
        }
        if (error instanceof EmbeddingTargetInvalidatedError) {
            await resetInvalidatedTargetClaim(
                dependencies,
                claimedTrack,
                error,
            );
            throw error;
        }
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
        case "backpressure":
            return "Vibe provider inference queue is full";
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
            error.code === "provider_5xx" ||
            error.code === "backpressure")
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
        isRetryEligible: async (trackId) => {
            const stored = await redisClient.get(
                `${VIBE_RETRY_KEY_PREFIX}${trackId}`,
            );
            return retryStateAllowsEnqueue(stored, Date.now());
        },
        scheduleRetry: async (trackId, notBefore) => {
            const ttlMs = Math.max(1, notBefore.getTime() - Date.now());
            await redisClient.set(
                `${VIBE_RETRY_KEY_PREFIX}${trackId}`,
                String(notBefore.getTime()),
                { PX: ttlMs },
            );
        },
        now: () => new Date(),
    })(rawJob);
}
