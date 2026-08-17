const mockTrackFindMany = jest.fn();
const mockTrackUpdateMany = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findMany: (...args: unknown[]) => mockTrackFindMany(...args),
            updateMany: (...args: unknown[]) => mockTrackUpdateMany(...args),
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

        const result =
            await vibeAnalysisCleanupService.cleanupStaleProcessing();

        expect(mockTrackFindMany).toHaveBeenCalledWith({
            where: {
                vibeAnalysisStatus: "processing",
                origin: "LOCAL",
                OR: [
                    { vibeAnalysisStatusUpdatedAt: { lt: expect.any(Date) } },
                    {
                        vibeAnalysisStatusUpdatedAt: null,
                        updatedAt: { lt: expect.any(Date) },
                    },
                ],
            },
            select: {
                id: true,
                title: true,
                vibeAnalysisGeneration: true,
                vibeAnalysisStatusUpdatedAt: true,
                album: {
                    select: {
                        artist: { select: { name: true } },
                    },
                },
            },
        });
        expect(mockTrackUpdateMany).not.toHaveBeenCalled();
        expect(result).toEqual({ reset: 0 });
    });

    it("resets stale tracks and logs each reset action", async () => {
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Track One",
                vibeAnalysisGeneration: 3,
                vibeAnalysisStatusUpdatedAt: new Date(
                    "2026-08-17T10:00:00.000Z",
                ),
                album: { artist: { name: "Artist One" } },
            },
            {
                id: "t2",
                title: "Track Two",
                vibeAnalysisGeneration: 5,
                vibeAnalysisStatusUpdatedAt: null,
                album: { artist: { name: "Artist Two" } },
            },
        ]);
        mockTrackUpdateMany.mockResolvedValue({ count: 1 });

        const result =
            await vibeAnalysisCleanupService.cleanupStaleProcessing();

        expect(mockTrackUpdateMany).toHaveBeenCalledTimes(2);
        expect(mockTrackUpdateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: {
                    id: "t1",
                    vibeAnalysisStatus: "processing",
                    vibeAnalysisGeneration: 3,
                    vibeAnalysisStatusUpdatedAt: new Date(
                        "2026-08-17T10:00:00.000Z",
                    ),
                },
                data: expect.objectContaining({
                    vibeAnalysisStatus: "pending",
                    vibeAnalysisGeneration: { increment: 1 },
                }),
            }),
        );
        expect(mockTrackUpdateMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: "t2",
                    vibeAnalysisGeneration: 5,
                }),
                data: expect.objectContaining({
                    vibeAnalysisGeneration: { increment: 1 },
                }),
            }),
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[VibeAnalysisCleanup] Found 2 stale vibe tracks (processing > 30 min)",
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[VibeAnalysisCleanup] Reset for retry: Artist One - Track One",
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[VibeAnalysisCleanup] Reset for retry: Artist Two - Track Two",
        );
        expect(result).toEqual({ reset: 2 });
    });

    it("propagates update failures so caller can retry", async () => {
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Track One",
                vibeAnalysisGeneration: 0,
                vibeAnalysisStatusUpdatedAt: null,
                album: { artist: { name: "Artist One" } },
            },
        ]);
        mockTrackUpdateMany.mockRejectedValueOnce(new Error("write failed"));

        await expect(
            vibeAnalysisCleanupService.cleanupStaleProcessing(),
        ).rejects.toThrow("write failed");
        expect(mockTrackUpdateMany).toHaveBeenCalledTimes(1);
    });
});
