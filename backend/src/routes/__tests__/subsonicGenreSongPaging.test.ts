const queryRaw = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: { $queryRaw: queryRaw },
}));
jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

import {
    buildSongsByGenreWhere,
    loadSongsByGenrePageIds,
} from "../subsonic/genreSongPaging";

describe("Subsonic genre song paging", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        queryRaw.mockResolvedValue([{ id: "track-2" }, { id: "track-7" }]);
    });

    it("keeps the Prisma membership predicate at the shared browse boundary", () => {
        expect(buildSongsByGenreWhere("RoCk")).toEqual(
            expect.objectContaining({
                removedAt: null,
                AND: expect.any(Array),
                album: { location: { in: ["LIBRARY", "FEDERATED"] } },
                trackGenres: {
                    some: {
                        genre: {
                            name: { equals: "RoCk", mode: "insensitive" },
                        },
                    },
                },
            }),
        );
    });

    it("returns the SQL page and binds genre, day, limit, and offset", async () => {
        await expect(
            loadSongsByGenrePageIds("RoCk", "2026-08-25", 2, 4),
        ).resolves.toEqual(["track-2", "track-7"]);

        const query = queryRaw.mock.calls[0]?.[0];
        expect(query?.values).toEqual(["RoCk", "2026-08-25", 2, 4]);
        expect(query?.sql).toContain("LOWER(genre_row.name) = LOWER(?)");
        expect(query?.sql).toContain("ORDER BY hashtext(track.id || ?)");
        expect(query?.sql).toContain("LIMIT ? OFFSET ?");
    });

    it("returns an empty page for offsets beyond JavaScript's safe range", async () => {
        await expect(
            loadSongsByGenrePageIds("Rock", "2026-08-25", 2, Infinity),
        ).resolves.toEqual([]);

        expect(queryRaw).not.toHaveBeenCalled();
    });
});
