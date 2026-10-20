import { queueCleaner } from "../jobs/queueCleaner";
import type { SchedulerTimeoutOperation } from "../metrics/schedulerMetrics";
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../services/downloadJobStatus";
import {
    buildReconciliationScope,
    type ReconciliationScope,
} from "../services/download/reconciliationScope";
import type { ReconciliationSnapshot } from "../services/lidarr";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const log = logger.child("WorkerScheduler");
const SNAPSHOT_TIMEOUT_MS = 30_000;
const RECONCILIATION_STEP_TIMEOUT_MS = 120_000;

/** Runs one scheduler operation under the caller-owned timeout policy. */
export type RequireTimedOperation = <T>(
    operation: SchedulerTimeoutOperation,
    timeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

async function loadReconciliationScope(): Promise<ReconciliationScope> {
    const activeJobs = await prisma.downloadJob.findMany({
        where: { status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES } },
        select: {
            status: true,
            targetMbid: true,
            metadata: true,
            subject: true,
            lidarrRef: true,
        },
    });
    return buildReconciliationScope(activeJobs);
}

async function runReconciliationStep(
    requireTimed: RequireTimedOperation,
    operation: SchedulerTimeoutOperation,
    work: () => Promise<number>,
    message: string,
): Promise<void> {
    const count = await requireTimed(
        operation,
        RECONCILIATION_STEP_TIMEOUT_MS,
        work,
    );
    if (count === 0) return;
    log.debug(message.replace("{count}", String(count)));
}

async function loadReconciliationSnapshot(
    scope: ReconciliationScope,
    requireTimed: RequireTimedOperation,
): Promise<ReconciliationSnapshot> {
    const { lidarrService } = await import("../services/lidarr");
    return requireTimed(
        "getReconciliationSnapshot",
        SNAPSHOT_TIMEOUT_MS,
        (signal) => lidarrService.getReconciliationSnapshot(scope, signal),
    );
}

async function runLocalReconciliationStep(
    requireTimed: RequireTimedOperation,
): Promise<void> {
    await runReconciliationStep(
        requireTimed,
        "reconcileWithLocalLibrary",
        async () => (await queueCleaner.reconcileWithLocalLibrary()).reconciled,
        "Periodic reconcile: {count} job(s) matched in local library",
    );
}

async function runSnapshotSteps(
    snapshot: ReconciliationSnapshot,
    requireTimed: RequireTimedOperation,
): Promise<void> {
    await runReconciliationStep(
        requireTimed,
        "markStaleJobsAsFailed",
        () => simpleDownloadManager.markStaleJobsAsFailed(snapshot),
        "Periodic cleanup: marked {count} stale download(s) as failed",
    );
    await runReconciliationStep(
        requireTimed,
        "reconcileWithLidarr",
        async () =>
            (await simpleDownloadManager.reconcileWithLidarr(snapshot))
                .reconciled,
        "Periodic reconcile: {count} job(s) matched in Lidarr",
    );
    await runLocalReconciliationStep(requireTimed);
    await runReconciliationStep(
        requireTimed,
        "syncWithLidarrQueue",
        async () =>
            (await simpleDownloadManager.syncWithLidarrQueue(snapshot))
                .cancelled,
        "Periodic sync: {count} job(s) synced with Lidarr queue",
    );
}

/** Runs one download reconciliation cycle with scheduler-owned timeouts. */
export async function runReconciliationCycle(
    requireTimed: RequireTimedOperation,
): Promise<void> {
    const scope = await loadReconciliationScope();
    let snapshot: ReconciliationSnapshot;
    try {
        snapshot = await loadReconciliationSnapshot(scope, requireTimed);
    } catch (error) {
        await runLocalReconciliationStep(requireTimed).catch(
            (localError: unknown) => {
                log.error(
                    "Local reconciliation failed after snapshot failure",
                    { error: localError },
                );
            },
        );
        throw error;
    }
    await runSnapshotSteps(snapshot, requireTimed);
}
