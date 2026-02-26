import axios from "axios";
import { redisClient } from "../../utils/redis";
import { imageProviderService } from "../imageProvider";
import { musicBrainzService } from "../musicbrainz";
import { rateLimiter } from "../rateLimiter";
import { coverArtService } from "../coverArt";

jest.mock("axios");

jest.mock("../../utils/logger", () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
        del: jest.fn(),
    },
}));

jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: jest.fn(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn()
        ),
    },
}));

jest.mock("../imageProvider", () => ({
    imageProviderService: {
        getAlbumCover: jest.fn(),
    },
}));

jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroup: jest.fn(),
        extractPrimaryArtist: jest.fn(),
    },
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;
const mockRateLimiterExecute = rateLimiter.execute as jest.Mock;
const mockGetAlbumCover = imageProviderService.getAlbumCover as jest.Mock;
const mockGetReleaseGroup = musicBrainzService.getReleaseGroup as jest.Mock;
const mockExtractPrimaryArtist = musicBrainzService.extractPrimaryArtist as jest.Mock;

describe("coverArtService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisDel.mockResolvedValue(1);
        mockRateLimiterExecute.mockImplementation(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn()
        );
        mockGetReleaseGroup.mockResolvedValue(null);
        mockExtractPrimaryArtist.mockReturnValue("Unknown Artist");
        mockGetAlbumCover.mockResolvedValue(null);
    });

    it("returns cached URL without making upstream calls", async () => {
        mockRedisGet.mockResolvedValue("https://cached.example/cover.jpg");

        const result = await coverArtService.getCoverArt("mbid-cache-hit");

        expect(result).toBe("https://cached.example/cover.jpg");
        expect(mockRateLimiterExecute).not.toHaveBeenCalled();
    });

    it("skips temporary MBIDs without calling upstream providers", async () => {
        const result = await coverArtService.getCoverArt("temp-12345");

        expect(result).toBeNull();
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockRateLimiterExecute).not.toHaveBeenCalled();
        expect(mockGetReleaseGroup).not.toHaveBeenCalled();
        expect(mockGetAlbumCover).not.toHaveBeenCalled();
    });

    it("deduplicates concurrent requests for the same MBID", async () => {
        let resolveCoverArtRequest: (value: unknown) => void = () => {};
        const pendingCoverArtRequest = new Promise((resolve) => {
            resolveCoverArtRequest = resolve;
        });

        mockAxiosGet.mockImplementation((url: string) => {
            if (url.includes("coverartarchive.org")) {
                return pendingCoverArtRequest;
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const firstRequest = coverArtService.getCoverArt("mbid-dedupe");
        const secondRequest = coverArtService.getCoverArt("mbid-dedupe");

        await Promise.resolve();
        expect(mockRateLimiterExecute).toHaveBeenCalledTimes(1);

        resolveCoverArtRequest({
            data: {
                images: [{ front: true, image: "https://images.example/front.jpg" }],
            },
        });

        await expect(firstRequest).resolves.toBe("https://images.example/front.jpg");
        await expect(secondRequest).resolves.toBe("https://images.example/front.jpg");
    });

    it("falls back to provider chain when Cover Art Archive is not found", async () => {
        mockAxiosGet.mockImplementation((url: string) => {
            if (url.includes("coverartarchive.org")) {
                return Promise.reject({ response: { status: 404 } });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });
        mockGetReleaseGroup.mockResolvedValue({
            title: "Fallback Album",
            "artist-credit": [{ name: "Fallback Artist" }],
        });
        mockExtractPrimaryArtist.mockReturnValue("Fallback Artist");
        mockGetAlbumCover.mockResolvedValue({
            url: "https://deezer.example/fallback.jpg",
            source: "deezer",
        });

        const result = await coverArtService.getCoverArt("mbid-fallback");

        expect(result).toBe("https://deezer.example/fallback.jpg");
        expect(mockGetAlbumCover).toHaveBeenCalledWith(
            "Fallback Artist",
            "Fallback Album",
            "mbid-fallback",
            { timeout: 5000 }
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "caa:mbid-fallback",
            365 * 24 * 60 * 60,
            "https://deezer.example/fallback.jpg"
        );
    });

    it("negative-caches not-found result when no fallback image exists", async () => {
        mockAxiosGet.mockImplementation((url: string) => {
            if (url.includes("coverartarchive.org")) {
                return Promise.reject({ response: { status: 404 } });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await coverArtService.getCoverArt("mbid-not-found");

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "caa:mbid-not-found",
            30 * 24 * 60 * 60,
            "NOT_FOUND"
        );
    });

    it("does not negative-cache transient Cover Art Archive failures", async () => {
        mockAxiosGet.mockImplementation((url: string) => {
            if (url.includes("coverartarchive.org")) {
                return Promise.reject(new Error("socket timeout"));
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await coverArtService.getCoverArt("mbid-transient-error");

        expect(result).toBeNull();
        expect(mockRedisSetEx).not.toHaveBeenCalledWith(
            "caa:mbid-transient-error",
            30 * 24 * 60 * 60,
            "NOT_FOUND"
        );
    });

    it("clears stale NOT_FOUND cache entries but keeps non-NOT_FOUND values", async () => {
        mockRedisGet
            .mockResolvedValueOnce("NOT_FOUND")
            .mockResolvedValueOnce("https://cached.example/cover.jpg");

        await expect(
            coverArtService.clearNotFoundCache(" mbid-clear-me ")
        ).resolves.toBeUndefined();
        await expect(
            coverArtService.clearNotFoundCache("mbid-keep-value")
        ).resolves.toBeUndefined();

        expect(mockRedisGet).toHaveBeenNthCalledWith(1, "caa:mbid-clear-me");
        expect(mockRedisGet).toHaveBeenNthCalledWith(2, "caa:mbid-keep-value");
        expect(mockRedisDel).toHaveBeenCalledTimes(1);
        expect(mockRedisDel).toHaveBeenCalledWith("caa:mbid-clear-me");
    });

    it("ignores redis errors while clearing stale NOT_FOUND cache entries", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("redis unavailable"));

        await expect(
            coverArtService.clearNotFoundCache("mbid-cache-error")
        ).resolves.toBeUndefined();

        expect(mockRedisDel).not.toHaveBeenCalled();
    });
});
