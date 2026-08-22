import { logger } from "../utils/logger";
import { schedulerQueue } from "../workers/queues";

const QUEUE_CLEANER_JOB_NAME = "download-reconciliation-cycle";
const QUEUE_CLEANER_JOB_ID = "scheduler:reconciliation:on-demand";
/** Scoped logger retained by the system-settings queue-cleaner routes. */
export const queueCleanerLog = logger.child("SystemSettingsQueueCleaner");

type QueueCleanerWorkerStatus = {
    running: boolean;
    queued: boolean;
    state: string;
    jobId: string | null;
    workerOwned: true;
};

/** Builds the stable idle queue-cleaner status response. */
export function idleQueueCleanerWorkerStatus(): QueueCleanerWorkerStatus {
    return {
        running: false,
        queued: false,
        state: "idle",
        jobId: null,
        workerOwned: true,
    };
}

/** Maps one scheduler job to its public worker status. */
export async function getQueueCleanerWorkerStatus(
    job: Awaited<ReturnType<typeof schedulerQueue.getJob>>,
): Promise<QueueCleanerWorkerStatus> {
    if (!job) return idleQueueCleanerWorkerStatus();
    const state = await job.getState();
    return {
        running: state === "active",
        queued: ["waiting", "delayed", "paused"].includes(state),
        state,
        jobId: String(job.id),
        workerOwned: true,
    };
}

/** Loads current queue-cleaner status from the shared scheduler queue. */
export async function loadQueueCleanerWorkerStatus() {
    const job = await schedulerQueue.getJob(QUEUE_CLEANER_JOB_ID);
    return getQueueCleanerWorkerStatus(job);
}

/** Enqueues the coalesced queue-cleaner reconciliation job. */
export async function enqueueQueueCleanerWorkerJob() {
    return schedulerQueue.add(
        QUEUE_CLEANER_JOB_NAME,
        { mode: "repeat", source: "system-settings" },
        {
            jobId: QUEUE_CLEANER_JOB_ID,
            removeOnComplete: true,
            removeOnFail: 10,
        },
    );
}

/** Cancels an unclaimed queue-cleaner job without interrupting active work. */
export async function cancelQueuedQueueCleanerWorkerJob(): Promise<
    "absent" | "active" | "cancelled"
> {
    const job = await schedulerQueue.getJob(QUEUE_CLEANER_JOB_ID);
    if (!job) return "absent";
    const status = await getQueueCleanerWorkerStatus(job);
    if (status.running) return "active";
    await job.remove();
    return "cancelled";
}
