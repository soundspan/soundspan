const mockResolveAlbumDownloadRouting = jest.fn();
const mockDownloadJobFindUnique = jest.fn();
const mockDownloadJobUpdate = jest.fn();
const mockDownloadJobUpdateMany = jest.fn();
const mockRunWithSchedulerClaim = jest.fn();
const mockExtendSchedulerClaim = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();
const mockProcessTidalDownload = jest.fn();
const mockProcessYoutubeDownload = jest.fn();
const mockStartDownload = jest.fn();

jest.mock("../../../services/downloadDispatcher", () => ({
    ...jest.requireActual("../../../services/downloadDispatcher"),
    resolveAlbumDownloadRouting: (...args: unknown[]) =>
        mockResolveAlbumDownloadRouting(...args),
}));

jest.mock("../../../services/downloadSourcePolicy", () => ({
    probeDownloadSourceAvailability: jest.fn(),
    resolveDownloadSource: jest.fn(),
}));

jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: (...args: unknown[]) =>
                mockDownloadJobFindUnique(...args),
            update: (...args: unknown[]) => mockDownloadJobUpdate(...args),
            updateMany: (...args: unknown[]) =>
                mockDownloadJobUpdateMany(...args),
        },
    },
}));

jest.mock("../../../utils/schedulerClaim", () => ({
    extendSchedulerClaim: (...args: unknown[]) =>
        mockExtendSchedulerClaim(...args),
    runWithSchedulerClaim: (...args: unknown[]) =>
        mockRunWithSchedulerClaim(...args),
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({
            info: mockLoggerInfo,
            error: mockLoggerError,
        }),
    },
}));

jest.mock("../../../services/tidalLibraryDownload", () => ({
    processTidalDownload: (...args: unknown[]) =>
        mockProcessTidalDownload(...args),
}));

jest.mock("../../../services/youtubeLibraryDownload", () => ({
    processYoutubeDownload: (...args: unknown[]) =>
        mockProcessYoutubeDownload(...args),
}));

jest.mock("../../../services/simpleDownloadManager", () => ({
    simpleDownloadManager: {
        startDownload: (...args: unknown[]) => mockStartDownload(...args),
    },
}));

import {
    AlbumDownloadFailedError,
    finalizeAlbumDownloadQueueFailure,
    processAlbumDownload,
} from "../albumDownloadProcessor";

const payload = {
    jobId: "download-job-1",
    type: "album",
    mbid: "release-group-1",
    subject: "Artist - Album",
    artistName: "Artist",
    albumTitle: "Album",
    artistMbid: "artist-mbid-1",
} as const;
const availability = {
    tidal: true,
    lidarr: true,
    soulseek: true,
    youtube: true,
} as const;
const routingJob = {
    id: payload.jobId,
    userId: "user-1",
    metadata: { preserved: true },
};

function dispatchRouting(source: "tidal" | "youtube" | "lidarr") {
    return {
        kind: "dispatch" as const,
        source,
        availability,
        job: routingJob,
        names: { artist: "Artist", album: "Album" },
        userId: "user-1",
    };
}

describe("album download queue processor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveAlbumDownloadRouting.mockResolvedValue(
            dispatchRouting("tidal"),
        );
        mockDownloadJobFindUnique.mockResolvedValue({ status: "processing" });
        mockDownloadJobUpdate.mockResolvedValue({});
        mockDownloadJobUpdateMany.mockResolvedValue({ count: 1 });
        mockExtendSchedulerClaim.mockResolvedValue(true);
        mockProcessTidalDownload.mockResolvedValue(undefined);
        mockProcessYoutubeDownload.mockResolvedValue(undefined);
        mockStartDownload.mockResolvedValue({ success: true });
        mockRunWithSchedulerClaim.mockImplementation(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: (claimToken: string) => Promise<void>,
            ) => ({ acquired: true, value: await operation("claim-token") }),
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("acquires the claim before dispatching a TIDAL-routed album", async () => {
        const ordering: string[] = [];
        mockProcessTidalDownload.mockImplementationOnce(async () => {
            ordering.push("dispatch");
        });
        mockRunWithSchedulerClaim.mockImplementationOnce(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: (claimToken: string) => Promise<void>,
            ) => {
                ordering.push("acquired");
                return {
                    acquired: true,
                    value: await operation("claim-token"),
                };
            },
        );
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await processAlbumDownload(job);

        expect(mockResolveAlbumDownloadRouting).toHaveBeenCalledWith(payload);
        expect(mockRunWithSchedulerClaim).toHaveBeenCalledWith(
            "scheduler-claim:album-download",
            15 * 60_000,
            "album download",
            expect.any(Function),
        );
        expect(mockProcessTidalDownload).toHaveBeenCalledWith(
            payload.jobId,
            "Artist",
            "Album",
            "user-1",
        );
        expect(ordering).toEqual(["acquired", "dispatch"]);
        expect(job.progress).toHaveBeenNthCalledWith(1, 0);
        expect(job.progress).toHaveBeenNthCalledWith(2, 100);
    });

    it("acquires the claim before dispatching a YouTube-routed album", async () => {
        const ordering: string[] = [];
        mockResolveAlbumDownloadRouting.mockResolvedValueOnce(
            dispatchRouting("youtube"),
        );
        mockProcessYoutubeDownload.mockImplementationOnce(async () => {
            ordering.push("dispatch");
        });
        mockRunWithSchedulerClaim.mockImplementationOnce(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: (claimToken: string) => Promise<void>,
            ) => {
                ordering.push("acquired");
                return {
                    acquired: true,
                    value: await operation("claim-token"),
                };
            },
        );
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await processAlbumDownload(job);

        expect(mockRunWithSchedulerClaim).toHaveBeenCalledTimes(1);
        expect(mockProcessYoutubeDownload).toHaveBeenCalledWith(
            payload.jobId,
            "Artist",
            "Album",
            "user-1",
        );
        expect(ordering).toEqual(["acquired", "dispatch"]);
    });

    it("dispatches a Lidarr-routed album through the manager without a claim", async () => {
        mockResolveAlbumDownloadRouting.mockResolvedValueOnce(
            dispatchRouting("lidarr"),
        );
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await processAlbumDownload(job);

        expect(mockRunWithSchedulerClaim).not.toHaveBeenCalled();
        expect(mockExtendSchedulerClaim).not.toHaveBeenCalled();
        expect(mockStartDownload).toHaveBeenCalledWith(
            payload.jobId,
            "Artist",
            "Album",
            payload.mbid,
            "user-1",
            false,
            payload.artistMbid,
        );
    });

    it("persists a failed resolution without a claim", async () => {
        mockResolveAlbumDownloadRouting.mockResolvedValueOnce({
            kind: "fail",
            job: routingJob,
            resolution: {
                kind: "fail",
                source: "tidal",
                error: "Download source unavailable",
                statusText: "tidal unavailable — skipped",
            },
        });
        mockDownloadJobFindUnique
            .mockResolvedValueOnce({ status: "pending" })
            .mockResolvedValueOnce({ status: "failed" });
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processAlbumDownload(job)).rejects.toBeInstanceOf(
            AlbumDownloadFailedError,
        );

        expect(mockRunWithSchedulerClaim).not.toHaveBeenCalled();
        expect(mockExtendSchedulerClaim).not.toHaveBeenCalled();
        expect(mockDownloadJobUpdate).toHaveBeenCalledWith({
            where: { id: payload.jobId },
            data: {
                status: "failed",
                error: "Download source unavailable",
                completedAt: expect.any(Date),
                metadata: {
                    preserved: true,
                    currentSource: "tidal",
                    statusText: "tidal unavailable — skipped",
                    failedAt: expect.any(String),
                },
            },
        });
    });

    it("drains a slow renewal before releasing and starts none post-release", async () => {
        jest.useFakeTimers();
        let finishDispatch!: () => void;
        let finishRenewal!: () => void;
        const ordering: string[] = [];
        mockProcessTidalDownload.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishDispatch = resolve;
                }),
        );
        mockExtendSchedulerClaim.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    ordering.push("renewal-started");
                    finishRenewal = () => {
                        ordering.push("renewal-finished");
                        resolve(true);
                    };
                }),
        );
        mockRunWithSchedulerClaim.mockImplementationOnce(
            async (
                _claimKey: string,
                _ttlMs: number,
                _operationName: string,
                operation: (claimToken: string) => Promise<void>,
            ) => {
                await operation("claim-token");
                ordering.push("release");
                return { acquired: true, value: undefined };
            },
        );
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        const processing = processAlbumDownload(job);
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockExtendSchedulerClaim).toHaveBeenCalledWith(
            "scheduler-claim:album-download",
            "claim-token",
            15 * 60_000,
        );

        finishDispatch();
        await jest.advanceTimersByTimeAsync(0);
        expect(ordering).toEqual(["renewal-started"]);
        expect(job.progress).toHaveBeenCalledTimes(1);

        finishRenewal();
        await processing;
        expect(ordering).toEqual([
            "renewal-started",
            "renewal-finished",
            "release",
        ]);

        await jest.advanceTimersByTimeAsync(5 * 60_000);
        expect(mockExtendSchedulerClaim).toHaveBeenCalledTimes(1);
    });

    it("rejects poison payloads before invoking dispatch", async () => {
        const job = {
            data: { ...payload, type: "artist", unexpected: true },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processAlbumDownload(job)).rejects.toThrow();

        expect(mockResolveAlbumDownloadRouting).not.toHaveBeenCalled();
        expect(job.progress).not.toHaveBeenCalled();
    });

    it("rejects poison payloads before dispatch", async () => {
        const job = {
            data: { ...payload, unexpected: true },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processAlbumDownload(job)).rejects.toThrow();

        expect(mockResolveAlbumDownloadRouting).not.toHaveBeenCalled();
        expect(job.progress).not.toHaveBeenCalled();
    });

    it("propagates dispatcher rejection without reporting completion", async () => {
        const error = new Error("sidecar unavailable");
        mockProcessTidalDownload.mockRejectedValueOnce(error);
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processAlbumDownload(job)).rejects.toBe(error);

        expect(job.progress).toHaveBeenCalledTimes(1);
        expect(job.progress).toHaveBeenCalledWith(0);
    });

    it("skips dispatch when a stalled redelivery finds a completed row", async () => {
        mockDownloadJobFindUnique.mockResolvedValueOnce({
            status: "completed",
        });
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await processAlbumDownload(job);

        expect(mockResolveAlbumDownloadRouting).not.toHaveBeenCalled();
        expect(mockRunWithSchedulerClaim).not.toHaveBeenCalled();
        expect(mockDownloadJobFindUnique).toHaveBeenCalledTimes(1);
        expect(mockLoggerInfo).toHaveBeenCalledWith(
            "Skipping completed album download redelivery",
            { jobId: payload.jobId },
        );
    });

    it("throws a typed failure when dispatch persists failed status", async () => {
        mockDownloadJobFindUnique
            .mockResolvedValueOnce({ status: "pending" })
            .mockResolvedValueOnce({ status: "processing" })
            .mockResolvedValueOnce({ status: "failed" });
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processAlbumDownload(job)).rejects.toBeInstanceOf(
            AlbumDownloadFailedError,
        );

        expect(mockProcessTidalDownload).toHaveBeenCalledTimes(1);
        expect(job.progress).toHaveBeenCalledTimes(1);
    });

    it("waits for a busy deployment claim and dispatches after acquisition", async () => {
        jest.useFakeTimers();
        mockRunWithSchedulerClaim
            .mockResolvedValueOnce({ acquired: false })
            .mockImplementationOnce(
                async (
                    _claimKey: string,
                    _ttlMs: number,
                    _operationName: string,
                    operation: (claimToken: string) => Promise<void>,
                ) => ({
                    acquired: true,
                    value: await operation("claim-token"),
                }),
            );
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        const processing = processAlbumDownload(job);
        await Promise.resolve();
        expect(mockProcessTidalDownload).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(15_000);
        await processing;

        expect(mockRunWithSchedulerClaim).toHaveBeenCalledTimes(2);
        expect(mockProcessTidalDownload).toHaveBeenCalledTimes(1);
    });

    it("throws after the bounded deployment-claim wait is exhausted", async () => {
        jest.useFakeTimers();
        mockRunWithSchedulerClaim.mockResolvedValue({ acquired: false });
        const job = {
            data: payload,
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        const processing = processAlbumDownload(job);
        const rejection = expect(processing).rejects.toThrow(
            "Timed out waiting for the album download claim",
        );
        await jest.runAllTimersAsync();
        await rejection;

        expect(mockRunWithSchedulerClaim).toHaveBeenCalledTimes(960);
        expect(mockProcessTidalDownload).not.toHaveBeenCalled();
    });

    it("finalizes an additive poison payload when it still carries a valid job id", async () => {
        const job = {
            data: {
                jobId: payload.jobId,
                type: "future-album-version",
                additiveField: true,
            },
        } as any;

        await finalizeAlbumDownloadQueueFailure(
            job,
            new Error("poison payload"),
            "failed",
        );

        expect(mockDownloadJobUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: payload.jobId }),
            }),
        );
    });

    it("marks a non-terminal persisted job failed after Bull exhausts retries", async () => {
        const job = {
            data: payload,
            getState: jest.fn().mockResolvedValue("failed"),
        } as any;

        await finalizeAlbumDownloadQueueFailure(job, new Error("raw failure"));

        expect(job.getState).toHaveBeenCalledTimes(1);
        expect(mockDownloadJobUpdateMany).toHaveBeenCalledWith({
            where: {
                id: payload.jobId,
                status: { in: ["pending", "processing"] },
            },
            data: {
                status: "failed",
                error: "Download failed",
                completedAt: expect.any(Date),
            },
        });
    });

    it("marks an artist expansion row failed after Bull exhausts retries", async () => {
        const job = {
            data: {
                jobId: "artist-job-1",
                artistMbid: "artist-mbid-1",
                artistName: "Artist",
                downloadType: "library",
                rootFolderPath: "/music",
                userId: "user-1",
            },
            getState: jest.fn().mockResolvedValue("failed"),
        } as any;

        await finalizeAlbumDownloadQueueFailure(job, new Error("raw failure"));

        expect(mockDownloadJobUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "artist-job-1",
                status: { in: ["pending", "processing"] },
            },
            data: {
                status: "failed",
                error: "Download failed",
                completedAt: expect.any(Date),
            },
        });
    });

    it("leaves a terminal persisted job unchanged", async () => {
        mockDownloadJobUpdateMany.mockResolvedValueOnce({ count: 0 });
        const job = {
            data: payload,
            getState: jest.fn().mockResolvedValue("failed"),
        } as any;

        await expect(
            finalizeAlbumDownloadQueueFailure(job, new Error("raw failure")),
        ).resolves.toBeUndefined();

        expect(mockDownloadJobUpdateMany).toHaveBeenCalledTimes(1);
    });

    it("re-checks Bull state and skips jobs that are still retrying", async () => {
        const job = {
            data: payload,
            getState: jest.fn().mockResolvedValue("delayed"),
        } as any;

        await finalizeAlbumDownloadQueueFailure(job, new Error("retrying"));

        expect(job.getState).toHaveBeenCalledTimes(1);
        expect(mockDownloadJobUpdateMany).not.toHaveBeenCalled();
    });

    it("logs and survives persistence rejection", async () => {
        const persistenceError = new Error("database unavailable");
        mockDownloadJobUpdateMany.mockRejectedValueOnce(persistenceError);
        const job = {
            id: "bull-job-1",
            data: payload,
            getState: jest.fn().mockResolvedValue("failed"),
        } as any;

        await expect(
            finalizeAlbumDownloadQueueFailure(job, new Error("raw failure")),
        ).resolves.toBeUndefined();

        expect(mockLoggerError).toHaveBeenCalledWith(
            "Failed to persist exhausted album download queue failure",
            { jobId: payload.jobId, error: persistenceError },
        );
    });
});
