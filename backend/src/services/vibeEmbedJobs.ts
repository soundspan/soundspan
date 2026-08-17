import { z } from "zod";
import { recordVibeEmbedJobOutcome } from "../metrics";
import type { VibeEmbedJobOutcome } from "../metrics/vibeEmbedMetrics";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "./enrichmentFailureService";
import { upsertTrackEmbedding } from "./trackEmbeddings";
import { embedAudio, VibeProviderError } from "./vibeProvider";

const VIBE_QUEUE = "audio:clap:queue";
const MAX_ERROR_LENGTH = 500;
const INVALID_PAYLOAD_ERROR = "Invalid vibe embedding job payload";
const jobLog = logger.child("VibeEmbedJobs");
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
type TrackSnapshot = { id: string; title: string };
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
    prisma: VibeEmbedPrismaPort;
    embedAudio(trackRef: string): Promise<number[]>;
    upsertTrackEmbedding(
        trackId: string,
        embedding: readonly number[],
    ): Promise<void>;
    failureService: FailureServicePort;
    releaseReservation(trackId: string): Promise<void>;
    recordOutcome(outcome: VibeEmbedJobOutcome): void;
    describeFailure(error: unknown): string;
    now(): Date;
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
        select: { id: true, title: true },
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
    trackId: string,
): Promise<boolean> {
    const timestamp = dependencies.now();
    const result = await dependencies.prisma.track.updateMany({
        where: {
            ...activeTrackWhere(trackId),
            OR: [
                { vibeAnalysisStatus: null },
                { vibeAnalysisStatus: "pending" },
            ],
        },
        data: {
            vibeAnalysisStatus: "processing",
            vibeAnalysisStartedAt: timestamp,
            vibeAnalysisStatusUpdatedAt: timestamp,
        },
    });
    await releaseReservation(dependencies, trackId);
    return result.count === 1;
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
    // Guarded like claimTrack so a stray or duplicate job can never demote a
    // track another consumer already completed or failed.
    const updated = await dependencies.prisma.track.updateMany({
        where: {
            ...activeTrackWhere(track.id),
            OR: [
                { vibeAnalysisStatus: null },
                { vibeAnalysisStatus: "pending" },
                { vibeAnalysisStatus: "processing" },
            ],
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
    await markFailedWithMessage(
        dependencies,
        track,
        failureMessage(dependencies, error),
    );
}

async function markCompleted(
    dependencies: VibeEmbedJobDependencies,
    trackId: string,
): Promise<void> {
    await dependencies.prisma.track.update({
        where: { id: trackId },
        data: {
            vibeAnalysisStatus: "completed",
            vibeAnalysisError: null,
            vibeAnalysisStartedAt: null,
            vibeAnalysisStatusUpdatedAt: dependencies.now(),
        },
    });
    await dependencies.failureService
        .resolveByEntity("vibe", trackId)
        .catch((error) => {
            jobLog.warn("Failed to resolve stale vibe failure", {
                trackId,
                error,
            });
        });
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
    if (!(await claimTrack(dependencies, track.id))) {
        jobLog.debug("Skipped stale vibe embedding job claim", {
            trackId: track.id,
        });
        return finish(dependencies, "stale_claim");
    }

    try {
        const vector = await dependencies.embedAudio(job.filePath);
        const stillActive = await findActiveTrack(
            dependencies.prisma,
            track.id,
        );
        if (!stillActive) return finish(dependencies, "track_missing");
        await dependencies.upsertTrackEmbedding(track.id, vector);
        await markCompleted(dependencies, track.id);
        return finish(dependencies, "stored");
    } catch (error) {
        await markFailed(dependencies, track, error);
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
    const track = await findActiveTrack(dependencies.prisma, trackId);
    if (track) {
        await markFailedWithMessage(dependencies, track, INVALID_PAYLOAD_ERROR);
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

/** Processes one queued audio-embedding job through the configured provider. */
export const processVibeEmbedJob = createVibeEmbedJobProcessor({
    prisma,
    embedAudio,
    upsertTrackEmbedding,
    failureService: enrichmentFailureService,
    releaseReservation: async (trackId) => {
        await redisClient.del(`${VIBE_QUEUE}:reserved:${trackId}`);
    },
    recordOutcome: recordVibeEmbedJobOutcome,
    describeFailure: describeVibeEmbedFailure,
    now: () => new Date(),
});
