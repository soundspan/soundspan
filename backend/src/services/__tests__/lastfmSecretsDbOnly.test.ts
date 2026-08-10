export {};

const mockGetSystemSettings = jest.fn();
const mockHttpGet = jest.fn();
const mockLoggerWarn = jest.fn();

async function loadService(secretsDbOnly: boolean, envApiKey: string) {
    jest.resetModules();
    jest.clearAllMocks();

    jest.doMock("../../config", () => ({
        config: {
            secretsDbOnly,
            lastfm: { apiKey: envApiKey },
        },
    }));
    jest.doMock("../../utils/systemSettings", () => ({
        getSystemSettings: (...args: unknown[]) =>
            mockGetSystemSettings(...args),
    }));
    jest.doMock("../../utils/redis", () => ({
        redisClient: { get: jest.fn(), setEx: jest.fn() },
    }));
    jest.doMock("../rateLimiter", () => ({
        rateLimiter: {
            execute: async (_bucket: string, request: () => Promise<unknown>) =>
                request(),
        },
    }));
    jest.doMock("../fanart", () => ({
        fanartService: { getArtistImage: jest.fn() },
    }));
    jest.doMock("../deezer", () => ({
        deezerService: {
            getArtistImage: jest.fn(),
            getArtistImageStrict: jest.fn(),
        },
    }));
    jest.doMock("../../utils/logger", () => ({
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: (...args: unknown[]) => mockLoggerWarn(...args),
            error: jest.fn(),
        },
    }));
    jest.doMock("axios", () => ({
        __esModule: true,
        default: {
            create: () => ({ get: mockHttpGet }),
        },
    }));

    return (await import("../lastfm")).lastFmService as any;
}

describe("Last.fm DB-only secrets policy", () => {
    beforeEach(() => {
        mockGetSystemSettings.mockReset();
        mockHttpGet.mockReset();
        mockLoggerWarn.mockReset();
        mockHttpGet.mockResolvedValue({ data: { ok: true } });
    });

    it("uses the env key when DB-only mode is off and settings are empty", async () => {
        mockGetSystemSettings.mockResolvedValue(null);
        const service = await loadService(false, "env-key-456");

        await expect(
            service.request({ method: "artist.getInfo" }),
        ).resolves.toEqual({ ok: true });
        expect(mockHttpGet).toHaveBeenCalledWith("/", {
            params: { method: "artist.getInfo" },
        });
        expect(service.apiKey).toBe("env-key-456");
    });

    it("uses the database key in DB-only mode", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lastfmApiKey: "db-key-123",
        });
        const service = await loadService(true, "env-key-456");

        await expect(
            service.request({ method: "artist.getInfo" }),
        ).resolves.toEqual({ ok: true });
        expect(service.apiKey).toBe("db-key-123");
    });

    it("does not fall back to env when settings are unreadable in DB-only mode", async () => {
        mockGetSystemSettings.mockRejectedValue(new Error("settings down"));
        const service = await loadService(true, "env-key-456");

        await expect(
            service.request({ method: "artist.getInfo" }),
        ).rejects.toThrow("Last.fm API key not available");
        expect(mockHttpGet).not.toHaveBeenCalled();
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "SECRETS_DB_ONLY: system settings unreadable; Last.fm key unavailable (no .env fallback)",
        );
    });
});
