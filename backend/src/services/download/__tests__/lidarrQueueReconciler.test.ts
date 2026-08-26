import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import {
    reconcileWithLidarr,
    syncWithLidarrQueue,
} from "../lidarrQueueReconciler";
import { discoverWeeklyService } from "../../discoverWeekly";

jest.mock("../../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
    },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lidarr/lidarrHttpClient", () => ({
    lidarrErrorLogFields: (error: unknown) => ({
        message: error instanceof Error ? error.message : undefined,
    }),
}));
jest.mock("../../lidarr", () => ({
    lidarrService: { isAlbumAvailableInSnapshot: jest.fn() },
}));
jest.mock("../../discoverWeekly", () => ({
    discoverWeeklyService: { checkBatchCompletion: jest.fn() },
}));

describe("lidarrQueueReconciler", () => {
    const mockPrisma = prisma as any;
    const mockLidarr = lidarrService as any;

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.downloadJob.update.mockResolvedValue({});
        mockPrisma.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    });

    it("reconciles available jobs by primary MBID and metadata Lidarr MBID", async () => {
        const snapshot = { queue: new Map() } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("primary", "download-1", "primary-mbid", {}),
            makeJob("fallback", "download-2", "missing", {
                lidarrMbid: "lidarr-mbid",
            }),
        ]);
        mockLidarr.isAlbumAvailableInSnapshot.mockImplementation(
            (_snapshot: unknown, mbid: string) =>
                mbid === "primary-mbid" || mbid === "lidarr-mbid",
        );

        await expect(reconcileWithLidarr(snapshot)).resolves.toEqual({
            reconciled: 2,
            errors: [],
            snapshot,
        });
        expect(mockPrisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["primary", "fallback"] } },
            }),
        );
    });

    it("applies the three-check grace period before failing a missing queue item", async () => {
        const snapshot = { queue: new Map() } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("second-check", "missing-1", "album-1", {
                queueSyncMissingCount: 1,
            }),
            makeJob("third-check", "missing-2", "album-2", {
                queueSyncMissingCount: 2,
            }),
        ]);
        mockLidarr.isAlbumAvailableInSnapshot.mockReturnValue(false);

        await expect(syncWithLidarrQueue(snapshot)).resolves.toEqual({
            cancelled: 1,
            errors: [],
        });
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "second-check" },
                data: {
                    metadata: expect.objectContaining({
                        queueSyncMissingCount: 2,
                    }),
                },
            }),
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "third-check" },
                data: expect.objectContaining({
                    status: "failed",
                    lidarrRef: null,
                }),
            }),
        );
    });

    it("reconciles availability by parsed artist and album subject", async () => {
        const snapshot = { queue: new Map() } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            {
                ...makeJob("parsed", "download-1", null as never, {}),
                subject: "Parsed Artist - Parsed Album",
            },
        ]);
        mockLidarr.isAlbumAvailableInSnapshot.mockImplementation(
            (
                _snapshot: unknown,
                _mbid: string | undefined,
                artist: string | undefined,
                album: string | undefined,
            ) => artist === "Parsed Artist" && album === "Parsed Album",
        );

        await expect(reconcileWithLidarr(snapshot)).resolves.toEqual({
            reconciled: 1,
            errors: [],
            snapshot,
        });
    });

    it("checks discovery completion for every reconciled batch", async () => {
        const snapshot = { queue: new Map() } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            {
                ...makeJob("discovery", "download-1", "album-1", {}),
                discoveryBatchId: "batch-1",
            },
        ]);
        mockLidarr.isAlbumAvailableInSnapshot.mockReturnValue(true);

        await reconcileWithLidarr(snapshot);

        expect(discoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-1",
        );
    });

    it("resets the missing counter when the tracked download returns", async () => {
        const snapshot = {
            queue: new Map([["download-1", { downloadId: "download-1" }]]),
        } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("reset", "download-1", "album-1", {
                queueSyncMissingCount: 2,
            }),
        ]);

        await syncWithLidarrQueue(snapshot);

        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "reset" },
                data: {
                    metadata: expect.objectContaining({
                        queueSyncMissingCount: 0,
                        lastQueueSyncFound: expect.any(String),
                    }),
                },
            }),
        );
    });

    it("adopts a replacement queue download after three missing checks", async () => {
        const snapshot = {
            queue: new Map([
                [
                    "replacement-download",
                    {
                        downloadId: "replacement-download",
                        title: "Artist - Album WEB",
                    },
                ],
            ]),
        } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("replacement", "old-download", "album-1", {
                artistName: "Artist",
                albumTitle: "Album",
                queueSyncMissingCount: 2,
            }),
        ]);

        await syncWithLidarrQueue(snapshot);

        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "replacement" },
                data: expect.objectContaining({
                    lidarrRef: "replacement-download",
                    metadata: expect.objectContaining({
                        previousDownloadId: "old-download",
                        replacementDetected: true,
                    }),
                }),
            }),
        );
    });

    it("completes an available album after its queue item disappears", async () => {
        const snapshot = { queue: new Map() } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("available", "missing-download", "available-album", {
                artistName: "Artist",
                albumTitle: "Album",
                queueSyncMissingCount: 2,
            }),
        ]);
        mockLidarr.isAlbumAvailableInSnapshot.mockReturnValue(true);

        await expect(syncWithLidarrQueue(snapshot)).resolves.toEqual({
            cancelled: 1,
            errors: [],
        });
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "available" },
                data: expect.objectContaining({ status: "completed" }),
            }),
        );
    });

    it("reports queue-sync write errors", async () => {
        const snapshot = { queue: new Map() } as never;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("write-error", "missing-download", "album-1", {
                queueSyncMissingCount: 2,
            }),
        ]);
        mockLidarr.isAlbumAvailableInSnapshot.mockReturnValue(false);
        mockPrisma.downloadJob.update.mockRejectedValue(
            new Error("write failed"),
        );

        await expect(syncWithLidarrQueue(snapshot)).resolves.toEqual({
            cancelled: 0,
            errors: ["write failed"],
        });
    });

    it("returns an empty reconciliation without requesting a snapshot", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);

        await expect(reconcileWithLidarr()).resolves.toEqual({
            reconciled: 0,
            errors: [],
        });
    });

    it("leaves reconciliation untouched when no snapshot is supplied", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("no-snapshot", "download-1", "album-1", {}),
        ]);

        await expect(reconcileWithLidarr()).resolves.toEqual({
            reconciled: 0,
            errors: [],
        });
        expect(mockPrisma.downloadJob.updateMany).not.toHaveBeenCalled();
    });

    it("returns an empty queue sync without requesting a snapshot", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);

        await expect(syncWithLidarrQueue()).resolves.toEqual({
            cancelled: 0,
            errors: [],
        });
    });

    it("leaves queue sync untouched when no snapshot is supplied", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("no-snapshot", "download-1", "album-1", {}),
        ]);

        await expect(syncWithLidarrQueue()).resolves.toEqual({
            cancelled: 0,
            errors: [],
        });
        expect(mockPrisma.downloadJob.update).not.toHaveBeenCalled();
    });

    function makeJob(
        id: string,
        lidarrRef: string,
        targetMbid: string | null,
        metadata: Record<string, unknown>,
    ) {
        return {
            id,
            status: "processing",
            lidarrRef,
            targetMbid,
            discoveryBatchId: null,
            subject: "Artist - Album",
            metadata,
            createdAt: new Date(),
        };
    }
});
