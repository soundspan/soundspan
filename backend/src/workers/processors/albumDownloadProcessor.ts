import type { Job } from "bull";
import { z } from "zod";
import { dispatchAlbumDownload } from "../../services/downloadDispatcher";
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
        albumTitle: z.string().optional(),
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
const ALBUM_DOWNLOAD_CLAIM_POLL_INTERVAL_MS = 15_000;
const ALBUM_DOWNLOAD_CLAIM_MAX_POLLS = 960;

type AlbumDownloadPayload = z.infer<typeof payloadSchema>;

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

async function dispatchPersistedAlbumDownload(
    payload: AlbumDownloadPayload,
): Promise<void> {
    if ((await getPersistedStatus(payload.jobId)) === "completed") {
        log.info("Skipping completed album download redelivery", {
            jobId: payload.jobId,
        });
        return;
    }

    await dispatchAlbumDownload(payload);
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
        await dispatchPersistedAlbumDownload(payload);
    } finally {
        clearInterval(renewalTimer);
        if (renewalPromise) await renewalPromise;
    }
}

async function waitForAlbumDownloadClaim(
    payload: AlbumDownloadPayload,
): Promise<void> {
    for (let poll = 0; poll < ALBUM_DOWNLOAD_CLAIM_MAX_POLLS; poll += 1) {
        const result = await runWithSchedulerClaim(
            ALBUM_DOWNLOAD_CLAIM_KEY,
            ALBUM_DOWNLOAD_CLAIM_TTL_MS,
            "album download",
            (claimToken) => dispatchWithClaimRenewal(payload, claimToken),
        );
        if (result.acquired) return;
        await new Promise<void>((resolve) =>
            setTimeout(resolve, ALBUM_DOWNLOAD_CLAIM_POLL_INTERVAL_MS),
        );
    }
    throw new Error("Timed out waiting for the album download claim");
}

/** Validate and dispatch one queued album download. */
export async function processAlbumDownload(job: Job<unknown>): Promise<void> {
    const payload = payloadSchema.parse(job.data);
    await job.progress(0);
    await waitForAlbumDownloadClaim(payload);
    await job.progress(100);
}

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
                status: { in: ["pending", "processing"] },
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
