const prisma = {
    $queryRaw: jest.fn(),
    artist: {
        findMany: jest.fn(),
    },
    album: {
        findMany: jest.fn(),
    },
    track: {
        findMany: jest.fn(),
    },
    podcast: {
        findMany: jest.fn(),
    },
    podcastEpisode: {
        findMany: jest.fn(),
    },
    audiobook: {
        findMany: jest.fn(),
    },
};

const redisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};

const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

jest.mock("../../utils/redis", () => ({
    redisClient,
}));

jest.mock("../../utils/logger", () => ({
    logger,
}));

import { normalizeCacheQuery, searchService } from "../search";

describe("search service", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        prisma.$queryRaw.mockResolvedValue([]);
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.track.findMany.mockResolvedValue([]);
        prisma.podcast.findMany.mockResolvedValue([]);
        prisma.podcastEpisode.findMany.mockResolvedValue([]);
        prisma.audiobook.findMany.mockResolvedValue([]);
        redisClient.get.mockResolvedValue(null);
        redisClient.setEx.mockResolvedValue("OK");
    });

    it("normalizes cache queries", () => {
        expect(normalizeCacheQuery("  Radio   HEAD  ")).toBe("radio head");
    });

    it("searches artists via fts and fallback branches", async () => {
        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "Radiohead",
                mbid: "mbid-1",
                heroUrl: null,
                summary: "Alt",
                rank: 0.91,
            },
        ]);

        await expect(
            searchService.searchArtists({ query: "radio head", limit: 5, offset: 0 })
        ).resolves.toEqual([
            expect.objectContaining({ id: "artist-1", rank: 0.91 }),
        ]);

        prisma.artist.findMany.mockResolvedValueOnce([
            {
                id: "artist-2",
                name: "Fallback Artist",
                mbid: "mbid-2",
                heroUrl: "https://hero",
            },
        ]);
        await expect(
            searchService.searchArtists({ query: "!!!", limit: 5, offset: 1 })
        ).resolves.toEqual([
            {
                id: "artist-2",
                name: "Fallback Artist",
                mbid: "mbid-2",
                heroUrl: "https://hero",
                rank: 0,
            },
        ]);

        prisma.$queryRaw.mockRejectedValueOnce(new Error("artist fts failed"));
        prisma.artist.findMany.mockResolvedValueOnce([
            {
                id: "artist-3",
                name: "Recovered Artist",
                mbid: "mbid-3",
                heroUrl: null,
            },
        ]);
        await expect(
            searchService.searchArtists({ query: "recovered", limit: 3, offset: 0 })
        ).resolves.toEqual([
            {
                id: "artist-3",
                name: "Recovered Artist",
                mbid: "mbid-3",
                heroUrl: null,
                rank: 0,
            },
        ]);
        expect(logger.error).toHaveBeenCalled();
    });

    it("searches albums and tracks with fts and fallback mapping", async () => {
        prisma.$queryRaw
            .mockResolvedValueOnce([
                {
                    id: "album-1",
                    title: "Album FTS",
                    artistId: "artist-1",
                    artistName: "Artist 1",
                    year: 2020,
                    coverUrl: "https://cover",
                    rank: 0.9,
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "track-1",
                    title: "Track FTS",
                    albumId: "album-1",
                    albumTitle: "Album FTS",
                    artistId: "artist-1",
                    artistName: "Artist 1",
                    duration: 220,
                    rank: 0.88,
                },
            ]);

        await expect(
            searchService.searchAlbums({ query: "album", limit: 3, offset: 0 })
        ).resolves.toEqual([expect.objectContaining({ id: "album-1" })]);

        await expect(
            searchService.searchTracks({ query: "track", limit: 3, offset: 0 })
        ).resolves.toEqual([expect.objectContaining({ id: "track-1" })]);

        prisma.$queryRaw.mockRejectedValueOnce(new Error("album fts failed"));
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "album-2",
                title: "Album Fallback",
                artistId: "artist-2",
                year: null,
                coverUrl: null,
                artist: { name: "Artist 2" },
            },
        ]);
        await expect(
            searchService.searchAlbums({ query: "fallback", limit: 5, offset: 0 })
        ).resolves.toEqual([
            {
                id: "album-2",
                title: "Album Fallback",
                artistId: "artist-2",
                artistName: "Artist 2",
                year: null,
                coverUrl: null,
                rank: 0,
            },
        ]);

        prisma.track.findMany.mockResolvedValueOnce([
            {
                id: "track-2",
                title: "Track Fallback",
                albumId: "album-2",
                duration: 180,
                album: {
                    title: "Album Fallback",
                    artistId: "artist-2",
                    artist: { name: "Artist 2" },
                },
            },
        ]);
        await expect(
            searchService.searchTracks({ query: "***", limit: 5, offset: 0 })
        ).resolves.toEqual([
            {
                id: "track-2",
                title: "Track Fallback",
                albumId: "album-2",
                albumTitle: "Album Fallback",
                artistId: "artist-2",
                artistName: "Artist 2",
                duration: 180,
                rank: 0,
            },
        ]);
    });

    it("searches podcasts, episodes, and audiobooks with fallback behavior", async () => {
        prisma.$queryRaw
            .mockResolvedValueOnce([
                {
                    id: "pod-1",
                    title: "Podcast FTS",
                    author: "Host",
                    description: "Desc",
                    imageUrl: null,
                    episodeCount: 12,
                    rank: 0.7,
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "ep-1",
                    title: "Episode FTS",
                    description: "Ep Desc",
                    podcastId: "pod-1",
                    podcastTitle: "Podcast FTS",
                    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                    duration: 1234,
                    audioUrl: "https://audio/ep-1.mp3",
                    rank: 0.66,
                },
            ])
            .mockResolvedValueOnce([]);

        await expect(
            searchService.searchPodcastsFTS({ query: "pod", limit: 5, offset: 0 })
        ).resolves.toEqual([expect.objectContaining({ id: "pod-1" })]);

        await expect(
            searchService.searchEpisodes({ query: "episode", limit: 5, offset: 0 })
        ).resolves.toEqual([expect.objectContaining({ id: "ep-1" })]);

        prisma.audiobook.findMany.mockResolvedValueOnce([
            {
                id: "book-1",
                title: "Book Fallback",
                author: "Author A",
                narrator: "Narrator A",
                series: null,
                description: "Book Desc",
                coverUrl: "https://raw-cover/book-1.jpg",
                duration: 5000,
            },
        ]);
        await expect(
            searchService.searchAudiobooksFTS({
                query: "audiobook",
                limit: 5,
                offset: 0,
            })
        ).resolves.toEqual([
            expect.objectContaining({
                id: "book-1",
                coverUrl: "/audiobooks/book-1/cover",
                rank: 0,
            }),
        ]);

        prisma.$queryRaw.mockRejectedValueOnce(new Error("podcast fts failed"));
        prisma.podcast.findMany.mockResolvedValueOnce([
            {
                id: "pod-2",
                title: "Podcast Fallback",
                author: "Host 2",
                description: null,
                imageUrl: null,
                episodeCount: 2,
            },
        ]);
        await expect(
            searchService.searchPodcastsFTS({
                query: "fallback pod",
                limit: 5,
                offset: 0,
            })
        ).resolves.toEqual([expect.objectContaining({ id: "pod-2" })]);
    });

    it("returns early for whitespace queries across single-type and aggregate search methods", async () => {
        const emptyResults = {
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        };

        await expect(searchService.searchArtists({ query: "   " })).resolves.toEqual([]);
        await expect(searchService.searchAlbums({ query: "   " })).resolves.toEqual([]);
        await expect(searchService.searchTracks({ query: "   " })).resolves.toEqual([]);
        await expect(searchService.searchPodcasts({ query: "   " })).resolves.toEqual([]);
        await expect(searchService.searchPodcastsFTS({ query: "   " })).resolves.toEqual([]);
        await expect(searchService.searchEpisodes({ query: "   " })).resolves.toEqual([]);
        await expect(
            searchService.searchAudiobooksFTS({ query: "   " })
        ).resolves.toEqual([]);
        await expect(
            searchService.searchByType({ query: "   ", type: "albums" })
        ).resolves.toEqual(emptyResults);

        const allSearch = await searchService.searchAll({ query: "   ", limit: 5 });
        expect(allSearch).toEqual(emptyResults);

        expect(redisClient.get).not.toHaveBeenCalled();
        expect(redisClient.setEx).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.podcast.findMany).not.toHaveBeenCalled();
    });

    it("searchPodcasts handles empty query and database errors deterministically", async () => {
        await expect(searchService.searchPodcasts({ query: "   " })).resolves.toEqual([]);
        expect(prisma.podcast.findMany).not.toHaveBeenCalled();

        prisma.podcast.findMany.mockRejectedValueOnce(
            new Error("podcast like search failed")
        );
        await expect(searchService.searchPodcasts({ query: "rock" })).resolves.toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
            "Podcast search error:",
            expect.any(Error)
        );
    });

    it("searchAll returns empty result for empty query object without touching cache", async () => {
        const results = await searchService.searchAll({
            query: "  ",
            limit: 3,
            genre: "rock",
        });

        expect(results).toEqual({
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        });
        expect(redisClient.get).not.toHaveBeenCalled();
        expect(redisClient.setEx).not.toHaveBeenCalled();
    });

    it("searchByType returns empty result for empty query and warns on cache write failure for unknown type", async () => {
        await expect(
            searchService.searchByType({ query: "   ", type: "tracks", limit: 3 })
        ).resolves.toEqual({
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        });
        expect(redisClient.get).not.toHaveBeenCalled();
        expect(redisClient.setEx).not.toHaveBeenCalled();

        redisClient.get.mockResolvedValueOnce(null);
        redisClient.setEx.mockRejectedValueOnce(new Error("cache write failed"));

        const unknownTypeResult = await searchService.searchByType({
            query: "rock",
            type: "unknown",
            limit: 3,
        });

        expect(unknownTypeResult).toEqual({
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "[SEARCH] Redis write error:",
            expect.any(Error)
        );
        expect(redisClient.setEx).toHaveBeenCalled();
    });

    it("handles searchAll cache-hit transformation and cache-miss aggregation", async () => {
        redisClient.get.mockResolvedValueOnce(
            JSON.stringify({
                artists: [],
                albums: [],
                tracks: [],
                podcasts: [],
                audiobooks: [{ id: "book-9", coverUrl: "https://cached-cover" }],
                episodes: [],
            })
        );

        const cacheHit = await searchService.searchAll({
            query: "book",
            limit: 4,
        });
        expect(cacheHit.audiobooks).toEqual([
            expect.objectContaining({
                id: "book-9",
                coverUrl: "/audiobooks/book-9/cover",
            }),
        ]);

        redisClient.get.mockResolvedValueOnce(null);

        jest.spyOn(searchService, "searchArtists").mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "Artist",
                mbid: "mbid",
                heroUrl: null,
                rank: 1,
            },
        ]);
        jest.spyOn(searchService, "searchAlbums").mockResolvedValueOnce([]);
        jest.spyOn(searchService, "searchTracks").mockResolvedValueOnce([
            {
                id: "track-1",
                title: "Track",
                albumId: "album-1",
                albumTitle: "Album",
                artistId: "artist-1",
                artistName: "Artist",
                duration: 200,
                rank: 1,
            },
        ]);
        jest.spyOn(searchService, "searchPodcastsFTS").mockResolvedValueOnce([]);
        jest.spyOn(searchService, "searchAudiobooksFTS").mockResolvedValueOnce([]);
        jest.spyOn(searchService, "searchEpisodes").mockResolvedValueOnce([]);
        jest.spyOn(searchService, "filterTracksByGenre").mockResolvedValueOnce([
            {
                id: "track-1",
                title: "Track",
                albumId: "album-1",
                albumTitle: "Album",
                artistId: "artist-1",
                artistName: "Artist",
                duration: 200,
                rank: 1,
            },
        ]);
        redisClient.setEx.mockRejectedValueOnce(new Error("redis write failed"));

        const cacheMiss = await searchService.searchAll({
            query: "artist",
            limit: 5,
            genre: "rock",
        });

        expect(cacheMiss.artists).toHaveLength(1);
        expect(cacheMiss.tracks).toHaveLength(1);
        expect(redisClient.setEx).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            "[SEARCH] Redis cache write error:",
            expect.any(Error)
        );
    });

    it("filters tracks by genre and executes searchByType branches with caching", async () => {
        prisma.track.findMany.mockResolvedValueOnce([{ id: "track-2" }]);
        const filtered = await searchService.filterTracksByGenre(
            [
                {
                    id: "track-1",
                    title: "T1",
                    albumId: "a1",
                    albumTitle: "A1",
                    artistId: "ar1",
                    artistName: "Artist 1",
                    duration: 100,
                    rank: 0.2,
                },
                {
                    id: "track-2",
                    title: "T2",
                    albumId: "a2",
                    albumTitle: "A2",
                    artistId: "ar2",
                    artistName: "Artist 2",
                    duration: 200,
                    rank: 0.9,
                },
            ],
            "jazz"
        );
        expect(filtered).toEqual([expect.objectContaining({ id: "track-2" })]);

        redisClient.get.mockResolvedValueOnce(
            JSON.stringify({ artists: [{ id: "a" }], albums: [], tracks: [], podcasts: [], audiobooks: [], episodes: [] })
        );
        await expect(
            searchService.searchByType({ query: "cached", type: "artists", limit: 5 })
        ).resolves.toEqual(
            expect.objectContaining({ artists: [{ id: "a" }] })
        );

        redisClient.get.mockResolvedValue(null);

        jest.spyOn(searchService, "searchArtists").mockResolvedValueOnce([
            {
                id: "artist-10",
                name: "Artist 10",
                mbid: "m10",
                heroUrl: null,
                rank: 1,
            },
        ]);
        await searchService.searchByType({ query: "artist", type: "artists" });

        jest.spyOn(searchService, "searchAlbums").mockResolvedValueOnce([
            {
                id: "album-10",
                title: "Album 10",
                artistId: "artist-10",
                artistName: "Artist 10",
                year: 2020,
                coverUrl: null,
                rank: 1,
            },
        ]);
        await searchService.searchByType({ query: "album", type: "albums" });

        jest.spyOn(searchService, "searchTracks").mockResolvedValueOnce([
            {
                id: "track-10",
                title: "Track 10",
                albumId: "album-10",
                albumTitle: "Album 10",
                artistId: "artist-10",
                artistName: "Artist 10",
                duration: 210,
                rank: 1,
            },
        ]);
        jest.spyOn(searchService, "filterTracksByGenre").mockResolvedValueOnce([
            {
                id: "track-10",
                title: "Track 10",
                albumId: "album-10",
                albumTitle: "Album 10",
                artistId: "artist-10",
                artistName: "Artist 10",
                duration: 210,
                rank: 1,
            },
        ]);
        await searchService.searchByType({
            query: "track",
            type: "tracks",
            genre: "electronic",
        });

        jest.spyOn(searchService, "searchPodcastsFTS").mockResolvedValueOnce([]);
        await searchService.searchByType({ query: "pod", type: "podcasts" });

        jest.spyOn(searchService, "searchAudiobooksFTS").mockResolvedValueOnce([]);
        await searchService.searchByType({ query: "book", type: "audiobooks" });

        jest.spyOn(searchService, "searchEpisodes").mockResolvedValueOnce([]);
        await searchService.searchByType({ query: "ep", type: "episodes" });

        await expect(
            searchService.searchByType({ query: "  ", type: "artists", limit: 5 })
        ).resolves.toEqual({
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        });

        redisClient.get.mockResolvedValueOnce("invalid-json");
        const cachedParseFail = await searchService.searchByType({
            query: "album",
            type: "albums",
            limit: 5,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "[SEARCH] Redis read error:",
            expect.any(Error)
        );
        expect(cachedParseFail.albums).toEqual([]);

        redisClient.get.mockResolvedValueOnce("{oops");
        const allParseFail = await searchService.searchAll({
            query: "cached",
            limit: 4,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "[SEARCH] Redis cache read error:",
            expect.any(Error)
        );
        expect(allParseFail).toEqual({
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        });

        await expect(
            searchService.searchByType({ query: "noop", type: "unknown" })
        ).resolves.toEqual({
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        });

        expect(redisClient.setEx).toHaveBeenCalled();
    });

    it("searchAudiobooksFTS falls back to local search when full-text results are empty", async () => {
        prisma.$queryRaw.mockResolvedValueOnce([]);
        prisma.audiobook.findMany.mockResolvedValueOnce([
            {
                id: "book-2",
                title: "Back Cover",
                author: "Author",
                narrator: "Narrator",
                series: null,
                description: "desc",
                coverUrl: "https://raw-cover/book-2.jpg",
                duration: 3333,
            },
        ]);

        const results = await searchService.searchAudiobooksFTS({
            query: "back cover",
            limit: 5,
        });

        expect(results).toEqual([
            expect.objectContaining({
                id: "book-2",
                title: "Back Cover",
                coverUrl: "/audiobooks/book-2/cover",
                rank: 0,
            }),
        ]);
        expect(prisma.audiobook.findMany).toHaveBeenCalled();
    });

    it("filterTracksByGenre returns early on empty input", async () => {
        const filtered = await searchService.filterTracksByGenre([], "jazz");

        expect(filtered).toEqual([]);
        expect(prisma.track.findMany).not.toHaveBeenCalled();
    });
});
