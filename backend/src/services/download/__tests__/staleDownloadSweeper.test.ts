import {
    classifyStaleDownloadJobs,
    IMPORT_TIMEOUT_MS,
    NO_SOURCE_TIMEOUT_MS,
    PENDING_TIMEOUT_MS,
    markStaleJobsAsFailed,
} from "../staleDownloadSweeper";
import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import { DownloadJobEvents } from "../downloadJobEvents";
import { discoverWeeklyService } from "../../discoverWeekly";

jest.mock("../../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            findFirst: jest.fn(),
        },
    },
}));
jest.mock("../../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
        child: jest.fn(() => ({ error: jest.fn() })),
    },
}));
jest.mock("../../../utils/async", () => ({
    yieldToEventLoop: jest.fn(async () => undefined),
}));
jest.mock("../../../utils/playlistLogger", () => ({ sessionLog: jest.fn() }));
jest.mock("../../lidarr", () => ({
    lidarrService: { isDownloadActiveInSnapshot: jest.fn() },
}));
jest.mock("../../lidarr/lidarrHttpClient", () => ({
    lidarrErrorLogFields: (error: unknown) => ({
        message: error instanceof Error ? error.message : undefined,
    }),
}));
jest.mock("../../discoverWeekly", () => ({
    discoverWeeklyService: { checkBatchCompletion: jest.fn() },
}));

describe("staleDownloadSweeper time-window decisions", () => {
    const now = new Date("2026-08-25T12:00:00.000Z");

    beforeEach(() => jest.clearAllMocks());

    afterEach(() => jest.useRealTimers());

    it("uses the pending, no-source, and import windows at their boundaries", () => {
        const jobs = [
            makeJob("pending-fresh", "pending", PENDING_TIMEOUT_MS - 1),
            makeJob("pending-stale", "pending", PENDING_TIMEOUT_MS + 1),
            makeJob("no-source-fresh", "processing", NO_SOURCE_TIMEOUT_MS - 1),
            makeJob("no-source-stale", "processing", NO_SOURCE_TIMEOUT_MS + 1),
            makeJob(
                "import-stale",
                "processing",
                IMPORT_TIMEOUT_MS + 1,
                "dl-1",
            ),
        ];

        const result = classifyStaleDownloadJobs(
            jobs as never,
            {} as never,
            now,
            () => ({ active: false }),
        );

        expect(result.stalePendingJobs.map(({ id }) => id)).toEqual([
            "pending-stale",
        ]);
        expect(result.staleProcessingJobs.map(({ id }) => id)).toEqual([
            "no-source-stale",
            "import-stale",
        ]);
        expect(result.jobsToExtend).toEqual([]);
    });

    it("extends active Lidarr downloads and excludes queue-owned and direct jobs", () => {
        const jobs = [
            makeJob("active", "processing", IMPORT_TIMEOUT_MS + 1, "dl-active"),
            makeJob(
                "soulseek",
                "processing",
                IMPORT_TIMEOUT_MS + 1,
                "dl-soulseek",
                {
                    source: "soulseek_direct",
                },
            ),
            makeJob("queue-owned", "pending", PENDING_TIMEOUT_MS + 1, null, {
                queuedVia: "album-download-queue",
            }),
        ];

        const result = classifyStaleDownloadJobs(
            jobs as never,
            {} as never,
            now,
            (_snapshot, downloadId) => ({ active: downloadId === "dl-active" }),
        );

        expect(result.jobsToExtend.map(({ id }) => id)).toEqual(["active"]);
        expect(result.stalePendingJobs).toEqual([]);
        expect(result.staleProcessingJobs).toEqual([]);
    });

    it("uses the fixed system clock when extending an active import", async () => {
        jest.useFakeTimers().setSystemTime(now);
        const mockPrisma = prisma as any;
        mockPrisma.downloadJob.findMany.mockResolvedValue([
            makeJob("active", "processing", IMPORT_TIMEOUT_MS + 1, "dl-active"),
        ]);
        mockPrisma.downloadJob.update.mockResolvedValue({});
        (lidarrService.isDownloadActiveInSnapshot as jest.Mock).mockReturnValue(
            {
                active: true,
                progress: 50,
            },
        );
        const events = new DownloadJobEvents();

        await expect(
            markStaleJobsAsFailed(
                {} as never,
                {
                    events,
                    blocklistAndRetry: jest.fn(),
                    tryNextAlbumFromArtist: jest.fn(),
                },
                now,
            ),
        ).resolves.toBe(0);
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "active" },
            data: {
                metadata: expect.objectContaining({
                    startedAt: now.toISOString(),
                    extendedTimeout: true,
                }),
            },
        });
    });

    it("fails a stale pending batch and checks discovery completion", async () => {
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                ...makeJob("pending-batch", "pending", PENDING_TIMEOUT_MS + 1),
                discoveryBatchId: "batch-1",
            },
        ]);
        (prisma.downloadJob.updateMany as jest.Mock).mockResolvedValue({
            count: 1,
        });

        await markStaleJobsAsFailed(undefined, dependencies());

        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["pending-batch"] } },
            data: {
                status: "failed",
                error: "Download never started - timed out",
                completedAt: expect.any(Date),
            },
        });
        expect(discoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-1",
        );
    });

    it("continues the sweep when a timeout-policy subscriber throws", async () => {
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            makeJob("stale-one", "processing", NO_SOURCE_TIMEOUT_MS + 1),
            makeJob("stale-two", "processing", NO_SOURCE_TIMEOUT_MS + 1),
        ]);
        (prisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});
        const events = new DownloadJobEvents();
        events.on("download.timedOut", async () => {
            throw new Error("policy unavailable");
        });

        await expect(
            markStaleJobsAsFailed(undefined, dependencies({ events })),
        ).resolves.toBe(2);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "stale-one" },
                data: expect.objectContaining({ status: "failed" }),
            }),
        );
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "stale-two" },
                data: expect.objectContaining({ status: "failed" }),
            }),
        );
    });

    it("merges a stale job into an already completed duplicate", async () => {
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            makeJob("stale-duplicate", "processing", NO_SOURCE_TIMEOUT_MS + 1),
        ]);
        (prisma.downloadJob.findFirst as jest.Mock).mockResolvedValue({
            id: "completed-job",
            metadata: { artistName: "Artist", albumTitle: "Album" },
        });
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});

        await markStaleJobsAsFailed(undefined, dependencies());

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "stale-duplicate" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        mergedWithJob: "completed-job",
                    }),
                }),
            }),
        );
    });

    it("blocklists a stale tracked Lidarr download before retrying", async () => {
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                ...makeJob(
                    "stale-lidarr",
                    "processing",
                    IMPORT_TIMEOUT_MS + 1,
                    "download-1",
                ),
                lidarrAlbumId: 7,
            },
        ]);
        (lidarrService.isDownloadActiveInSnapshot as jest.Mock).mockReturnValue(
            {
                active: false,
            },
        );
        (prisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});
        const blocklistAndRetry = jest.fn().mockResolvedValue(undefined);

        await markStaleJobsAsFailed(
            {} as never,
            dependencies({ blocklistAndRetry }),
        );

        expect(blocklistAndRetry).toHaveBeenCalledWith("download-1");
    });

    it("suppresses terminal failure when same-artist fallback succeeds", async () => {
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                ...makeJob(
                    "stale-fallback",
                    "processing",
                    NO_SOURCE_TIMEOUT_MS + 1,
                ),
                artistMbid: "artist-1",
            },
        ]);
        (prisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(null);
        const tryNextAlbumFromArtist = jest.fn().mockResolvedValue({
            retried: true,
            failed: false,
            jobId: "replacement-job",
        });

        await markStaleJobsAsFailed(
            undefined,
            dependencies({ tryNextAlbumFromArtist }),
        );

        expect(prisma.downloadJob.update).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "stale-fallback" },
                data: expect.objectContaining({ status: "failed" }),
            }),
        );
    });

    it("marks the stale job failed when same-artist fallback throws", async () => {
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                ...makeJob(
                    "stale-fallback-error",
                    "processing",
                    NO_SOURCE_TIMEOUT_MS + 1,
                ),
                artistMbid: "artist-1",
            },
        ]);
        (prisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});
        const tryNextAlbumFromArtist = jest
            .fn()
            .mockRejectedValue(new Error("fallback failed"));

        await markStaleJobsAsFailed(
            undefined,
            dependencies({ tryNextAlbumFromArtist }),
        );

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "stale-fallback-error" },
                data: expect.objectContaining({ status: "failed" }),
            }),
        );
    });

    function dependencies(
        overrides: Partial<{
            events: DownloadJobEvents;
            blocklistAndRetry: jest.Mock;
            tryNextAlbumFromArtist: jest.Mock;
        }> = {},
    ) {
        return {
            events: new DownloadJobEvents(),
            blocklistAndRetry: jest.fn().mockResolvedValue(undefined),
            tryNextAlbumFromArtist: jest.fn().mockResolvedValue({
                retried: false,
                failed: true,
            }),
            ...overrides,
        };
    }

    function makeJob(
        id: string,
        status: "pending" | "processing",
        ageMs: number,
        lidarrRef: string | null = null,
        metadata: Record<string, unknown> = {},
    ) {
        const createdAt = new Date(now.getTime() - ageMs);
        return {
            id,
            status,
            lidarrRef,
            createdAt,
            metadata: {
                artistName: "Artist",
                albumTitle: "Album",
                ...metadata,
                startedAt: createdAt.toISOString(),
            },
        };
    }
});
