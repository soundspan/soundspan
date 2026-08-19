const get = jest.fn();
const setEx = jest.fn();
const del = jest.fn();
const record = jest.fn();
const warn = jest.fn();
jest.mock("../../../utils/redis", () => ({ redisClient: { get, setEx, del } }));
jest.mock("../../../metrics", () => ({
    recordLibraryHealthCacheResult: record,
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn }) },
}));

import {
    getCachedLibraryHealthPanel,
    invalidateLibraryHealthDashboardCache,
    LIBRARY_HEALTH_CACHE_KEYS,
} from "../cache";

describe("library health cache", () => {
    beforeEach(() => jest.clearAllMocks());

    it("returns hits without loading", async () => {
        get.mockResolvedValueOnce('{"total":2}');
        const loader = jest.fn();
        await expect(
            getCachedLibraryHealthPanel("summary", loader),
        ).resolves.toEqual({ total: 2 });
        expect(loader).not.toHaveBeenCalled();
        expect(record).toHaveBeenCalledWith("summary", "hit");
    });

    it("coalesces misses and caches for fifteen minutes", async () => {
        get.mockResolvedValueOnce(null);
        setEx.mockResolvedValueOnce("OK");
        const loader = jest.fn(async () => ({ total: 3 }));
        const results = await Promise.all([
            getCachedLibraryHealthPanel("storage", loader),
            getCachedLibraryHealthPanel("storage", loader),
        ]);
        expect(results).toEqual([{ total: 3 }, { total: 3 }]);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(setEx).toHaveBeenCalledWith(
            LIBRARY_HEALTH_CACHE_KEYS.storage,
            900,
            JSON.stringify({ total: 3 }),
        );
    });

    it("fails open on Redis errors and explicitly deletes known keys", async () => {
        get.mockRejectedValueOnce(new Error("offline"));
        setEx.mockRejectedValueOnce(new Error("offline"));
        await expect(
            getCachedLibraryHealthPanel("quality", async () => ({ total: 4 })),
        ).resolves.toEqual({ total: 4 });
        expect(record).toHaveBeenCalledWith("quality", "error");
        expect(warn).toHaveBeenCalled();
        del.mockResolvedValueOnce(4);
        await invalidateLibraryHealthDashboardCache();
        expect(del).toHaveBeenCalledWith(
            Object.values(LIBRARY_HEALTH_CACHE_KEYS),
        );
    });
});
