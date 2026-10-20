import type { ReconciliationSnapshot } from "../../services/lidarr";
import type { SchedulerTimeoutOperation } from "../../metrics/schedulerMetrics";
import type { RequireTimedOperation } from "../reconciliationCycle";

function createSnapshot(): ReconciliationSnapshot {
    return {
        queue: new Map(),
        albumsByMbid: new Map(),
        albumsByTitle: new Map(),
        fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
}

function createMocks() {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return {
        logger,
        prisma: {
            downloadJob: {
                findMany: jest.fn(async (): Promise<unknown[]> => []),
            },
        },
        lidarrService: {
            getReconciliationSnapshot: jest.fn(async () => createSnapshot()),
        },
        simpleDownloadManager: {
            markStaleJobsAsFailed: jest.fn(async () => 0),
            reconcileWithLidarr: jest.fn(async () => ({ reconciled: 0 })),
            syncWithLidarrQueue: jest.fn(async () => ({ cancelled: 0 })),
        },
        queueCleaner: {
            reconcileWithLocalLibrary: jest.fn(async () => ({ reconciled: 0 })),
        },
    };
}

function installMocks(mocks: ReturnType<typeof createMocks>): void {
    jest.doMock("../../utils/logger", () => ({ logger: mocks.logger }));
    jest.doMock("../../utils/db", () => ({ prisma: mocks.prisma }));
    jest.doMock("../../services/lidarr", () => ({
        lidarrService: mocks.lidarrService,
    }));
    jest.doMock("../../services/simpleDownloadManager", () => ({
        simpleDownloadManager: mocks.simpleDownloadManager,
    }));
    jest.doMock("../../jobs/queueCleaner", () => ({
        queueCleaner: mocks.queueCleaner,
    }));
}

function createRequireTimed(
    calls: Array<[SchedulerTimeoutOperation, number]>,
): RequireTimedOperation {
    return async <T>(
        operation: SchedulerTimeoutOperation,
        timeoutMs: number,
        work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
        calls.push([operation, timeoutMs]);
        return work(new AbortController().signal);
    };
}

describe("runReconciliationCycle", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("forwards the active-job scope to the Lidarr snapshot", async () => {
        const mocks = createMocks();
        const activeJobs = [
            {
                status: "processing",
                targetMbid: "target-mbid",
                metadata: {
                    lidarrMbid: "lidarr-mbid",
                    artistName: "Scope Artist",
                },
                subject: "Subject Artist - Subject Album",
                lidarrRef: "download-id",
            },
        ];
        mocks.prisma.downloadJob.findMany.mockResolvedValueOnce(activeJobs);
        installMocks(mocks);
        const { runReconciliationCycle } =
            await import("../reconciliationCycle");

        await runReconciliationCycle(createRequireTimed([]));

        expect(
            mocks.lidarrService.getReconciliationSnapshot,
        ).toHaveBeenCalledWith(
            {
                needsQueue: true,
                albumTargets: [
                    {
                        mbids: ["target-mbid", "lidarr-mbid"],
                        artistName: "Scope Artist",
                    },
                ],
            },
            expect.any(AbortSignal),
        );
    });

    it("runs the timed reconciliation steps in order", async () => {
        const mocks = createMocks();
        const calls: Array<[SchedulerTimeoutOperation, number]> = [];
        mocks.simpleDownloadManager.markStaleJobsAsFailed.mockResolvedValueOnce(
            1,
        );
        mocks.simpleDownloadManager.reconcileWithLidarr.mockResolvedValueOnce({
            reconciled: 2,
        });
        mocks.queueCleaner.reconcileWithLocalLibrary.mockResolvedValueOnce({
            reconciled: 3,
        });
        mocks.simpleDownloadManager.syncWithLidarrQueue.mockResolvedValueOnce({
            cancelled: 4,
        });
        installMocks(mocks);
        const { runReconciliationCycle } =
            await import("../reconciliationCycle");

        await runReconciliationCycle(createRequireTimed(calls));

        expect(calls).toEqual([
            ["getReconciliationSnapshot", 30_000],
            ["markStaleJobsAsFailed", 120_000],
            ["reconcileWithLidarr", 120_000],
            ["reconcileWithLocalLibrary", 120_000],
            ["syncWithLidarrQueue", 120_000],
        ]);
        expect(mocks.logger.debug.mock.calls).toEqual([
            ["Periodic cleanup: marked 1 stale download(s) as failed"],
            ["Periodic reconcile: 2 job(s) matched in Lidarr"],
            ["Periodic reconcile: 3 job(s) matched in local library"],
            ["Periodic sync: 4 job(s) synced with Lidarr queue"],
        ]);
    });

    it("runs only the local step after a snapshot failure", async () => {
        const mocks = createMocks();
        const calls: Array<[SchedulerTimeoutOperation, number]> = [];
        const snapshotError = new Error("snapshot failed");
        mocks.lidarrService.getReconciliationSnapshot.mockRejectedValueOnce(
            snapshotError,
        );
        installMocks(mocks);
        const { runReconciliationCycle } =
            await import("../reconciliationCycle");

        await expect(
            runReconciliationCycle(createRequireTimed(calls)),
        ).rejects.toBe(snapshotError);

        expect(calls).toEqual([
            ["getReconciliationSnapshot", 30_000],
            ["reconcileWithLocalLibrary", 120_000],
        ]);
        expect(
            mocks.queueCleaner.reconcileWithLocalLibrary,
        ).toHaveBeenCalledTimes(1);
        expect(
            mocks.simpleDownloadManager.markStaleJobsAsFailed,
        ).not.toHaveBeenCalled();
        expect(
            mocks.simpleDownloadManager.reconcileWithLidarr,
        ).not.toHaveBeenCalled();
        expect(
            mocks.simpleDownloadManager.syncWithLidarrQueue,
        ).not.toHaveBeenCalled();
    });

    it("logs a local failure and rethrows the snapshot error", async () => {
        const mocks = createMocks();
        const snapshotError = new Error("snapshot failed");
        const localError = new Error("local failed");
        mocks.lidarrService.getReconciliationSnapshot.mockRejectedValueOnce(
            snapshotError,
        );
        mocks.queueCleaner.reconcileWithLocalLibrary.mockRejectedValueOnce(
            localError,
        );
        installMocks(mocks);
        const { runReconciliationCycle } =
            await import("../reconciliationCycle");

        await expect(
            runReconciliationCycle(createRequireTimed([])),
        ).rejects.toBe(snapshotError);

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Local reconciliation failed after snapshot failure",
            { error: localError },
        );
    });
});
