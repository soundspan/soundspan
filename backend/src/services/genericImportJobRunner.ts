import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { genericImportQueue } from "../workers/queues";
import { importJobStore, type StoredImportJob } from "./importJobStore";
import { playlistImportService } from "./playlistImportService";

const log = logger.child("GenericImportJobRunner");
const RUN_JOB_NAME = "generic-import-run";
const RECOVERY_JOB_NAME = "generic-import-recover";
const RECOVERY_BATCH_SIZE = 100;
const RECOVERY_INTERVAL_MS = 60_000;
const SAFE_FAILURE_MESSAGE = "Generic import job failed";
const ACTIVE_IMPORT_JOB_STATUSES = [
    "pending",
    "resolving",
    "creating_playlist",
    "cancelling",
] as const;

type ImportPreview = Awaited<
    ReturnType<typeof playlistImportService.previewImport>
>;
type ImportExecution = Awaited<
    ReturnType<typeof playlistImportService.importPlaylist>
>;

interface RunJobOptions {
    retryFailures?: boolean;
    finalAttempt?: boolean;
}

class ImportJobCancelledError extends Error {}

function isTerminalStatus(status: string): boolean {
    return (
        status === "completed" || status === "failed" || status === "cancelled"
    );
}

/**
 * Queue-backed execution runner for persisted generic import jobs.
 */
export class GenericImportJobRunner {
    /**
     * Supervises durable queue insertion for an API-created import job.
     */
    enqueue(jobId: string): void {
        void this.enqueuePersistedJob(jobId).catch((error) => {
            log.error("Failed to enqueue persisted import job", {
                jobId,
                error,
            });
        });
    }

    /**
     * Registers startup and periodic recovery sweeps in the durable queue.
     */
    async registerRecoveryJobs(): Promise<void> {
        await genericImportQueue.isReady();
        const startupRegistration = genericImportQueue.add(
            RECOVERY_JOB_NAME,
            { trigger: "startup" },
            {
                jobId: "generic-import-recovery:startup",
                removeOnComplete: true,
                removeOnFail: true,
            },
        );
        const repeatRegistration = genericImportQueue.add(
            RECOVERY_JOB_NAME,
            { trigger: "repeat" },
            {
                jobId: "generic-import-recovery:repeat",
                repeat: { every: RECOVERY_INTERVAL_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        await Promise.all([startupRegistration, repeatRegistration]);
    }

    /**
     * Requeues one bounded batch of persisted active jobs after delivery gaps or restarts.
     */
    async recoverActiveJobs(): Promise<number> {
        const jobs = await prisma.importJob.findMany({
            where: { status: { in: [...ACTIVE_IMPORT_JOB_STATUSES] } },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            select: { id: true },
            take: RECOVERY_BATCH_SIZE,
        });

        let recoveredCount = 0;
        for (
            let index = 0;
            index < jobs.length && index < RECOVERY_BATCH_SIZE;
            index += 1
        ) {
            const job = jobs[index];
            if (job) {
                await this.enqueuePersistedJob(job.id);
                recoveredCount += 1;
            }
        }

        if (recoveredCount > 0) {
            log.info("Recovered persisted import jobs", {
                count: recoveredCount,
            });
        }
        return recoveredCount;
    }

    /**
     * Executes an import job and exposes failures to Bull while retries remain.
     */
    async runJob(jobId: string, options: RunJobOptions = {}): Promise<void> {
        try {
            await this.executeJob(jobId);
        } catch (error) {
            if (error instanceof ImportJobCancelledError) {
                await this.finishCancellation(jobId);
                return;
            }

            await this.handleExecutionFailure(jobId, error, options);
            if (options.retryFailures) {
                throw error;
            }
        }
    }

    /**
     * Marks a persisted job failed when Bull exhausts lease or processor recovery.
     */
    async finalizeQueueFailure(jobId: string, error: unknown): Promise<void> {
        const latestJob = await importJobStore.getJob(jobId);
        if (!latestJob || isTerminalStatus(latestJob.status)) {
            return;
        }

        await this.persistSafeFailure(jobId);
        log.error("Import queue exhausted recovery", { jobId, error });
    }

    private async enqueuePersistedJob(jobId: string): Promise<void> {
        if (!jobId.trim()) {
            throw new Error("Generic import job id is required");
        }
        const existingJob = await genericImportQueue.getJob(jobId);
        if (existingJob) {
            const state = await existingJob.getState();
            if (state === "failed" || state === "completed") {
                await this.finalizeQueueFailure(
                    jobId,
                    new Error(`Queue job is terminal in state ${state}`),
                );
            }
            return;
        }
        await genericImportQueue.add(RUN_JOB_NAME, { jobId }, { jobId });
    }

    private async executeJob(jobId: string): Promise<void> {
        const initialJob = await importJobStore.getJob(jobId);
        if (!initialJob || isTerminalStatus(initialJob.status)) {
            return;
        }

        const runnableJob = await this.ensureRunnable(jobId);
        const preview = await this.resolvePreview(jobId, runnableJob);
        const execution = await this.createPlaylist(
            jobId,
            runnableJob,
            preview,
        );
        await this.completeJob(jobId, execution);
    }

    private async resolvePreview(
        jobId: string,
        job: StoredImportJob,
    ): Promise<ImportPreview> {
        await importJobStore.updateJob(jobId, {
            status: "resolving",
            progress: 20,
        });
        return playlistImportService.previewImport(job.userId, job.sourceUrl);
    }

    private async createPlaylist(
        jobId: string,
        job: StoredImportJob,
        preview: ImportPreview,
    ): Promise<ImportExecution> {
        await this.ensureRunnable(jobId);
        await importJobStore.updateJob(jobId, {
            status: "creating_playlist",
            progress: 70,
            summary: preview.summary,
            resolvedTracks:
                preview.resolved as unknown as Prisma.InputJsonValue,
        });
        return playlistImportService.importPlaylist(
            job.userId,
            preview,
            job.requestedPlaylistName ?? undefined,
        );
    }

    private async completeJob(
        jobId: string,
        execution: ImportExecution,
    ): Promise<void> {
        const latestJob = await importJobStore.getJob(jobId);
        const cancelledDuringImport =
            latestJob?.status === "cancelled" ||
            latestJob?.status === "cancelling";
        await importJobStore.updateJob(jobId, {
            status: "completed",
            progress: 100,
            summary: execution.summary,
            createdPlaylistId: execution.playlistId,
            error: cancelledDuringImport
                ? "Cancellation requested after playlist creation completed"
                : null,
        });
    }

    private async handleExecutionFailure(
        jobId: string,
        error: unknown,
        options: RunJobOptions,
    ): Promise<void> {
        if (options.retryFailures && options.finalAttempt === false) {
            log.warn("Import job attempt failed; queue retry remains", {
                jobId,
                error,
            });
            return;
        }

        const latestJob = await importJobStore.getJob(jobId);
        if (latestJob && !isTerminalStatus(latestJob.status)) {
            await this.persistSafeFailure(jobId);
        }
        log.error("Import job failed", { jobId, error });
    }

    private async persistSafeFailure(jobId: string): Promise<void> {
        await importJobStore.updateJob(jobId, {
            status: "failed",
            progress: 100,
            error: SAFE_FAILURE_MESSAGE,
        });
    }

    private async finishCancellation(jobId: string): Promise<void> {
        const latestJob = await importJobStore.getJob(jobId);
        if (latestJob?.status === "cancelling") {
            await importJobStore.updateJob(jobId, {
                status: "cancelled",
                progress: 100,
                error: latestJob.error ?? "Cancelled by user",
            });
        }
    }

    private async ensureRunnable(jobId: string): Promise<StoredImportJob> {
        const job = await importJobStore.getJob(jobId);
        if (!job || job.status === "cancelled" || job.status === "cancelling") {
            throw new ImportJobCancelledError("Import job is cancelled");
        }
        if (isTerminalStatus(job.status)) {
            throw new ImportJobCancelledError("Import job is already terminal");
        }
        return job;
    }
}

/** Shared queue-backed runner used by import routes and workers. */
export const genericImportJobRunner = new GenericImportJobRunner();
