export {};

const mockExistsSync = jest.fn();
const mockRedisGet = jest.fn();
const mockTrackFindFirst = jest.fn();
const mockTrackEmbeddingCount = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("fs", () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: (...args: unknown[]) => mockRedisGet(...args),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findFirst: (...args: unknown[]) => mockTrackFindFirst(...args),
        },
        trackEmbedding: {
            count: (...args: unknown[]) => mockTrackEmbeddingCount(...args),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

describe("featureDetection service", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    async function loadService() {
        const mod = await import("../featureDetection");
        mod.featureDetection.invalidateCache();
        return mod.featureDetection;
    }

    it("reports both features when analyzer scripts exist", async () => {
        const service = await loadService();
        mockExistsSync.mockImplementation((candidate: string) =>
            [
                "/app/audio-analyzer/analyzer.py",
                "/app/audio-analyzer-clap/analyzer.py",
            ].includes(String(candidate))
        );

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: true,
            vibeEmbeddings: true,
        });
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockTrackFindFirst).not.toHaveBeenCalled();
        expect(mockTrackEmbeddingCount).not.toHaveBeenCalled();
    });

    it("falls back to heartbeat and embedding checks when scripts are absent", async () => {
        const service = await loadService();
        const now = Date.now();
        mockExistsSync.mockReturnValue(false);
        mockRedisGet
            .mockResolvedValueOnce(String(now))
            .mockResolvedValueOnce(null);
        mockTrackEmbeddingCount.mockResolvedValueOnce(2);

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: true,
            vibeEmbeddings: true,
        });
        expect(mockRedisGet).toHaveBeenCalledWith("audio:worker:heartbeat");
        expect(mockRedisGet).toHaveBeenCalledWith("clap:worker:heartbeat");
        expect(mockTrackEmbeddingCount).toHaveBeenCalledTimes(1);
    });

    it("falls back to database feature presence when heartbeat is stale or missing", async () => {
        const service = await loadService();
        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValueOnce({ id: "track-1" });
        mockTrackEmbeddingCount.mockResolvedValueOnce(0);

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: true,
            vibeEmbeddings: false,
        });
        expect(mockTrackFindFirst).toHaveBeenCalledWith({
            where: { energy: { not: null } },
            select: { id: true },
        });
    });

    it("returns false flags and logs when checks throw", async () => {
        const service = await loadService();
        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockImplementation(() => {
            throw new Error("redis down");
        });

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: false,
            vibeEmbeddings: false,
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[FEATURE-DETECTION] Error checking MusicCNN:",
            expect.any(Error)
        );
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[FEATURE-DETECTION] Error checking CLAP:",
            expect.any(Error)
        );
    });

    it("uses cache until invalidated", async () => {
        const service = await loadService();
        mockExistsSync.mockImplementation((candidate: string) =>
            String(candidate).includes("audio-analyzer")
        );

        const first = await service.getFeatures();
        expect(first).toEqual({ musicCNN: true, vibeEmbeddings: true });

        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValue(null);
        mockTrackEmbeddingCount.mockResolvedValue(0);

        const cached = await service.getFeatures();
        expect(cached).toEqual({ musicCNN: true, vibeEmbeddings: true });

        service.invalidateCache();
        const refreshed = await service.getFeatures();
        expect(refreshed).toEqual({ musicCNN: false, vibeEmbeddings: false });
    });
});
