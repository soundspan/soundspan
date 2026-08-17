export {};

const mockExistsSync = jest.fn();
const mockRedisGet = jest.fn();
const mockTrackFindFirst = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
const mockConfig: { vibeProviderUrl: string | undefined } = {
    vibeProviderUrl: undefined,
};

jest.mock("../../config", () => ({ config: mockConfig }));
jest.mock("fs", () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: (...args: unknown[]) => mockRedisGet(...args) },
}));
jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findFirst: (...args: unknown[]) => mockTrackFindFirst(...args),
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
        mockConfig.vibeProviderUrl = undefined;
    });

    async function loadService() {
        const mod = await import("../featureDetection");
        mod.featureDetection.invalidateCache();
        return mod.featureDetection;
    }

    it.each([
        ["http://vibe-provider:8090", true],
        [undefined, false],
    ])(
        "reports provider-backed vibe availability for %s",
        async (url, expected) => {
            mockConfig.vibeProviderUrl = url;
            mockExistsSync.mockReturnValue(false);
            mockRedisGet.mockResolvedValue(null);
            mockTrackFindFirst.mockResolvedValue(null);
            const service = await loadService();

            await expect(service.getFeatures()).resolves.toEqual({
                musicCNN: false,
                vibeEmbeddings: expected,
            });
            expect(mockRedisGet).toHaveBeenCalledTimes(1);
        },
    );

    it("preserves MusicCNN script, heartbeat, and database detection", async () => {
        const service = await loadService();
        mockExistsSync.mockReturnValueOnce(false);
        mockRedisGet.mockResolvedValueOnce(String(Date.now()));

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: true,
            vibeEmbeddings: false,
        });
        expect(mockTrackFindFirst).not.toHaveBeenCalled();
    });

    it("returns false and logs when MusicCNN detection fails", async () => {
        const service = await loadService();
        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockRejectedValue(new Error("redis down"));

        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: false,
            vibeEmbeddings: false,
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[FEATURE-DETECTION] Error checking MusicCNN:",
            expect.any(Error),
        );
    });

    it("uses cache until invalidated", async () => {
        const service = await loadService();
        mockExistsSync.mockReturnValue(true);
        const first = await service.getFeatures();

        mockExistsSync.mockReturnValue(false);
        mockRedisGet.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValue(null);
        await expect(service.getFeatures()).resolves.toEqual(first);

        service.invalidateCache();
        await expect(service.getFeatures()).resolves.toEqual({
            musicCNN: false,
            vibeEmbeddings: false,
        });
    });
});
