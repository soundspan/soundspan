const redisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};
const getSearchCacheVersion = jest.fn();
const artistFindMany = jest.fn();

jest.mock("../../utils/redis", () => ({ redisClient }));
jest.mock("../../utils/db", () => ({
    prisma: { artist: { findMany: artistFindMany } },
}));
jest.mock("../searchCacheVersion", () => ({ getSearchCacheVersion }));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

import { loadSubsonicArtistIndexSnapshot } from "../subsonicArtistIndexCache";

const databaseArtist = {
    id: "artist-1",
    name: "Artist One",
    heroUrl: "https://example.test/artist.jpg",
    lastSynced: new Date("2026-08-25T12:00:00.000Z"),
    libraryAlbumCount: 2,
};

describe("Subsonic artist index cache", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getSearchCacheVersion.mockResolvedValue(7);
        redisClient.get.mockResolvedValue(null);
        redisClient.setEx.mockResolvedValue("OK");
        artistFindMany.mockResolvedValue([databaseArtist]);
    });

    it("loads counts-derived artists on a miss and caches the snapshot", async () => {
        await expect(loadSubsonicArtistIndexSnapshot()).resolves.toEqual({
            artists: [
                {
                    id: "artist-1",
                    name: "Artist One",
                    heroUrl: "https://example.test/artist.jpg",
                    albumCount: 2,
                },
            ],
            lastModified: databaseArtist.lastSynced.getTime(),
        });

        expect(redisClient.get).toHaveBeenCalledWith(
            "subsonic:artist-index:v7",
        );
        expect(artistFindMany).toHaveBeenCalledWith({
            where: { libraryAlbumCount: { gt: 0 } },
            select: {
                id: true,
                name: true,
                heroUrl: true,
                lastSynced: true,
                libraryAlbumCount: true,
            },
            orderBy: { name: "asc" },
        });
        expect(redisClient.setEx).toHaveBeenCalledWith(
            "subsonic:artist-index:v7",
            300,
            expect.any(String),
        );
    });

    it("returns a valid cached snapshot without querying artists", async () => {
        const cached = {
            artists: [
                {
                    id: "artist-cached",
                    name: "Cached Artist",
                    heroUrl: null,
                    albumCount: 4,
                },
            ],
            lastModified: 1_777_000_000_000,
        };
        redisClient.get.mockResolvedValue(JSON.stringify(cached));

        await expect(loadSubsonicArtistIndexSnapshot()).resolves.toEqual(
            cached,
        );

        expect(artistFindMany).not.toHaveBeenCalled();
        expect(redisClient.setEx).not.toHaveBeenCalled();
    });

    it("uses a fresh namespace after the shared library version advances", async () => {
        const cached = {
            artists: [],
            lastModified: 1_777_000_000_000,
        };
        getSearchCacheVersion.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
        redisClient.get
            .mockResolvedValueOnce(JSON.stringify(cached))
            .mockResolvedValueOnce(null);

        await loadSubsonicArtistIndexSnapshot();
        await loadSubsonicArtistIndexSnapshot();

        expect(redisClient.get).toHaveBeenNthCalledWith(
            1,
            "subsonic:artist-index:v7",
        );
        expect(redisClient.get).toHaveBeenNthCalledWith(
            2,
            "subsonic:artist-index:v8",
        );
        expect(artistFindMany).toHaveBeenCalledTimes(1);
    });
});
