// Regression test for the eager-config crash: importing youtubeDownload (which
// happens transitively whenever index.ts is required) must not read
// config.ytmusicStreamer at module load, so a context with a minimal config
// mock (e.g. the entrypoint runtime test) does not crash on import.
describe("youtubeDownloadService lazy client", () => {
    const realEnv = process.env;

    afterEach(() => {
        process.env = realEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("imports without reading sidecar config (config has no ytmusicStreamer)", () => {
        jest.resetModules();
        jest.doMock("../../config", () => ({ config: { nodeEnv: "test" } }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));

        expect(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require("../youtubeDownload");
            expect(mod.youtubeDownloadService).toBeDefined();
        }).not.toThrow();
    });

    it("builds the axios client lazily from config on first use", async () => {
        jest.resetModules();
        const create = jest.fn(() => ({
            get: jest.fn(async () => ({ data: { title: "t" } })),
        }));
        jest.doMock("axios", () => ({ __esModule: true, default: { create } }));
        jest.doMock("../../config", () => ({
            config: { ytmusicStreamer: { url: "http://sidecar:8586" } },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { youtubeDownloadService } = require("../youtubeDownload");

        // Constructing the singleton at import must not build the client.
        expect(create).not.toHaveBeenCalled();

        // The client is built on first request, using the configured base URL.
        await youtubeDownloadService.getVideoInfo(
            "http://youtube.com/watch?v=x",
        );
        expect(create).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({ baseURL: "http://sidecar:8586" }),
        );
    });

    it("attaches x-internal-secret to the client when config provides the secret (F31)", async () => {
        jest.resetModules();
        const create = jest.fn(() => ({
            get: jest.fn(async () => ({ data: { title: "t" } })),
        }));
        jest.doMock("axios", () => ({ __esModule: true, default: { create } }));
        jest.doMock("../../config", () => ({
            config: {
                ytmusicStreamer: { url: "http://sidecar:8586" },
                internalApiSecret: "sek-123",
            },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { youtubeDownloadService } = require("../youtubeDownload");

        await youtubeDownloadService.getVideoInfo(
            "http://youtube.com/watch?v=x",
        );
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                headers: expect.objectContaining({
                    "x-internal-secret": "sek-123",
                }),
            }),
        );
    });

    it("searches albums with encoded parameters and maps the sidecar response", async () => {
        jest.resetModules();
        const get = jest.fn(async () => ({
            data: {
                albums: [
                    {
                        browse_id: "MPRE123",
                        title: "Album",
                        artists: ["Artist", "Guest"],
                    },
                ],
            },
        }));
        jest.doMock("axios", () => ({
            __esModule: true,
            default: { create: jest.fn(() => ({ get })) },
        }));
        jest.doMock("../../config", () => ({
            config: { ytmusicStreamer: { url: "http://sidecar:8586" } },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { youtubeDownloadService } = require("../youtubeDownload");

        await expect(
            youtubeDownloadService.searchAlbums("Artist & Album", 25),
        ).resolves.toEqual([
            {
                browseId: "MPRE123",
                title: "Album",
                artists: ["Artist", "Guest"],
            },
        ]);
        expect(get).toHaveBeenCalledWith(
            "/yt/album-search?query=Artist%20%26%20Album&limit=25",
        );
    });

    it("requires the enabled setting and a healthy sidecar for availability", async () => {
        jest.resetModules();
        const get = jest.fn(async () => ({ data: { status: "ok" } }));
        const getSystemSettings = jest
            .fn()
            .mockResolvedValue({ ytMusicEnabled: true });
        jest.doMock("axios", () => ({
            __esModule: true,
            default: { create: jest.fn(() => ({ get })) },
        }));
        jest.doMock("../../config", () => ({
            config: { ytmusicStreamer: { url: "http://sidecar:8586" } },
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { youtubeDownloadService } = require("../youtubeDownload");

        await expect(youtubeDownloadService.isAvailable()).resolves.toBe(true);
        expect(get).toHaveBeenCalledWith("/health", { timeout: 5_000 });

        getSystemSettings.mockResolvedValueOnce({ ytMusicEnabled: false });
        await expect(youtubeDownloadService.isAvailable()).resolves.toBe(false);
        expect(get).toHaveBeenCalledTimes(1);
    });
});
