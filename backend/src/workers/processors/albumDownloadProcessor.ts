import type { Job } from "bull";
import { z } from "zod";
import {
    type AlbumDownloadRouting,
    dispatchResolvedAlbumDownload,
    resolveAlbumDownloadRouting,
} from "../../services/downloadDispatcher";
import { albumDownloadQueueJobId } from "../../services/albumDownloadQueueOwnership";
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../../services/downloadJobStatus";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    extendSchedulerClaim,
    runWithSchedulerClaim,
} from "../../utils/schedulerClaim";

const log = logger.child("AlbumDownloadProcessor");
const payloadSchema = z
    .object({
        jobId: z.string(),
        type: z.literal("album"),
        mbid: z.string(),
        subject: z.string(),
        artistName: z.string().optional(),
        artistMbid: z.string().optional(),
        albumTitle: z.string().optional(),
        claimWaitAttempts: z.number().int().min(0).max(480).optional(),
    })
    .strict();
const finalizerPayloadSchema = z
    .object({
        jobId: z.string(),
    })
    .passthrough();
const ALBUM_DOWNLOAD_CLAIM_KEY = "scheduler-claim:album-download";
const ALBUM_DOWNLOAD_CLAIM_TTL_MS = 15 * 60_000;
const ALBUM_DOWNLOAD_CLAIM_RENEW_INTERVAL_MS = 5 * 60_000;
const ALBUM_DOWNLOAD_CLAIM_REQUEUE_DELAY_MS = 30_000;
const ALBUM_DOWNLOAD_CLAIM_MAX_WAIT_ATTEMPTS = 480;

type AlbumDownloadPayload = z.infer<typeof payloadSchema>;

/** Result returned to the Bull completion event for an album-download pass. */
export type AlbumDownloadProcessOutcome =
    | Readonly<{ kind: "completed" }>
    | Readonly<{
          kind: "contention-wait";
          payload: AlbumDownloadPayload;
          delayMs: number;
      }>;

const COMPLETED_OUTCOME: AlbumDownloadProcessOutcome = { kind: "completed" };

/** Bull job name used for durable album downloads. */
export const ALBUM_DOWNLOAD_JOB_NAME = "album-download";

/** Fixed owner-selected album download concurrency per worker process. */
export const ALBUM_DOWNLOAD_WORKER_CONCURRENCY = 1;

/** Typed failure raised when a provider persists a failed download outcome. */
export class AlbumDownloadFailedError extends Error {
    readonly jobId: string;

    constructor(jobId: string) {
        super(`Album download ${jobId} failed`);
        this.name = "AlbumDownloadFailedError";
        this.jobId = jobId;
    }
}

async function getPersistedStatus(jobId: string): Promise<string | null> {
    const persistedJob = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { status: true },
    });
    return persistedJob?.status ?? null;
}

async function skipTerminalRedelivery(
    payload: AlbumDownloadPayload,
): Promise<boolean> {
    const status = await getPersistedStatus(payload.jobId);
    if (status !== "completed" && status !== "failed") return false;
    log.info(`Skipping ${status} album download redelivery`, {
        jobId: payload.jobId,
    });
    return true;
}

async function dispatchPersistedAlbumDownload(
    payload: AlbumDownloadPayload,
    routing: AlbumDownloadRouting | null,
): Promise<void> {
    await dispatchResolvedAlbumDownload(routing, payload);
    if ((await getPersistedStatus(payload.jobId)) === "failed") {
        throw new AlbumDownloadFailedError(payload.jobId);
    }
}

async function renewAlbumDownloadClaim(
    payload: AlbumDownloadPayload,
    claimToken: string,
): Promise<void> {
    try {
        await extendSchedulerClaim(
            ALBUM_DOWNLOAD_CLAIM_KEY,
            claimToken,
            ALBUM_DOWNLOAD_CLAIM_TTL_MS,
        );
    } catch (error) {
        log.warn("Album download claim renewal failed", {
            jobId: payload.jobId,
            error,
        });
    }
}

async function dispatchWithClaimRenewal(
    payload: AlbumDownloadPayload,
    routing: AlbumDownloadRouting,
    claimToken: string,
): Promise<void> {
    let renewalPromise: Promise<void> | null = null;
    const renewalTimer = setInterval(() => {
        if (renewalPromise) return;
        renewalPromise = renewAlbumDownloadClaim(payload, claimToken).then(
            () => {
                renewalPromise = null;
            },
        );
    }, ALBUM_DOWNLOAD_CLAIM_RENEW_INTERVAL_MS);
    renewalTimer.unref();
    try {
        if (!(await skipTerminalRedelivery(payload))) {
            await dispatchPersistedAlbumDownload(payload, routing);
        }
    } finally {
        clearInterval(renewalTimer);
        if (renewalPromise) await renewalPromise;
    }
}

interface AlbumDownloadClaimWaitPolicy {
    delayMs: number;
    maxWaitAttempts: number;
}

const DEFAULT_CLAIM_WAIT_POLICY: AlbumDownloadClaimWaitPolicy = {
    delayMs: ALBUM_DOWNLOAD_CLAIM_REQUEUE_DELAY_MS,
    maxWaitAttempts: ALBUM_DOWNLOAD_CLAIM_MAX_WAIT_ATTEMPTS,
};

function requeueOptions(
    job: Job<unknown>,
    jobId: string,
    delayMs: number,
): Record<string, unknown> {
    const preserved = {
        priority: job.opts.priority,
        attempts: job.opts.attempts,
        backoff: job.opts.backoff,
        removeOnComplete: job.opts.removeOnComplete,
        removeOnFail: job.opts.removeOnFail,
    };
    return Object.fromEntries(
        Object.entries({ ...preserved, jobId, delay: delayMs }).filter(
            ([, value]) => value !== undefined,
        ),
    );
}

function contentionWaitOutcome(
    payload: AlbumDownloadPayload,
    policy: AlbumDownloadClaimWaitPolicy,
): AlbumDownloadProcessOutcome {
    const waitAttempts = payload.claimWaitAttempts ?? 0;
    if (waitAttempts >= policy.maxWaitAttempts) {
        throw new Error("Timed out waiting for the album download claim");
    }
    return {
        kind: "contention-wait",
        payload: { ...payload, claimWaitAttempts: waitAttempts + 1 },
        delayMs: policy.delayMs,
    };
}

/** Replace a completed contention pass with its same stable delayed job. */
export async function requeueAlbumDownloadAfterContention(
    job: Job<unknown>,
    outcome: AlbumDownloadProcessOutcome,
): Promise<void> {
    if (outcome.kind !== "contention-wait") return;
    const queueJobId = albumDownloadQueueJobId(outcome.payload.jobId);
    await job.remove();
    await job.queue.add(
        ALBUM_DOWNLOAD_JOB_NAME,
        outcome.payload,
        requeueOptions(job, queueJobId, outcome.delayMs),
    );
    log.debug("Re-enqueued album download after claim contention", {
        jobId: outcome.payload.jobId,
        queueJobId,
        waitAttempts: outcome.payload.claimWaitAttempts,
        delayMs: outcome.delayMs,
    });
}

function requiresAlbumDownloadClaim(
    routing: AlbumDownloadRouting | null,
): routing is Extract<AlbumDownloadRouting, { kind: "dispatch" }> {
    return (
        routing?.kind === "dispatch" &&
        (routing.source === "tidal" ||
            routing.source === "youtube" ||
            routing.source === "soulseek")
    );
}

/** Validate and dispatch one queued album download. */
async function processAlbumDownloadWithPolicy(
    job: Job<unknown>,
    policy: AlbumDownloadClaimWaitPolicy,
): Promise<AlbumDownloadProcessOutcome> {
    const payload = payloadSchema.parse(job.data);
    await job.progress(0);
    if (await skipTerminalRedelivery(payload)) {
        await job.progress(100);
        return COMPLETED_OUTCOME;
    }

    const routing = await resolveAlbumDownloadRouting(payload);
    if (requiresAlbumDownloadClaim(routing)) {
        const result = await runWithSchedulerClaim(
            ALBUM_DOWNLOAD_CLAIM_KEY,
            ALBUM_DOWNLOAD_CLAIM_TTL_MS,
            "album download",
            (claimToken) =>
                dispatchWithClaimRenewal(payload, routing, claimToken),
        );
        if (!result.acquired) {
            return contentionWaitOutcome(payload, policy);
        }
    } else {
        await dispatchPersistedAlbumDownload(payload, routing);
    }
    await job.progress(100);
    return COMPLETED_OUTCOME;
}

/** Validate and dispatch one queued album download. */
export function processAlbumDownload(
    job: Job<unknown>,
): Promise<AlbumDownloadProcessOutcome> {
    return processAlbumDownloadWithPolicy(job, DEFAULT_CLAIM_WAIT_POLICY);
}

export const __albumDownloadProcessorTestables = {
    processAlbumDownloadWithPolicy,
};

/** Finalize persisted state after Bull exhausts album-download recovery. */
export async function finalizeAlbumDownloadQueueFailure(
    job: Job<unknown>,
    _error: unknown,
    knownState?: string,
): Promise<void> {
    const parsed = finalizerPayloadSchema.safeParse(job.data);
    const state = knownState ?? (await job.getState());
    if (!parsed.success || state !== "failed") return;

    try {
        await prisma.downloadJob.updateMany({
            where: {
                id: parsed.data.jobId,
                status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
            },
            data: {
                status: "failed",
                error: "Download failed",
                completedAt: new Date(),
            },
        });
    } catch (error) {
        log.error("Failed to persist exhausted album download queue failure", {
            jobId: parsed.data.jobId,
            error,
        });
    }
}
