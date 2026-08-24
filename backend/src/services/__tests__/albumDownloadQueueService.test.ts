const mockQueueAdd = jest.fn();
const mockQueueGetJob = jest.fn();
const mockDownloadJobFindMany = jest.fn();
const mockDownloadJobUpdate = jest.fn();
const mockDownloadJobUpdateMany = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("../../workers/queues", () => ({
    albumDownloadQueue: {
        add: (...args: unknown[]) => mockQueueAdd(...args),
        getJob: (...args: unknown[]) => mockQueueGetJob(...args),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findMany: (...args: unknown[]) => mockDownloadJobFindMany(...args),
            update: (...args: unknown[]) => mockDownloadJobUpdate(...args),
            updateMany: (...args: unknown[]) =>
                mockDownloadJobUpdateMany(...args),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: mockLoggerDebug,
            error: mockLoggerError,
        }),
    },
}));

import {
    enqueueAlbumDownload,
    enqueueAlbumDownloadInBackground,
    recoverUnqueuedAlbumDownloads,
} from "../albumDownloadQueueService";
import {
    ALBUM_DOWNLOAD_QUEUE_OWNER,
    isAlbumDownloadQueueOwned,
} from "../albumDownloadQueueOwnership";

const payload = {
    jobId: "download-job-1",
    type: "album",
    mbid: "release-group-1",
    subject: "Artist - Album",
    artistName: "Artist",
    albumTitle: "Album",
} as const;

describe("album download queue service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQueueAdd.mockResolvedValue({ id: "albumdl:download-job-1" });
        mockQueueGetJob.mockResolvedValue(null);
        mockDownloadJobFindMany.mockResolvedValue([]);
        mockDownloadJobUpdate.mockResolvedValue({});
        mockDownloadJobUpdateMany.mockResolvedValue({ count: 1 });
    });

    it("recognizes only the album-download queue ownership marker", () => {
        expect(
            isAlbumDownloadQueueOwned({
                queuedVia: ALBUM_DOWNLOAD_QUEUE_OWNER,
            }),
        ).toBe(true);
        expect(isAlbumDownloadQueueOwned({ queuedVia: "legacy" })).toBe(false);
        expect(isAlbumDownloadQueueOwned(null)).toBe(false);
    });

    it("enqueues the payload with a stable Bull deduplication id", async () => {
        await enqueueAlbumDownload(payload);

        expect(mockQueueAdd).toHaveBeenCalledWith("album-download", payload, {
            jobId: "albumdl:download-job-1",
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith("Album download queued", {
            jobId: payload.jobId,
            queueJobId: "albumdl:download-job-1",
        });
    });

    it("marks the persisted job failed with a static error and rethrows enqueue failure", async () => {
        const enqueueError = new Error("redis unavailable");
        mockQueueAdd.mockRejectedValueOnce(enqueueError);

        await expect(enqueueAlbumDownload(payload)).rejects.toBe(enqueueError);

        expect(mockDownloadJobUpdate).toHaveBeenCalledWith({
            where: { id: payload.jobId },
            data: {
                status: "failed",
                error: "Download queue unavailable",
                completedAt: expect.any(Date),
            },
        });
    });

    it("observes failure-persistence rejection and still rethrows enqueue failure", async () => {
        const enqueueError = new Error("redis unavailable");
        const persistenceError = new Error("database unavailable");
        mockQueueAdd.mockRejectedValueOnce(enqueueError);
        mockDownloadJobUpdate.mockRejectedValueOnce(persistenceError);

        await expect(enqueueAlbumDownload(payload)).rejects.toBe(enqueueError);

        expect(mockLoggerError).toHaveBeenCalledWith(
            "Failed to persist album download queue admission failure",
            { jobId: payload.jobId, error: persistenceError },
        );
    });

    it("swallows background enqueue rejection after final logging", async () => {
        const enqueueError = new Error("redis unavailable");
        mockQueueAdd.mockRejectedValueOnce(enqueueError);

        enqueueAlbumDownloadInBackground(payload);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(mockLoggerError).toHaveBeenCalledWith(
            "Album download enqueue failed",
            { jobId: payload.jobId, error: enqueueError },
        );
    });

    it("recovers only the first twenty stale pending uncleared album jobs", async () => {
        const now = new Date("2026-08-24T18:00:00.000Z");
        const candidates = [
            ...Array.from({ length: 22 }, (_, index) => ({
                id: `stale-${index}`,
                type: "album",
                status: "pending",
                cleared: false,
                createdAt: new Date(now.getTime() - 6 * 60_000 - index),
                targetMbid: `rg-${index}`,
                subject: `Artist ${index} - Album ${index}`,
                metadata: {
                    artistName: `Artist ${index}`,
                    albumTitle: `Album ${index}`,
                    queuedVia: ALBUM_DOWNLOAD_QUEUE_OWNER,
                },
            })),
            {
                id: "fresh",
                type: "album",
                status: "pending",
                cleared: false,
                createdAt: new Date(now.getTime() - 4 * 60_000),
                targetMbid: "rg-fresh",
                subject: "Fresh",
                metadata: { queuedVia: ALBUM_DOWNLOAD_QUEUE_OWNER },
            },
            {
                id: "legacy-album",
                type: "album",
                status: "pending",
                cleared: false,
                createdAt: new Date(now.getTime() - 20 * 60_000),
                targetMbid: "legacy-album-mbid",
                subject: "Legacy Album",
                metadata: {},
            },
            {
                id: "artist",
                type: "artist",
                status: "pending",
                cleared: false,
                createdAt: new Date(now.getTime() - 20 * 60_000),
                targetMbid: "artist-mbid",
                subject: "Artist",
                metadata: {},
            },
            {
                id: "processing",
                type: "album",
                status: "processing",
                cleared: false,
                createdAt: new Date(now.getTime() - 20 * 60_000),
                targetMbid: "rg-processing",
                subject: "Processing",
                metadata: {},
            },
            {
                id: "terminal",
                type: "album",
                status: "failed",
                cleared: false,
                createdAt: new Date(now.getTime() - 20 * 60_000),
                targetMbid: "rg-terminal",
                subject: "Terminal",
                metadata: {},
            },
            {
                id: "cleared",
                type: "album",
                status: "pending",
                cleared: true,
                createdAt: new Date(now.getTime() - 20 * 60_000),
                targetMbid: "rg-cleared",
                subject: "Cleared",
                metadata: {},
            },
        ];
        mockDownloadJobFindMany.mockImplementationOnce((args) =>
            candidates
                .filter(
                    (candidate) =>
                        candidate.type === args.where.type &&
                        candidate.status === args.where.status &&
                        candidate.cleared === args.where.cleared &&
                        candidate.createdAt < args.where.createdAt.lt &&
                        candidate.metadata.queuedVia ===
                            args.where.metadata.equals,
                )
                .sort(
                    (left, right) =>
                        left.createdAt.getTime() - right.createdAt.getTime(),
                )
                .slice(0, args.take),
        );

        const recovered = await recoverUnqueuedAlbumDownloads(now);

        expect(recovered).toBe(20);
        expect(mockQueueAdd).toHaveBeenCalledTimes(20);
        expect(mockQueueAdd).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ jobId: "fresh" }),
            expect.anything(),
        );
        expect(mockQueueAdd).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ jobId: "legacy-album" }),
            expect.anything(),
        );
        expect(mockQueueAdd).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ jobId: "artist" }),
            expect.anything(),
        );
        expect(mockQueueAdd).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ jobId: "processing" }),
            expect.anything(),
        );
        expect(mockQueueAdd).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ jobId: "terminal" }),
            expect.anything(),
        );
        expect(mockDownloadJobFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    type: "album",
                    status: "pending",
                    cleared: false,
                    createdAt: { lt: new Date("2026-08-24T17:55:00.000Z") },
                    metadata: {
                        path: ["queuedVia"],
                        equals: ALBUM_DOWNLOAD_QUEUE_OWNER,
                    },
                },
                take: 20,
            }),
        );
    });

    it.each<[string, "skip" | "finalize-and-remove" | "remove-and-re-enqueue"]>(
        [
            ["waiting", "skip"],
            ["active", "skip"],
            ["delayed", "skip"],
            ["paused", "skip"],
            ["failed", "finalize-and-remove"],
            ["completed", "remove-and-re-enqueue"],
            ["stuck", "remove-and-re-enqueue"],
        ],
    )("handles Bull state %s with %s", async (state, expectedAction) => {
        const remove = jest.fn().mockResolvedValue(undefined);
        mockDownloadJobFindMany.mockResolvedValueOnce([
            {
                id: "existing-job",
                targetMbid: "rg-existing",
                subject: "Artist - Album",
                metadata: {},
            },
        ]);
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue(state),
            remove,
        });

        await recoverUnqueuedAlbumDownloads();

        if (expectedAction === "skip") {
            expect(mockQueueAdd).not.toHaveBeenCalled();
            expect(mockDownloadJobUpdateMany).not.toHaveBeenCalled();
            expect(remove).not.toHaveBeenCalled();
            return;
        }

        if (expectedAction === "finalize-and-remove") {
            expect(mockDownloadJobUpdateMany).toHaveBeenCalledWith({
                where: {
                    id: "existing-job",
                    status: { in: ["pending", "processing"] },
                },
                data: {
                    status: "failed",
                    error: "Download failed",
                    completedAt: expect.any(Date),
                },
            });
            expect(remove).toHaveBeenCalledTimes(1);
            expect(
                mockDownloadJobUpdateMany.mock.invocationCallOrder[0],
            ).toBeLessThan(remove.mock.invocationCallOrder[0]);
            expect(mockQueueAdd).not.toHaveBeenCalled();
            return;
        }

        expect(mockDownloadJobUpdateMany).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(mockQueueAdd).toHaveBeenCalledWith(
            "album-download",
            expect.objectContaining({ jobId: "existing-job" }),
            { jobId: "albumdl:existing-job" },
        );
        expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
            mockQueueAdd.mock.invocationCallOrder[0],
        );
    });

    it("removes and re-enqueues a recovered row with an unknown Bull state", async () => {
        const remove = jest.fn().mockResolvedValue(undefined);
        mockDownloadJobFindMany.mockResolvedValueOnce([
            {
                id: "unknown-state-job",
                targetMbid: "rg-unknown",
                subject: "Artist - Album",
                metadata: {},
            },
        ]);
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("unknown"),
            remove,
        });

        await recoverUnqueuedAlbumDownloads();

        expect(remove).toHaveBeenCalledTimes(1);
        expect(mockQueueAdd).toHaveBeenCalledWith(
            "album-download",
            expect.objectContaining({ jobId: "unknown-state-job" }),
            { jobId: "albumdl:unknown-state-job" },
        );
    });

    it("logs orphan cleanup errors and still attempts re-enqueue", async () => {
        const cleanupError = new Error("remove failed");
        mockDownloadJobFindMany.mockResolvedValueOnce([
            {
                id: "completed-job",
                targetMbid: "rg-completed",
                subject: "Artist - Album",
                metadata: {},
            },
        ]);
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("completed"),
            remove: jest.fn().mockRejectedValue(cleanupError),
        });

        await expect(recoverUnqueuedAlbumDownloads()).resolves.toBe(1);

        expect(mockLoggerError).toHaveBeenCalledWith(
            "Failed to remove incoherent album download queue job",
            { jobId: "completed-job", error: cleanupError },
        );
        expect(mockQueueAdd).toHaveBeenCalledWith(
            "album-download",
            expect.objectContaining({ jobId: "completed-job" }),
            { jobId: "albumdl:completed-job" },
        );
    });

    it("logs retained failed Bull job cleanup errors and continues", async () => {
        const cleanupError = new Error("remove failed");
        mockDownloadJobFindMany.mockResolvedValueOnce([
            {
                id: "failed-job",
                targetMbid: "rg-failed",
                subject: "Artist - Album",
                metadata: {},
            },
        ]);
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("failed"),
            remove: jest.fn().mockRejectedValue(cleanupError),
        });

        await expect(recoverUnqueuedAlbumDownloads()).resolves.toBe(1);

        expect(mockLoggerError).toHaveBeenCalledWith(
            "Failed to finalize retained album download queue failure",
            { jobId: "failed-job", error: cleanupError },
        );
    });
});
