const mockAxiosGet = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
    get: (...args: unknown[]) => mockAxiosGet(...args),
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: mockAxiosCreate,
    },
    create: mockAxiosCreate,
}));

const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

const redisClient = {
    isOpen: false,
    get: jest.fn(),
    setEx: jest.fn(),
};
jest.mock("../../utils/redis", () => ({
    redisClient,
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

import { fanartService } from "../fanart";
import { getSystemSettings } from "../../utils/systemSettings";

const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;

describe("fanart service", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        delete process.env.FANART_API_KEY;

        redisClient.isOpen = false;
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockGetSystemSettings.mockResolvedValue(null);

        const service = fanartService as any;
        service.initialized = false;
        service.apiKey = null;
        service.noKeyWarningShown = false;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it("returns null when no fanart key exists in db or env", async () => {
        const image = await fanartService.getArtistImage("mbid-1");
        const cover = await fanartService.getAlbumCover("mbid-1");

        expect(image).toBeNull();
        expect(cover).toBeNull();
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("uses database config and returns cached artist image", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            fanartEnabled: true,
            fanartApiKey: "db-key",
        });
        redisClient.isOpen = true;
        mockRedisGet.mockResolvedValueOnce("https://cache/artist.jpg");

        const image = await fanartService.getArtistImage("mbid-cache");

        expect(image).toBe("https://cache/artist.jpg");
        expect(mockRedisGet).toHaveBeenCalledWith("fanart:artist:mbid-cache");
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("falls back to env key and expands filename-based artistbackground URLs", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(new Error("settings down"));
        process.env.FANART_API_KEY = "env-key";
        redisClient.isOpen = true;
        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                artistbackground: [{ url: "background-file.jpg" }],
            },
        });

        const image = await fanartService.getArtistImage("mbid-bg");

        expect(image).toBe(
            "https://assets.fanart.tv/fanart/music/mbid-bg/artistbackground/background-file.jpg"
        );
        expect(mockAxiosGet).toHaveBeenCalledWith("/music/mbid-bg", {
            params: { api_key: "env-key" },
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "fanart:artist:mbid-bg",
            7 * 24 * 60 * 60,
            "https://assets.fanart.tv/fanart/music/mbid-bg/artistbackground/background-file.jpg"
        );
    });

    it("falls back from artistthumb to hdmusiclogo", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            fanartEnabled: true,
            fanartApiKey: "db-key",
        });

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                artistbackground: [],
                artistthumb: [{ url: "https://cdn/thumb.jpg" }],
            },
        });
        const thumb = await fanartService.getArtistImage("mbid-thumb");
        expect(thumb).toBe("https://cdn/thumb.jpg");

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                artistbackground: [],
                artistthumb: [],
                hdmusiclogo: [{ url: "logo-file.png" }],
            },
        });
        const logo = await fanartService.getArtistImage("mbid-logo");
        expect(logo).toBe(
            "https://assets.fanart.tv/fanart/music/mbid-logo/hdmusiclogo/logo-file.png"
        );
    });

    it("returns null for 404 and logs non-404 artist-image errors", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            fanartEnabled: true,
            fanartApiKey: "db-key",
        });

        mockAxiosGet.mockRejectedValueOnce({ response: { status: 404 } });
        const missing = await fanartService.getArtistImage("mbid-missing");
        expect(missing).toBeNull();
        expect(mockLoggerDebug).toHaveBeenCalledWith("Fanart.tv: No images found");

        mockAxiosGet.mockRejectedValueOnce({ message: "upstream error" });
        const errored = await fanartService.getArtistImage("mbid-error");
        expect(errored).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "   Fanart.tv error:",
            "upstream error"
        );
    });

    it("returns cached album cover when available", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            fanartEnabled: true,
            fanartApiKey: "db-key",
        });
        redisClient.isOpen = true;
        mockRedisGet.mockResolvedValueOnce("https://cache/album.jpg");

        const image = await fanartService.getAlbumCover("album-mbid-cache");

        expect(image).toBe("https://cache/album.jpg");
        expect(mockRedisGet).toHaveBeenCalledWith(
            "fanart:album:album-mbid-cache"
        );
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("prefers albumcover then cdart and caches album art", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            fanartEnabled: true,
            fanartApiKey: "db-key",
        });
        redisClient.isOpen = true;
        mockRedisGet.mockResolvedValue(null);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                albums: {
                    "album-mbid-1": {
                        albumcover: [{ url: "https://fanart/cover1.jpg" }],
                        cdart: [{ url: "https://fanart/cdart1.png" }],
                    },
                },
            },
        });
        const cover = await fanartService.getAlbumCover("album-mbid-1");
        expect(cover).toBe("https://fanart/cover1.jpg");

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                albums: {
                    "album-mbid-2": {
                        albumcover: [],
                        cdart: [{ url: "https://fanart/cdart2.png" }],
                    },
                },
            },
        });
        const cdart = await fanartService.getAlbumCover("album-mbid-2");
        expect(cdart).toBe("https://fanart/cdart2.png");
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "fanart:album:album-mbid-2",
            7 * 24 * 60 * 60,
            "https://fanart/cdart2.png"
        );
    });

    it("returns null on album-cover fetch errors", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            fanartEnabled: true,
            fanartApiKey: "db-key",
        });
        mockAxiosGet.mockRejectedValueOnce(new Error("network down"));

        const cover = await fanartService.getAlbumCover("album-fail");
        expect(cover).toBeNull();
    });
});
