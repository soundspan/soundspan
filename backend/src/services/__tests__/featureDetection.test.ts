export {};

const mockExistsSync = jest.fn();
const mockRedisGet = jest.fn();
const mockTrackFindFirst = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
const mockGetActiveSpace = jest.fn();
const mockReadVibeWorkerStatus = jest.fn();
const mockConfig: {
    vibeProviderUrl: string | undefined;
    vibeSpaceCutoverThreshold: number;
} = {
    vibeProviderUrl: undefined,
    vibeSpaceCutoverThreshold: 0.95,
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
jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: (...args: unknown[]) => mockGetActiveSpace(...args),
}));
jest.mock("../../workers/vibeWorkerStatus", () => ({
    readVibeWorkerStatus: (...args: unknown[]) =>
        mockReadVibeWorkerStatus(...args),
}));

describe("featureDetection service", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        mockConfig.vibeProviderUrl = undefined;
        mockGetActiveSpace.mockResolvedValue({
            id: "space-active",
            family: "teacher-family",
        });
        mockReadVibeWorkerStatus.mockResolvedValue(null);
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
                vibe: {
                    provider: {
                        configured: expected,
                        reachable: null,
                        checkedAt: null,
                    },
                    activeSpace: {
                        id: "space-active",
                        family: "teacher-family",
                    },
                    migration: null,
                },
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
            vibe: {
                provider: {
                    configured: false,
                    reachable: null,
                    checkedAt: null,
                },
                activeSpace: {
                    id: "space-active",
                    family: "teacher-family",
                },
                migration: null,
            },
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
            vibe: {
                provider: {
                    configured: false,
                    reachable: null,
                    checkedAt: null,
                },
                activeSpace: {
                    id: "space-active",
                    family: "teacher-family",
                },
                migration: null,
            },
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
            vibe: {
                provider: {
                    configured: false,
                    reachable: null,
                    checkedAt: null,
                },
                activeSpace: {
                    id: "space-active",
                    family: "teacher-family",
                },
                migration: null,
            },
        });
    });

    it("returns the worker's cached provider verdict and migration coverage", async () => {
        mockConfig.vibeProviderUrl = "http://provider:8092";
        mockExistsSync.mockReturnValue(true);
        mockReadVibeWorkerStatus.mockResolvedValue({
            providerReachability: {
                reachable: true,
                checkedAt: "2026-08-17T12:00:00.000Z",
            },
            targetSpace: {
                id: "space-migrating",
                family: "student-family",
                status: "migrating",
            },
            coverage: { embedded: 80, pending: 20, failed: 3 },
        });
        const service = await loadService();

        const features = await service.getFeatures();

        expect(features.vibe).toEqual({
            provider: {
                configured: true,
                reachable: true,
                checkedAt: "2026-08-17T12:00:00.000Z",
            },
            activeSpace: {
                id: "space-active",
                family: "teacher-family",
            },
            migration: {
                spaceId: "space-migrating",
                family: "student-family",
                coverage: { embedded: 80, pending: 20, failed: 3 },
                cutoverThreshold: 0.95,
            },
        });
        expect(mockReadVibeWorkerStatus).toHaveBeenCalledTimes(1);
    });

    it("degrades cached vibe state without probing the provider inline", async () => {
        mockConfig.vibeProviderUrl = "http://provider:8092";
        mockExistsSync.mockReturnValue(true);
        mockReadVibeWorkerStatus.mockRejectedValue(
            new Error("redis unavailable"),
        );
        mockGetActiveSpace.mockRejectedValue(new Error("database unavailable"));
        const service = await loadService();

        const features = await service.getFeatures();

        expect(features.vibe).toEqual({
            provider: {
                configured: true,
                reachable: null,
                checkedAt: null,
            },
            activeSpace: null,
            migration: null,
        });
    });

    it("hides a cached migration after that target becomes active", async () => {
        mockConfig.vibeProviderUrl = "http://provider:8092";
        mockExistsSync.mockReturnValue(true);
        mockReadVibeWorkerStatus.mockResolvedValue({
            providerReachability: {
                reachable: true,
                checkedAt: "2026-08-17T12:00:00.000Z",
            },
            targetSpace: {
                id: "space-active",
                family: "teacher-family",
                status: "migrating",
            },
            coverage: { embedded: 95, pending: 5, failed: 0 },
        });
        const service = await loadService();

        const features = await service.getFeatures();

        expect(features.vibe.migration).toBeNull();
    });
});
