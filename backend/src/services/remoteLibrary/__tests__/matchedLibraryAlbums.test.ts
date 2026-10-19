jest.mock("../../../utils/db", () => ({
    prisma: {
        album: { findMany: jest.fn() },
    },
}));

import { prisma } from "../../../utils/db";
import { findLibraryHeldReleaseGroups } from "../matchedLibraryAlbums";

const mockFindMany = prisma.album.findMany as jest.Mock;

describe("matched library album lookup", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindMany.mockResolvedValue([]);
    });

    it("does not query for empty or blank release-group ids", async () => {
        await expect(
            findLibraryHeldReleaseGroups(["", "   "]),
        ).resolves.toEqual(new Set());

        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it("deduplicates ids and requires a visible local track", async () => {
        mockFindMany.mockResolvedValueOnce([{ rgMbid: "rg-held" }]);

        await expect(
            findLibraryHeldReleaseGroups(["rg-held", "rg-held", "rg-unheld"]),
        ).resolves.toEqual(new Set(["rg-held"]));

        const query = mockFindMany.mock.calls[0][0];
        expect(query.where.location).toBe("LIBRARY");
        expect(query.where.rgMbid.in).toEqual(["rg-held", "rg-unheld"]);
        expect(query.where.tracks?.some).toEqual(expect.any(Object));
    });

    it("queries at most one thousand ids per chunk", async () => {
        const ids = Array.from({ length: 1_001 }, (_, index) => `rg-${index}`);

        await findLibraryHeldReleaseGroups(ids);

        expect(mockFindMany).toHaveBeenCalledTimes(2);
        expect(mockFindMany.mock.calls[0][0].where.rgMbid.in).toHaveLength(
            1_000,
        );
        expect(mockFindMany.mock.calls[1][0].where.rgMbid.in).toEqual([
            "rg-1000",
        ]);
    });

    it("returns release-group ids from every chunk", async () => {
        const ids = Array.from({ length: 1_001 }, (_, index) => `rg-${index}`);
        mockFindMany
            .mockResolvedValueOnce([{ rgMbid: "rg-0" }])
            .mockResolvedValueOnce([{ rgMbid: "rg-1000" }]);

        await expect(findLibraryHeldReleaseGroups(ids)).resolves.toEqual(
            new Set(["rg-0", "rg-1000"]),
        );
    });

    it("propagates Prisma failures", async () => {
        const failure = new Error("database unavailable");
        mockFindMany.mockRejectedValueOnce(failure);

        await expect(findLibraryHeldReleaseGroups(["rg-held"])).rejects.toBe(
            failure,
        );
    });
});
