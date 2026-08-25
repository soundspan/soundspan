const redisClient = {
    get: jest.fn(),
    incr: jest.fn(),
    set: jest.fn(),
};

const versionLogger = {
    warn: jest.fn(),
};
const logger = {
    child: jest.fn(() => versionLogger),
};

jest.mock("../../utils/redis", () => ({ redisClient }));
jest.mock("../../utils/logger", () => ({ logger }));

import {
    bumpSearchCacheVersion,
    getSearchCacheVersion,
} from "../searchCacheVersion";

describe("search cache version", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        redisClient.get.mockResolvedValue(null);
        redisClient.incr.mockResolvedValue(2);
        redisClient.set.mockResolvedValue("OK");
    });

    it("reads the current Redis version and defaults a missing value to one", async () => {
        redisClient.get.mockResolvedValueOnce("7").mockResolvedValueOnce(null);

        await expect(getSearchCacheVersion()).resolves.toBe(7);
        await expect(getSearchCacheVersion()).resolves.toBe(1);

        expect(redisClient.get).toHaveBeenNthCalledWith(1, "search:version");
        expect(redisClient.get).toHaveBeenNthCalledWith(2, "search:version");
        expect(redisClient.set).toHaveBeenCalledWith("search:version", "1", {
            NX: true,
        });
    });

    it.each(["", "not-a-number", "0", "-1", "1.5"])(
        "falls back to one for invalid Redis version %p",
        async (storedVersion) => {
            redisClient.get.mockResolvedValueOnce(storedVersion);

            await expect(getSearchCacheVersion()).resolves.toBe(1);

            expect(versionLogger.warn).toHaveBeenCalledWith(
                "Invalid search cache version; using fallback",
                { storedVersion },
            );
        },
    );

    it("falls back to one when Redis reads fail", async () => {
        const error = new Error("redis unavailable");
        redisClient.get.mockRejectedValueOnce(error);

        await expect(getSearchCacheVersion()).resolves.toBe(1);

        expect(versionLogger.warn).toHaveBeenCalledWith(
            "Search cache version read failed; using fallback",
            { error },
        );
    });

    it("increments the shared Redis version", async () => {
        await expect(bumpSearchCacheVersion()).resolves.toBeUndefined();

        expect(redisClient.incr).toHaveBeenCalledWith("search:version");
    });

    it("logs and swallows Redis increment failures", async () => {
        const error = new Error("redis unavailable");
        redisClient.incr.mockRejectedValueOnce(error);

        await expect(bumpSearchCacheVersion()).resolves.toBeUndefined();

        expect(versionLogger.warn).toHaveBeenCalledWith(
            "Search cache version bump failed",
            { error },
        );
    });
});
