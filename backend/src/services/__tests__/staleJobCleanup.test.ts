jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        discoveryBatch: {
            findMany: jest.fn(),
            updateMany: jest.fn(),
        },
        downloadJob: {
            findMany: jest.fn(),
            updateMany: jest.fn(),
        },
        spotifyImportJob: {
            findMany: jest.fn(),
            updateMany: jest.fn(),
        },
    },
}));

jest.mock("../../workers/queues", () => {
    const queues = [
        { name: "discovery", clean: jest.fn() },
        { name: "scan", clean: jest.fn() },
    ];
    return { queues };
});

jest.mock("../audioAnalysisCleanup", () => ({
    audioAnalysisCleanupService: {
        cleanupStaleProcessing: jest.fn(),
    },
}));

import { prisma } from "../../utils/db";
import { queues } from "../../workers/queues";
import { audioAnalysisCleanupService } from "../audioAnalysisCleanup";
import { staleJobCleanupService } from "../staleJobCleanup";
import { logger } from "../../utils/logger";

const mockDiscoveryBatchFindMany = prisma.discoveryBatch.findMany as jest.Mock;
const mockDiscoveryBatchUpdateMany = prisma.discoveryBatch.updateMany as jest.Mock;
const mockDownloadJobFindMany = prisma.downloadJob.findMany as jest.Mock;
const mockDownloadJobUpdateMany = prisma.downloadJob.updateMany as jest.Mock;
const mockSpotifyImportJobFindMany = prisma.spotifyImportJob.findMany as jest.Mock;
const mockSpotifyImportJobUpdateMany = prisma.spotifyImportJob.updateMany as jest.Mock;

const mockQueueClean0 = (queues as any[])[0].clean as jest.Mock;
const mockQueueClean1 = (queues as any[])[1].clean as jest.Mock;

const mockAudioCleanup = audioAnalysisCleanupService
    .cleanupStaleProcessing as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;

describe("staleJobCleanupService", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockDiscoveryBatchFindMany.mockResolvedValue([]);
        mockDiscoveryBatchUpdateMany.mockResolvedValue({ count: 0 });
        mockDownloadJobFindMany.mockResolvedValue([]);
        mockDownloadJobUpdateMany.mockResolvedValue({ count: 0 });
        mockSpotifyImportJobFindMany.mockResolvedValue([]);
        mockSpotifyImportJobUpdateMany.mockResolvedValue({ count: 0 });
        mockQueueClean0.mockResolvedValue([]);
        mockQueueClean1.mockResolvedValue([]);
        mockAudioCleanup.mockResolvedValue({
            reset: 0,
            permanentlyFailed: 0,
            recovered: 0,
        });
    });

    it("cleans stale records across all domains and aggregates totals", async () => {
        mockDiscoveryBatchFindMany.mockResolvedValue([
            { id: "batch-1", status: "downloading", createdAt: new Date() },
            { id: "batch-2", status: "scanning", createdAt: new Date() },
        ]);
        mockDownloadJobFindMany.mockResolvedValue([
            { id: "job-1", subject: "A", createdAt: new Date() },
            { id: "job-2", subject: "B", createdAt: new Date() },
        ]);
        mockSpotifyImportJobFindMany.mockResolvedValue([
            { id: "spotify-1", playlistName: "P", createdAt: new Date() },
        ]);

        mockQueueClean0
            .mockResolvedValueOnce([{}, {}]) // completed
            .mockResolvedValueOnce([{}]); // failed
        mockQueueClean1
            .mockResolvedValueOnce([]) // completed
            .mockResolvedValueOnce([{}]); // failed

        mockAudioCleanup.mockResolvedValue({
            reset: 3,
            permanentlyFailed: 1,
            recovered: 2,
        });

        const result = await staleJobCleanupService.cleanupAll();

        expect(result.discoveryBatches).toEqual({
            cleaned: 2,
            ids: ["batch-1", "batch-2"],
        });
        expect(result.downloadJobs).toEqual({
            cleaned: 2,
            ids: ["job-1", "job-2"],
        });
        expect(result.spotifyImportJobs).toEqual({
            cleaned: 1,
            ids: ["spotify-1"],
        });
        expect(result.bullQueues).toEqual({
            cleaned: 4,
            queues: ["discovery", "scan"],
        });
        expect(result.audioAnalysis).toEqual({
            reset: 3,
            permanentlyFailed: 1,
            recovered: 2,
        });
        expect(result.totalCleaned).toBe(13);

        expect(mockDiscoveryBatchUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["batch-1", "batch-2"] } },
            })
        );

        expect(mockDownloadJobUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryBatchId: { in: ["batch-1", "batch-2"] },
                }),
            })
        );
        expect(mockDownloadJobUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["job-1", "job-2"] } },
            })
        );
        expect(mockSpotifyImportJobUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["spotify-1"] } },
            })
        );
    });

    it("returns zero cleanup when no stale records are found", async () => {
        const result = await staleJobCleanupService.cleanupAll();

        expect(result).toEqual({
            discoveryBatches: { cleaned: 0, ids: [] },
            downloadJobs: { cleaned: 0, ids: [] },
            spotifyImportJobs: { cleaned: 0, ids: [] },
            bullQueues: { cleaned: 0, queues: [] },
            audioAnalysis: { reset: 0, permanentlyFailed: 0, recovered: 0 },
            totalCleaned: 0,
        });
    });

    it("continues queue cleanup when one queue throws", async () => {
        mockQueueClean0.mockRejectedValue(new Error("redis timeout"));
        mockQueueClean1
            .mockResolvedValueOnce([{}]) // completed
            .mockResolvedValueOnce([]); // failed

        const result = await (staleJobCleanupService as any).cleanupBullQueues();

        expect(result).toEqual({
            cleaned: 1,
            queues: ["scan"],
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[STALE-CLEANUP] Error cleaning queue discovery:",
            expect.any(Error)
        );
    });

    it("cleans discovery batches and marks linked jobs failed", async () => {
        mockDiscoveryBatchFindMany.mockResolvedValue([
            { id: "batch-a", status: "downloading", createdAt: new Date() },
        ]);

        const result = await (staleJobCleanupService as any).cleanupDiscoveryBatches();

        expect(result).toEqual({
            cleaned: 1,
            ids: ["batch-a"],
        });
        expect(mockDownloadJobUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryBatchId: { in: ["batch-a"] },
                    status: { in: ["pending", "processing"] },
                }),
            })
        );
    });

    it("returns no-op for spotify import cleanup when nothing is stale", async () => {
        mockSpotifyImportJobFindMany.mockResolvedValue([]);

        const result = await (staleJobCleanupService as any).cleanupSpotifyImportJobs();

        expect(result).toEqual({ cleaned: 0, ids: [] });
        expect(mockSpotifyImportJobUpdateMany).not.toHaveBeenCalled();
    });
});
