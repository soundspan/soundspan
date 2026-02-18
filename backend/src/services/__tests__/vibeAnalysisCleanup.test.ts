const mockTrackFindMany = jest.fn();
const mockTrackUpdate = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findMany: (...args: unknown[]) => mockTrackFindMany(...args),
            update: (...args: unknown[]) => mockTrackUpdate(...args),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
    },
}));

import { vibeAnalysisCleanupService } from "../vibeAnalysisCleanup";

describe("vibeAnalysisCleanupService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns zero when no stale tracks exist", async () => {
        mockTrackFindMany.mockResolvedValueOnce([]);

        const result = await vibeAnalysisCleanupService.cleanupStaleProcessing();

        expect(mockTrackFindMany).toHaveBeenCalledWith({
            where: {
                vibeAnalysisStatus: "processing",
                OR: [
                    { vibeAnalysisStatusUpdatedAt: { lt: expect.any(Date) } },
                    {
                        vibeAnalysisStatusUpdatedAt: null,
                        updatedAt: { lt: expect.any(Date) },
                    },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: { select: { name: true } },
                    },
                },
            },
        });
        expect(mockTrackUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ reset: 0 });
    });

    it("resets stale tracks and logs each reset action", async () => {
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Track One",
                album: { artist: { name: "Artist One" } },
            },
            {
                id: "t2",
                title: "Track Two",
                album: { artist: { name: "Artist Two" } },
            },
        ]);
        mockTrackUpdate.mockResolvedValue({});

        const result = await vibeAnalysisCleanupService.cleanupStaleProcessing();

        expect(mockTrackUpdate).toHaveBeenCalledTimes(2);
        expect(mockTrackUpdate).toHaveBeenNthCalledWith(1, {
            where: { id: "t1" },
            data: {
                vibeAnalysisStatus: null,
                vibeAnalysisStatusUpdatedAt: null,
            },
        });
        expect(mockTrackUpdate).toHaveBeenNthCalledWith(2, {
            where: { id: "t2" },
            data: {
                vibeAnalysisStatus: null,
                vibeAnalysisStatusUpdatedAt: null,
            },
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[VibeAnalysisCleanup] Found 2 stale vibe tracks (processing > 30 min)"
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[VibeAnalysisCleanup] Reset for retry: Artist One - Track One"
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[VibeAnalysisCleanup] Reset for retry: Artist Two - Track Two"
        );
        expect(result).toEqual({ reset: 2 });
    });

    it("propagates update failures so caller can retry", async () => {
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Track One",
                album: { artist: { name: "Artist One" } },
            },
        ]);
        mockTrackUpdate.mockRejectedValueOnce(new Error("write failed"));

        await expect(
            vibeAnalysisCleanupService.cleanupStaleProcessing()
        ).rejects.toThrow("write failed");
        expect(mockTrackUpdate).toHaveBeenCalledTimes(1);
    });
});
