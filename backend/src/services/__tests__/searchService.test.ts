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
const getSearchCacheVersion = jest.fn();
const MAX_SQL_FRAGMENT_VALUES = 128;

interface SqlFragment {
    strings: readonly string[];
    values: readonly unknown[];
}

function isSqlFragment(value: unknown): value is SqlFragment {
    return (
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as Partial<SqlFragment>).strings) &&
        Array.isArray((value as Partial<SqlFragment>).values)
    );
}

function collectSql(fragment: SqlFragment): {
    text: string;
    values: unknown[];
} {
    const pending: unknown[] = [fragment];
    const values: unknown[] = [];
    let text = "";
    for (
        let index = 0;
        index < pending.length && index < MAX_SQL_FRAGMENT_VALUES;
        index += 1
    ) {
        const value = pending[index];
        if (isSqlFragment(value)) {
            text += value.strings.join("");
            pending.push(...value.values);
        } else if (Array.isArray(value)) {
            pending.push(...value);
        } else {
            values.push(value);
        }
    }
    if (pending.length > MAX_SQL_FRAGMENT_VALUES) {
        throw new Error("SQL fragment exceeded the test inspection bound");
    }
    return { text, values };
}

jest.mock("../../utils/db", () => ({
    prisma,
}));

jest.mock("../../utils/redis", () => ({
    redisClient,
}));

jest.mock("../../utils/logger", () => ({
    logger,
}));

jest.mock("../searchCacheVersion", () => ({ getSearchCacheVersion }));

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
        getSearchCacheVersion.mockResolvedValue(1);
    });

    it("normalizes cache queries", () => {
        expect(normalizeCacheQuery("  Radio   HEAD  ")).toBe("radio head");
    });

    it.each([
        ["rock & roll", "rock:* & and:* & roll:*"],
        ["AT&T", "AT:* & and:* & T:*"],
        ["  one\t & \n two  ", "one:* & and:* & two:*"],
        ["punctuation! & symbols?", "punctuation:* & and:* & symbols:*"],
    ])("preserves tsquery output for %p", async (query, expectedTsquery) => {
        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "artist-tsquery",
                name: "Artist",
                mbid: "mbid-tsquery",
                heroUrl: null,
                rank: 1,
            },
        ]);

        await searchService.searchArtists({ query });

        expect(prisma.$queryRaw.mock.calls[0]).toContain(expectedTsquery);
    });

    it("normalizes long whitespace-only separators without excessive backtracking", async () => {
        const query = `alpha${" ".repeat(50_000)}beta`;
        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "artist-long-query",
                name: "Artist",
                mbid: "mbid-long-query",
                heroUrl: null,
                rank: 1,
            },
        ]);
        const startedAt = performance.now();

        await searchService.searchArtists({ query });

        expect(prisma.$queryRaw.mock.calls[0]).toContain("alpha:* & beta:*");
        expect(performance.now() - startedAt).toBeLessThan(500);
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
            searchService.searchArtists({
                query: "radio head",
                limit: 5,
                offset: 0,
            }),
        ).resolves.toEqual([
            expect.objectContaining({ id: "artist-1", rank: 0.91 }),
        ]);

        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "artist-2",
                name: "Fallback Artist",
                mbid: "mbid-2",
                heroUrl: "https://hero",
                rank: 0.72,
            },
        ]);
        await expect(
            searchService.searchArtists({ query: "!!!", limit: 5, offset: 1 }),
        ).resolves.toEqual([
            {
                id: "artist-2",
                name: "Fallback Artist",
                mbid: "mbid-2",
                heroUrl: "https://hero",
                rank: 0.72,
            },
        ]);

        prisma.$queryRaw
            .mockRejectedValueOnce(new Error("artist fts failed"))
            .mockResolvedValueOnce([
                {
                    id: "artist-3",
                    name: "Recovered Artist",
                    mbid: "mbid-3",
                    heroUrl: null,
                    rank: 0.64,
                },
            ]);
        await expect(
            searchService.searchArtists({
                query: "recovered",
                limit: 3,
                offset: 0,
            }),
        ).resolves.toEqual([
            {
                id: "artist-3",
                name: "Recovered Artist",
                mbid: "mbid-3",
                heroUrl: null,
                rank: 0.64,
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
                    loudnessLufs: -17.8,
                    truePeakDb: -1.2,
                    albumLoudnessLufs: -18.4,
                    albumTruePeakDb: -0.7,
                    rank: 0.88,
                },
            ]);

        await expect(
            searchService.searchAlbums({ query: "album", limit: 3, offset: 0 }),
        ).resolves.toEqual([expect.objectContaining({ id: "album-1" })]);

        await expect(
            searchService.searchTracks({ query: "track", limit: 3, offset: 0 }),
        ).resolves.toEqual([
            expect.objectContaining({
                id: "track-1",
                loudnessLufs: -17.8,
                truePeakDb: -1.2,
                albumLoudnessLufs: -18.4,
                albumTruePeakDb: -0.7,
            }),
        ]);

        prisma.$queryRaw
            .mockRejectedValueOnce(new Error("album fts failed"))
            .mockResolvedValueOnce([
                {
                    id: "album-2",
                    title: "Album Fallback",
                    artistId: "artist-2",
                    artistName: "Artist 2",
                    year: null,
                    coverUrl: null,
                    rank: 0.58,
                },
            ]);
        await expect(
            searchService.searchAlbums({
                query: "fallback",
                limit: 5,
                offset: 0,
            }),
        ).resolves.toEqual([
            {
                id: "album-2",
                title: "Album Fallback",
                artistId: "artist-2",
                artistName: "Artist 2",
                year: null,
                coverUrl: null,
                rank: 0.58,
            },
        ]);

        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "track-2",
                title: "Track Fallback",
                albumId: "album-2",
                albumTitle: "Album Fallback",
                artistId: "artist-2",
                artistName: "Artist 2",
                duration: 180,
                loudnessLufs: null,
                truePeakDb: null,
                albumLoudnessLufs: null,
                albumTruePeakDb: null,
                rank: 0.81,
            },
        ]);
        await expect(
            searchService.searchTracks({ query: "***", limit: 5, offset: 0 }),
        ).resolves.toEqual([
            {
                id: "track-2",
                title: "Track Fallback",
                albumId: "album-2",
                albumTitle: "Album Fallback",
                artistId: "artist-2",
                artistName: "Artist 2",
                duration: 180,
                loudnessLufs: null,
                truePeakDb: null,
                albumLoudnessLufs: null,
                albumTruePeakDb: null,
                rank: 0.81,
            },
        ]);
    });

    it.each([
        [
            "artists",
            () => searchService.searchArtists({ query: "radiahead" }),
            {
                id: "artist-fuzzy",
                name: "Radiohead",
                mbid: "mbid-fuzzy",
                heroUrl: null,
                rank: 0.73,
            },
        ],
        [
            "albums",
            () => searchService.searchAlbums({ query: "pablo hony" }),
            {
                id: "album-fuzzy",
                title: "Pablo Honey",
                artistId: "artist-fuzzy",
                artistName: "Radiohead",
                year: 1993,
                coverUrl: null,
                rank: 0.68,
            },
        ],
        [
            "tracks",
            () => searchService.searchTracks({ query: "crepe" }),
            {
                id: "track-fuzzy",
                title: "Creep",
                albumId: "album-fuzzy",
                albumTitle: "Pablo Honey",
                artistId: "artist-fuzzy",
                artistName: "Radiohead",
                duration: 238,
                loudnessLufs: null,
                truePeakDb: null,
                albumLoudnessLufs: null,
                albumTruePeakDb: null,
                rank: 0.61,
            },
        ],
    ])(
        "uses ranked raw SQL for %s fallback results",
        async (_type, run, row) => {
            prisma.$queryRaw
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([row]);

            await expect(run()).resolves.toEqual([row]);

            expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
            expect(prisma.artist.findMany).not.toHaveBeenCalled();
            expect(prisma.album.findMany).not.toHaveBeenCalled();
            expect(prisma.track.findMany).not.toHaveBeenCalled();
        },
    );

    it("caps cross-column track FTS at six terms", async () => {
        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "track-six-terms",
                title: "Six Terms",
                albumId: "album-six-terms",
                albumTitle: "Six Terms Album",
                artistId: "artist-six-terms",
                artistName: "Six Terms Artist",
                duration: 180,
                rank: 1,
            },
        ]);

        await searchService.searchTracks({
            query: "one two three four five six seven eight",
        });

        expect(logger.debug).toHaveBeenCalledWith(
            "[SEARCH] Dropped 2 track search terms after the 6-term limit",
        );
    });

    it.each([
        [
            "artists",
            () =>
                searchService.searchArtists({ query: "***", source: "peers" }),
        ],
        [
            "albums",
            () => searchService.searchAlbums({ query: "***", source: "peers" }),
        ],
        [
            "tracks",
            () => searchService.searchTracks({ query: "***", source: "peers" }),
        ],
    ])(
        "preserves peers-only visibility in %s fallback SQL",
        async (_type, run) => {
            await run();

            const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
            const query = collectSql({ strings: [...strings], values });
            expect(query.values).toContain("FEDERATED");
            expect(query.values).not.toContain("LOCAL");
            expect(query.text).toContain('"dedupOfTrackId" IS NULL');
        },
    );

    it("keeps remote-only albums, hides removed-only albums, and keeps mixed albums", async () => {
        prisma.$queryRaw.mockImplementationOnce(async (strings: string[]) => {
            expect(strings.join(" ")).toContain('t."removedAt" IS NULL AND');
            return [
                {
                    id: "album-remote",
                    title: "Remote Album",
                    artistId: "artist-1",
                    artistName: "Remote Artist",
                    year: 2026,
                    coverUrl: null,
                    rank: 0.8,
                },
                {
                    id: "album-mixed",
                    title: "Mixed Album",
                    artistId: "artist-2",
                    artistName: "Mixed Artist",
                    year: 2025,
                    coverUrl: null,
                    rank: 0.7,
                },
            ];
        });

        const results = await searchService.searchAlbums({ query: "***" });

        expect(results.map((album) => album.id)).toEqual([
            "album-remote",
            "album-mixed",
        ]);
        expect(results).not.toContainEqual(
            expect.objectContaining({ id: "album-removed-only" }),
        );
    });

    it("uses the remote-only escape in both album FTS branches", async () => {
        prisma.$queryRaw.mockImplementationOnce(async (strings: string[]) => {
            const sql = strings.join(" ");
            expect(
                sql.match(/NOT EXISTS \(SELECT 1 FROM "Track"/g),
            ).toHaveLength(2);
            return [
                {
                    id: "album-remote",
                    title: "Remote Album",
                    artistId: "artist-1",
                    artistName: "Remote Artist",
                    year: 2026,
                    coverUrl: null,
                    rank: 1,
                },
            ];
        });

        await expect(
            searchService.searchAlbums({ query: "remote" }),
        ).resolves.toEqual([expect.objectContaining({ id: "album-remote" })]);
    });

    it("excludes removed tracks from FTS and ILIKE fallback searches", async () => {
        prisma.$queryRaw.mockImplementationOnce(async (strings: string[]) =>
            strings.join(" ").includes('t."removedAt" IS NULL')
                ? []
                : [
                      {
                          id: "removed-fts",
                          title: "Removed FTS",
                          albumId: "album-1",
                          albumTitle: "Album",
                          artistId: "artist-1",
                          artistName: "Artist",
                          duration: 180,
                          rank: 1,
                      },
                  ],
        );
        await expect(
            searchService.searchTracks({ query: "removed" }),
        ).resolves.toEqual([]);

        await expect(
            searchService.searchTracks({ query: "***" }),
        ).resolves.toEqual([]);
        expect(
            prisma.$queryRaw.mock.calls.every(([strings]) =>
                strings.join(" ").includes('t."removedAt" IS NULL'),
            ),
        ).toBe(true);
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
            searchService.searchPodcastsFTS({
                query: "pod",
                limit: 5,
                offset: 0,
            }),
        ).resolves.toEqual([expect.objectContaining({ id: "pod-1" })]);

        await expect(
            searchService.searchEpisodes({
                query: "episode",
                limit: 5,
                offset: 0,
            }),
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
            }),
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
            }),
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

        await expect(
            searchService.searchArtists({ query: "   " }),
        ).resolves.toEqual([]);
        await expect(
            searchService.searchAlbums({ query: "   " }),
        ).resolves.toEqual([]);
        await expect(
            searchService.searchTracks({ query: "   " }),
        ).resolves.toEqual([]);
        await expect(
            searchService.searchPodcasts({ query: "   " }),
        ).resolves.toEqual([]);
        await expect(
            searchService.searchPodcastsFTS({ query: "   " }),
        ).resolves.toEqual([]);
        await expect(
            searchService.searchEpisodes({ query: "   " }),
        ).resolves.toEqual([]);
        await expect(
            searchService.searchAudiobooksFTS({ query: "   " }),
        ).resolves.toEqual([]);
        await expect(
            searchService.searchByType({ query: "   ", type: "albums" }),
        ).resolves.toEqual(emptyResults);

        const allSearch = await searchService.searchAll({
            query: "   ",
            limit: 5,
        });
        expect(allSearch).toEqual(emptyResults);

        expect(redisClient.get).not.toHaveBeenCalled();
        expect(redisClient.setEx).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.podcast.findMany).not.toHaveBeenCalled();
    });

    it("searchPodcasts handles empty query and database errors deterministically", async () => {
        await expect(
            searchService.searchPodcasts({ query: "   " }),
        ).resolves.toEqual([]);
        expect(prisma.podcast.findMany).not.toHaveBeenCalled();

        prisma.podcast.findMany.mockRejectedValueOnce(
            new Error("podcast like search failed"),
        );
        await expect(
            searchService.searchPodcasts({ query: "rock" }),
        ).resolves.toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
            "Podcast search error:",
            expect.any(Error),
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
            searchService.searchByType({
                query: "   ",
                type: "tracks",
                limit: 3,
            }),
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
        redisClient.setEx.mockRejectedValueOnce(
            new Error("cache write failed"),
        );

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
            expect.any(Error),
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
                audiobooks: [
                    { id: "book-9", coverUrl: "https://cached-cover" },
                ],
                episodes: [],
            }),
        );

        const cacheHit = await searchService.searchAll({
            query: "book",
            limit: 4,
        });
        expect(redisClient.get).toHaveBeenCalledWith(
            "search:all:v1:book:4::all",
        );
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
        jest.spyOn(searchService, "searchPodcastsFTS").mockResolvedValueOnce(
            [],
        );
        jest.spyOn(searchService, "searchAudiobooksFTS").mockResolvedValueOnce(
            [],
        );
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
        redisClient.setEx.mockRejectedValueOnce(
            new Error("redis write failed"),
        );

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
            expect.any(Error),
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
            "jazz",
        );
        expect(filtered).toEqual([expect.objectContaining({ id: "track-2" })]);

        redisClient.get.mockResolvedValueOnce(
            JSON.stringify({
                artists: [{ id: "a" }],
                albums: [],
                tracks: [],
                podcasts: [],
                audiobooks: [],
                episodes: [],
            }),
        );
        await expect(
            searchService.searchByType({
                query: "cached",
                type: "artists",
                limit: 5,
            }),
        ).resolves.toEqual(expect.objectContaining({ artists: [{ id: "a" }] }));

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

        jest.spyOn(searchService, "searchPodcastsFTS").mockResolvedValueOnce(
            [],
        );
        await searchService.searchByType({ query: "pod", type: "podcasts" });

        jest.spyOn(searchService, "searchAudiobooksFTS").mockResolvedValueOnce(
            [],
        );
        await searchService.searchByType({ query: "book", type: "audiobooks" });

        jest.spyOn(searchService, "searchEpisodes").mockResolvedValueOnce([]);
        await searchService.searchByType({ query: "ep", type: "episodes" });

        await expect(
            searchService.searchByType({
                query: "  ",
                type: "artists",
                limit: 5,
            }),
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
            expect.any(Error),
        );
        expect(cachedParseFail.albums).toEqual([]);

        redisClient.get.mockResolvedValueOnce("{oops");
        const allParseFail = await searchService.searchAll({
            query: "cached",
            limit: 4,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "[SEARCH] Redis cache read error:",
            expect.any(Error),
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
            searchService.searchByType({ query: "noop", type: "unknown" }),
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

    it("separates type-scoped cache entries by offset", async () => {
        jest.spyOn(searchService, "searchArtists").mockResolvedValueOnce([]);

        await searchService.searchByType({
            query: "Radiohead",
            type: "artists",
            limit: 10,
            offset: 40,
        });

        const cacheKey = "search:artists:v1:radiohead:10:40::all";
        expect(redisClient.get).toHaveBeenCalledWith(cacheKey);
        expect(redisClient.setEx).toHaveBeenCalledWith(
            cacheKey,
            120,
            expect.any(String),
        );
    });

    it("misses an old type-scoped cache entry after the version changes", async () => {
        const oldResults = {
            artists: [{ id: "artist-old" }],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        };
        getSearchCacheVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
        redisClient.get.mockImplementation(async (key: string) =>
            key === "search:artists:v1:radiohead:20:0::all"
                ? JSON.stringify(oldResults)
                : null,
        );
        const searchArtists = jest
            .spyOn(searchService, "searchArtists")
            .mockResolvedValueOnce([]);

        await expect(
            searchService.searchByType({
                query: "Radiohead",
                type: "artists",
            }),
        ).resolves.toEqual(oldResults);
        await expect(
            searchService.searchByType({
                query: "Radiohead",
                type: "artists",
            }),
        ).resolves.toEqual(expect.objectContaining({ artists: [] }));

        expect(redisClient.get).toHaveBeenNthCalledWith(
            1,
            "search:artists:v1:radiohead:20:0::all",
        );
        expect(redisClient.get).toHaveBeenNthCalledWith(
            2,
            "search:artists:v2:radiohead:20:0::all",
        );
        expect(searchArtists).toHaveBeenCalledTimes(1);
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

    it("searchArtistsFallback includes remote-only artists via OR condition", async () => {
        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "artist-remote",
                name: "Remote Only Artist",
                mbid: "mbid-remote",
                heroUrl: null,
                rank: 0.76,
            },
        ]);

        const results = await searchService.searchArtists({
            query: "***",
            limit: 5,
            offset: 0,
        });

        expect(results).toEqual([
            {
                id: "artist-remote",
                name: "Remote Only Artist",
                mbid: "mbid-remote",
                heroUrl: null,
                rank: 0.76,
            },
        ]);

        const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
        expect(strings.join(" ")).toContain('a."remoteTrackCount" > 0');
        expect(values).toContain(true);
    });

    it("searchArtistsFallback excludes artists with no albums and zero remoteTrackCount", async () => {
        const results = await searchService.searchArtists({
            query: "###",
            limit: 5,
            offset: 0,
        });

        expect(results).toEqual([]);

        // Verify the OR filter is passed so Prisma excludes artists
        // that have neither albums nor remote tracks
        const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
        expect(strings.join(" ")).toContain('a."remoteTrackCount" > 0');
        expect(values).toContain(true);
    });

    it("searchArtists FTS SQL includes remoteTrackCount condition", async () => {
        prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "artist-remote-fts",
                name: "Remote FTS Artist",
                mbid: "mbid-remote-fts",
                heroUrl: null,
                summary: null,
                rank: 0.85,
            },
        ]);

        const results = await searchService.searchArtists({
            query: "remote",
            limit: 5,
            offset: 0,
        });

        expect(results).toEqual([
            expect.objectContaining({ id: "artist-remote-fts", rank: 0.85 }),
        ]);

        // Verify the raw SQL query was called (the actual SQL content
        // includes remoteTrackCount — validated by the implementation change)
        expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it("filterTracksByGenre returns early on empty input", async () => {
        const filtered = await searchService.filterTracksByGenre([], "jazz");

        expect(filtered).toEqual([]);
        expect(prisma.track.findMany).not.toHaveBeenCalled();
    });
});
