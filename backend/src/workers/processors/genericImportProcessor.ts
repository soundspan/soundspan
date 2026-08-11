import type { Job } from "bull";
import { z } from "zod";
import { genericImportJobRunner } from "../../services/genericImportJobRunner";

const RUN_JOB_NAME = "generic-import-run";
const RECOVERY_JOB_NAME = "generic-import-recover";
const runPayloadSchema = z
    .object({
        jobId: z.string().trim().min(1).max(128),
    })
    .strict();
const recoveryPayloadSchema = z
    .object({
        trigger: z.enum(["startup", "repeat"]),
    })
    .strict();

/** Maximum number of generic imports claimed concurrently by one worker. */
export const GENERIC_IMPORT_WORKER_CONCURRENCY = 2;

function isFinalAttempt(job: Job<unknown>): boolean {
    const configuredAttempts = Math.max(1, job.opts.attempts ?? 1);
    return job.attemptsMade + 1 >= configuredAttempts;
}

async function processRunJob(job: Job<unknown>): Promise<void> {
    const parsed = runPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
        throw new Error("Invalid generic import queue payload");
    }
    await genericImportJobRunner.runJob(parsed.data.jobId, {
        retryFailures: true,
        finalAttempt: isFinalAttempt(job),
    });
}

async function processRecoveryJob(job: Job<unknown>): Promise<void> {
    const parsed = recoveryPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
        throw new Error("Invalid generic import recovery payload");
    }
    await genericImportJobRunner.recoverActiveJobs();
}

/**
 * Validates and executes one generic-import queue operation.
 */
export async function processGenericImport(job: Job<unknown>): Promise<void> {
    await job.progress(0);
    if (job.name === RUN_JOB_NAME) {
        await processRunJob(job);
    } else if (job.name === RECOVERY_JOB_NAME) {
        await processRecoveryJob(job);
    } else {
        throw new Error(`Unsupported generic import queue job "${job.name}"`);
    }
    await job.progress(100);
}

/**
 * Finalizes persisted state after Bull exhausts retry and stalled-job recovery.
 */
export async function finalizeGenericImportQueueFailure(
    job: Job<unknown>,
    error: unknown,
): Promise<void> {
    if (job.name !== RUN_JOB_NAME) {
        return;
    }
    const parsed = runPayloadSchema.safeParse(job.data);
    if (!parsed.success || (await job.getState()) !== "failed") {
        return;
    }
    await genericImportJobRunner.finalizeQueueFailure(parsed.data.jobId, error);
}
