import axios from "axios";
import { redisClient } from "../../utils/redis";
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
                requestFn(),
        ),
    },
}));

jest.mock("../musicbrainz", () => ({
    isValidMbid: jest.requireActual("../musicbrainz").isValidMbid,
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;
const mockRateLimiterExecute = rateLimiter.execute as jest.Mock;

const CACHE_HIT_MBID = "11111111-1111-4111-8111-111111111111";
const DEDUPE_MBID = "22222222-2222-4222-8222-222222222222";
const NOT_FOUND_MBID = "44444444-4444-4444-8444-444444444444";
const TRANSIENT_ERROR_MBID = "55555555-5555-4555-8555-555555555555";

describe("coverArtService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisDel.mockResolvedValue(1);
        mockRateLimiterExecute.mockImplementation(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn(),
        );
    });

    it("returns cached URL without making upstream calls", async () => {
        mockRedisGet.mockResolvedValue("https://cached.example/cover.jpg");

        const result = await coverArtService.getCoverArt(CACHE_HIT_MBID);

        expect(result).toBe("https://cached.example/cover.jpg");
        expect(mockRateLimiterExecute).not.toHaveBeenCalled();
    });

    it("skips temporary MBIDs without calling upstream providers", async () => {
        const result = await coverArtService.getCoverArt("temp-12345");

        expect(result).toBeNull();
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockRateLimiterExecute).not.toHaveBeenCalled();
    });

    it("quietly rejects federation placeholders before cache or upstream access", async () => {
        const result = await coverArtService.getCoverArt(
            "federation:peer-1:YWxidW0tMQ",
        );

        expect(result).toBeNull();
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockRateLimiterExecute).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
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

        const firstRequest = coverArtService.getCoverArt(DEDUPE_MBID);
        const secondRequest = coverArtService.getCoverArt(DEDUPE_MBID);

        await Promise.resolve();
        expect(mockRateLimiterExecute).toHaveBeenCalledTimes(1);

        resolveCoverArtRequest({
            data: {
                images: [
                    { front: true, image: "https://images.example/front.jpg" },
                ],
            },
        });

        await expect(firstRequest).resolves.toBe(
            "https://images.example/front.jpg",
        );
        await expect(secondRequest).resolves.toBe(
            "https://images.example/front.jpg",
        );
    });

    it("sends a well-formed release-group MBID to Cover Art Archive unchanged", async () => {
        mockAxiosGet.mockResolvedValue({
            data: {
                images: [
                    {
                        front: true,
                        image: "https://images.example/valid-mbid.jpg",
                    },
                ],
            },
        });

        const result = await coverArtService.getCoverArt(DEDUPE_MBID);

        expect(result).toBe("https://images.example/valid-mbid.jpg");
        expect(mockAxiosGet).toHaveBeenCalledWith(
            `https://coverartarchive.org/release-group/${DEDUPE_MBID}`,
            { timeout: 5000 },
        );
    });

    it("negative-caches a Cover Art Archive not-found result", async () => {
        mockAxiosGet.mockImplementation((url: string) => {
            if (url.includes("coverartarchive.org")) {
                return Promise.reject({ response: { status: 404 } });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await coverArtService.getCoverArt(NOT_FOUND_MBID);

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            `caa:${NOT_FOUND_MBID}`,
            30 * 24 * 60 * 60,
            "NOT_FOUND",
        );
    });

    it("does not negative-cache transient Cover Art Archive failures", async () => {
        mockAxiosGet.mockImplementation((url: string) => {
            if (url.includes("coverartarchive.org")) {
                return Promise.reject(new Error("socket timeout"));
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await coverArtService.getCoverArt(TRANSIENT_ERROR_MBID);

        expect(result).toBeNull();
        expect(mockRedisSetEx).not.toHaveBeenCalledWith(
            `caa:${TRANSIENT_ERROR_MBID}`,
            30 * 24 * 60 * 60,
            "NOT_FOUND",
        );
    });

    it("clears stale NOT_FOUND cache entries but keeps non-NOT_FOUND values", async () => {
        mockRedisGet
            .mockResolvedValueOnce("NOT_FOUND")
            .mockResolvedValueOnce("https://cached.example/cover.jpg");

        await expect(
            coverArtService.clearNotFoundCache(" mbid-clear-me "),
        ).resolves.toBeUndefined();
        await expect(
            coverArtService.clearNotFoundCache("mbid-keep-value"),
        ).resolves.toBeUndefined();

        expect(mockRedisGet).toHaveBeenNthCalledWith(1, "caa:mbid-clear-me");
        expect(mockRedisGet).toHaveBeenNthCalledWith(2, "caa:mbid-keep-value");
        expect(mockRedisDel).toHaveBeenCalledTimes(1);
        expect(mockRedisDel).toHaveBeenCalledWith("caa:mbid-clear-me");
    });

    it("ignores redis errors while clearing stale NOT_FOUND cache entries", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("redis unavailable"));

        await expect(
            coverArtService.clearNotFoundCache("mbid-cache-error"),
        ).resolves.toBeUndefined();

        expect(mockRedisDel).not.toHaveBeenCalled();
    });
});
