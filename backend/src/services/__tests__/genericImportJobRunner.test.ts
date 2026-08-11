jest.mock("../../utils/logger", () => ({
    logger: (() => {
        const scopedLogger = {
            child: jest.fn(),
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        scopedLogger.child.mockReturnValue(scopedLogger);
        return scopedLogger;
    })(),
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        importJob: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../workers/queues", () => ({
    genericImportQueue: {
        add: jest.fn(),
        getJob: jest.fn(),
        isReady: jest.fn(),
    },
}));

jest.mock("../importJobStore", () => ({
    importJobStore: {
        getJob: jest.fn(),
        updateJob: jest.fn(),
    },
}));

jest.mock("../playlistImportService", () => ({
    playlistImportService: {
        previewImport: jest.fn(),
        importPlaylist: jest.fn(),
    },
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { genericImportQueue } from "../../workers/queues";
import { importJobStore } from "../importJobStore";
import { playlistImportService } from "../playlistImportService";
import { genericImportJobRunner } from "../genericImportJobRunner";

describe("generic import job runner", () => {
    const mockGetJob = importJobStore.getJob as jest.Mock;
    const mockUpdateJob = importJobStore.updateJob as jest.Mock;
    const mockPreviewImport = playlistImportService.previewImport as jest.Mock;
    const mockImportPlaylist =
        playlistImportService.importPlaylist as jest.Mock;
    const mockQueueAdd = genericImportQueue.add as jest.Mock;
    const mockQueueGetJob = genericImportQueue.getJob as jest.Mock;
    const mockQueueReady = genericImportQueue.isReady as jest.Mock;
    const mockFindMany = prisma.importJob.findMany as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockQueueAdd.mockResolvedValue({ id: "queued-job" });
        mockQueueGetJob.mockResolvedValue(null);
        mockQueueReady.mockResolvedValue(undefined);
        mockFindMany.mockResolvedValue([]);
    });

    it("durably enqueues a persisted job with a stable queue identity", async () => {
        genericImportJobRunner.enqueue("job-durable");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(mockQueueAdd).toHaveBeenCalledWith(
            "generic-import-run",
            { jobId: "job-durable" },
            { jobId: "job-durable" },
        );
    });

    it("coalesces duplicate submissions onto the existing durable queue job", async () => {
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("waiting"),
        });

        genericImportJobRunner.enqueue("job-already-queued");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(mockUpdateJob).not.toHaveBeenCalled();
    });

    it("logs queue persistence failures without leaking an unhandled rejection", async () => {
        const queueError = new Error("redis credentials rejected");
        mockQueueAdd.mockRejectedValueOnce(queueError);

        genericImportJobRunner.enqueue("job-queue-failure");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(logger.error).toHaveBeenCalledWith(
            "Failed to enqueue persisted import job",
            expect.objectContaining({
                jobId: "job-queue-failure",
                error: queueError,
            }),
        );
    });

    it("requeues a bounded batch of active persisted jobs for recovery", async () => {
        mockFindMany.mockResolvedValueOnce([
            { id: "pending-job" },
            { id: "resolving-job" },
            { id: "creating-job" },
            { id: "cancelling-job" },
        ]);

        await expect(genericImportJobRunner.recoverActiveJobs()).resolves.toBe(
            4,
        );

        expect(mockFindMany).toHaveBeenCalledWith({
            where: {
                status: {
                    in: [
                        "pending",
                        "resolving",
                        "creating_playlist",
                        "cancelling",
                    ],
                },
            },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            select: { id: true },
            take: 100,
        });
        expect(mockQueueAdd).toHaveBeenCalledTimes(4);
        expect(mockQueueAdd).toHaveBeenNthCalledWith(
            4,
            "generic-import-run",
            { jobId: "cancelling-job" },
            { jobId: "cancelling-job" },
        );
    });

    it("terminalizes stale persisted state when its queue retries were already exhausted", async () => {
        mockFindMany.mockResolvedValueOnce([{ id: "exhausted-job" }]);
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("failed"),
        });
        mockGetJob.mockResolvedValueOnce({
            id: "exhausted-job",
            status: "resolving",
        });

        await expect(genericImportJobRunner.recoverActiveJobs()).resolves.toBe(
            1,
        );

        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(mockUpdateJob).toHaveBeenCalledWith("exhausted-job", {
            status: "failed",
            progress: 100,
            error: "Generic import job failed",
        });
    });

    it("never requeues more than the recovery batch capacity in one sweep", async () => {
        mockFindMany.mockResolvedValueOnce(
            Array.from({ length: 101 }, (_, index) => ({
                id: `bounded-job-${index}`,
            })),
        );

        await expect(genericImportJobRunner.recoverActiveJobs()).resolves.toBe(
            100,
        );

        expect(mockQueueAdd).toHaveBeenCalledTimes(100);
        expect(mockQueueAdd).not.toHaveBeenCalledWith(
            "generic-import-run",
            { jobId: "bounded-job-100" },
            expect.anything(),
        );
    });

    it("registers bounded startup and periodic recovery jobs", async () => {
        await genericImportJobRunner.registerRecoveryJobs();

        expect(mockQueueReady).toHaveBeenCalledTimes(1);
        expect(mockQueueAdd).toHaveBeenNthCalledWith(
            1,
            "generic-import-recover",
            { trigger: "startup" },
            expect.objectContaining({
                jobId: "generic-import-recovery:startup",
                removeOnComplete: true,
                removeOnFail: true,
            }),
        );
        expect(mockQueueAdd).toHaveBeenNthCalledWith(
            2,
            "generic-import-recover",
            { trigger: "repeat" },
            expect.objectContaining({
                jobId: "generic-import-recovery:repeat",
                repeat: { every: 60_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            }),
        );
    });

    it("rethrows retryable failures without prematurely making the job terminal", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-retry",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        const retryableError = new Error("provider temporarily unavailable");
        mockPreviewImport.mockRejectedValueOnce(retryableError);

        await expect(
            genericImportJobRunner.runJob("job-retry", {
                retryFailures: true,
                finalAttempt: false,
            }),
        ).rejects.toBe(retryableError);

        expect(mockUpdateJob).not.toHaveBeenCalledWith(
            "job-retry",
            expect.objectContaining({ status: "failed" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "Import job attempt failed; queue retry remains",
            expect.objectContaining({
                jobId: "job-retry",
                error: retryableError,
            }),
        );
    });

    it("stores only a safe failure after queue retries are exhausted", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-final-attempt",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        const internalError = new Error(
            "postgresql://admin:secret@db/import failed",
        );
        mockPreviewImport.mockRejectedValueOnce(internalError);

        await expect(
            genericImportJobRunner.runJob("job-final-attempt", {
                retryFailures: true,
                finalAttempt: true,
            }),
        ).rejects.toBe(internalError);

        expect(mockUpdateJob).toHaveBeenLastCalledWith("job-final-attempt", {
            status: "failed",
            progress: 100,
            error: "Generic import job failed",
        });
        expect(logger.error).toHaveBeenCalledWith(
            "Import job failed",
            expect.objectContaining({
                jobId: "job-final-attempt",
                error: internalError,
            }),
        );
    });

    it("runs a pending import job through preview and playlist creation", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-1",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: "Roadtrip",
            status: "pending",
        });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [
                {
                    index: 0,
                    artist: "Artist",
                    title: "Song",
                    source: "local",
                    confidence: 100,
                    trackId: "track-1",
                },
            ],
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });
        mockImportPlaylist.mockResolvedValue({
            playlistId: "playlist-1",
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-1");

        expect(mockUpdateJob).toHaveBeenNthCalledWith(1, "job-1", {
            status: "resolving",
            progress: 20,
        });
        expect(mockPreviewImport).toHaveBeenCalledWith(
            "user-1",
            "https://open.spotify.com/playlist/abc",
        );
        expect(mockUpdateJob).toHaveBeenNthCalledWith(2, "job-1", {
            status: "creating_playlist",
            progress: 70,
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: [
                {
                    index: 0,
                    artist: "Artist",
                    title: "Song",
                    source: "local",
                    confidence: 100,
                    trackId: "track-1",
                },
            ],
        });
        expect(mockImportPlaylist).toHaveBeenCalledWith(
            "user-1",
            {
                playlistName: "Weekend Mix",
                resolved: [
                    {
                        index: 0,
                        artist: "Artist",
                        title: "Song",
                        source: "local",
                        confidence: 100,
                        trackId: "track-1",
                    },
                ],
                summary: {
                    total: 1,
                    local: 1,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            },
            "Roadtrip",
        );
        expect(mockUpdateJob).toHaveBeenNthCalledWith(3, "job-1", {
            status: "completed",
            progress: 100,
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            createdPlaylistId: "playlist-1",
            error: null,
        });
    });

    it("marks the job failed when preview resolution throws", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-1",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        mockPreviewImport.mockRejectedValue(new Error("preview failed"));

        await genericImportJobRunner.runJob("job-1");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockUpdateJob).toHaveBeenLastCalledWith("job-1", {
            status: "failed",
            progress: 100,
            error: "Generic import job failed",
        });
    });

    it("stops before playlist creation when the job is cancelled mid-flight", async () => {
        mockGetJob
            .mockResolvedValueOnce({
                id: "job-1",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-1",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-1",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelled",
            });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [],
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-1");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockUpdateJob).toHaveBeenCalledTimes(1);
        expect(mockUpdateJob).toHaveBeenCalledWith("job-1", {
            status: "resolving",
            progress: 20,
        });
    });

    it("marks the job cancelled when cancellation is requested before playlist creation starts", async () => {
        mockGetJob
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelling",
            })
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelling",
                createdPlaylistId: null,
            });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [],
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-2");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockUpdateJob).toHaveBeenNthCalledWith(2, "job-2", {
            status: "cancelled",
            progress: 100,
            error: "Cancelled by user",
        });
    });

    it("records completion when cancellation arrives after playlist creation starts", async () => {
        mockGetJob
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelling",
            });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [],
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });
        mockImportPlaylist.mockResolvedValue({
            playlistId: "playlist-late",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-3");

        expect(mockUpdateJob).toHaveBeenLastCalledWith("job-3", {
            status: "completed",
            progress: 100,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            createdPlaylistId: "playlist-late",
            error: "Cancellation requested after playlist creation completed",
        });
    });
});
