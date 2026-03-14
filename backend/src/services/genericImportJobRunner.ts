import { Prisma } from "@prisma/client";
import { importJobStore } from "./importJobStore";
import { playlistImportService } from "./playlistImportService";
import { logger } from "../utils/logger";

class ImportJobCancelledError extends Error {}

function isTerminalStatus(status: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Detached execution runner for generic import jobs.
 */
export class GenericImportJobRunner {
    private readonly inFlightJobs = new Set<string>();

    /**
     * Schedules an asynchronous run for the given import job id.
     */
    enqueue(jobId: string): void {
        setTimeout(() => {
            this.runJob(jobId).catch((error) => {
                logger.error("[ImportJobRunner] Unhandled run error:", error);
            });
        }, 0);
    }

    /**
     * Executes an import job with persisted progress and terminal state updates.
     */
    async runJob(jobId: string): Promise<void> {
        if (this.inFlightJobs.has(jobId)) return;
        this.inFlightJobs.add(jobId);

        try {
            const initialJob = await importJobStore.getJob(jobId);
            if (!initialJob || isTerminalStatus(initialJob.status)) {
                return;
            }

            const runnableJob = await this.ensureRunnable(jobId);
            await importJobStore.updateJob(jobId, {
                status: "resolving",
                progress: 20,
            });

            const preview = await playlistImportService.previewImport(
                runnableJob.userId,
                runnableJob.sourceUrl
            );

            await this.ensureRunnable(jobId);
            await importJobStore.updateJob(jobId, {
                status: "creating_playlist",
                progress: 70,
                summary: preview.summary,
                resolvedTracks: preview.resolved as unknown as Prisma.InputJsonValue,
            });

            const execution = await playlistImportService.importPlaylist(
                runnableJob.userId,
                preview,
                runnableJob.requestedPlaylistName ?? undefined
            );

            const latestJob = await importJobStore.getJob(jobId);
            const cancelledDuringImport =
                latestJob?.status === "cancelled" || latestJob?.status === "cancelling";

            await importJobStore.updateJob(jobId, {
                status: "completed",
                progress: 100,
                summary: execution.summary,
                createdPlaylistId: execution.playlistId,
                error:
                    cancelledDuringImport ?
                        "Cancellation requested after playlist creation completed"
                    :   null,
            });
        } catch (error) {
            if (error instanceof ImportJobCancelledError) {
                const latestJob = await importJobStore.getJob(jobId);
                if (latestJob?.status === "cancelling") {
                    await importJobStore.updateJob(jobId, {
                        status: "cancelled",
                        progress: 100,
                        error: latestJob.error ?? "Cancelled by user",
                    });
                }
                return;
            }

            const message =
                error instanceof Error ? error.message : "Generic import job failed";
            const latestJob = await importJobStore.getJob(jobId);
            if (latestJob && !isTerminalStatus(latestJob.status)) {
                await importJobStore.updateJob(jobId, {
                    status: "failed",
                    progress: 100,
                    error: message,
                });
            }
            logger.error(`[ImportJobRunner] Job ${jobId} failed:`, error);
        } finally {
            this.inFlightJobs.delete(jobId);
        }
    }

    private async ensureRunnable(jobId: string) {
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

/**
 * Shared singleton runner used by import job routes.
 */
export const genericImportJobRunner = new GenericImportJobRunner();
