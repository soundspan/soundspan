import axios from "axios";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { deezerService } from "../deezer";

jest.mock("axios");

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;

describe("deezerService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
    });

    it("serves artist image from cache and cache-miss API with fallback image fields", async () => {
        mockRedisGet.mockResolvedValueOnce("https://cache.example/a.jpg");
        await expect(deezerService.getArtistImage("Artist A")).resolves.toBe(
            "https://cache.example/a.jpg"
        );
        expect(mockAxiosGet).not.toHaveBeenCalled();

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        name: "Artist B",
                        picture_xl: null,
                        picture_big: "https://api.example/b-big.jpg",
                    },
                ],
            },
        });
        await expect(deezerService.getArtistImage("Artist B")).resolves.toBe(
            "https://api.example/b-big.jpg"
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "deezer:artist:artist b",
            86400,
            "https://api.example/b-big.jpg"
        );

        mockAxiosGet.mockRejectedValueOnce(new Error("artist lookup failed"));
        await expect(deezerService.getArtistImage("Artist C")).resolves.toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Deezer artist image error for Artist C:",
            "artist lookup failed"
        );
    });

    it("handles strict artist image matching with empty input, exact match, and miss", async () => {
        await expect(deezerService.getArtistImageStrict("   ")).resolves.toBeNull();
        expect(mockAxiosGet).not.toHaveBeenCalled();

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    { name: "The Ghost Inside", picture_xl: "https://img/the-ghost.jpg" },
                    { name: "GHOST", picture_xl: "https://img/ghost.jpg" },
                ],
            },
        });
        await expect(deezerService.getArtistImageStrict("ghost")).resolves.toBe(
            "https://img/ghost.jpg"
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "deezer:artist-strict:ghost",
            86400,
            "https://img/ghost.jpg"
        );

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [{ name: "Ghostface", picture_xl: "https://img/ghostface.jpg" }],
            },
        });
        await expect(deezerService.getArtistImageStrict("ghost")).resolves.toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "deezer:artist-strict:ghost",
            86400,
            "null"
        );
    });

    it("returns album cover and preview URL with best match logic and error fallback", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        title: "Not Exact",
                        artist: { name: "Other" },
                        cover_xl: "https://img/not-exact.jpg",
                    },
                    {
                        title: "Album X",
                        artist: { name: "Artist X" },
                        cover_medium: "https://img/exact-medium.jpg",
                    },
                ],
            },
        });
        await expect(
            deezerService.getAlbumCover("Artist X", "Album X")
        ).resolves.toBe("https://img/exact-medium.jpg");

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [{ preview: "https://preview/p.mp3" }],
            },
        });
        await expect(
            deezerService.getTrackPreview("Artist X", "Track X")
        ).resolves.toBe("https://preview/p.mp3");

        mockAxiosGet.mockRejectedValueOnce(new Error("preview failed"));
        await expect(
            deezerService.getTrackPreview("Artist Y", "Track Y")
        ).resolves.toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Deezer track preview error for Artist Y - Track Y:",
            "preview failed"
        );
    });

    it("resolves track album from cache, API, and malformed cache paths", async () => {
        mockRedisGet.mockResolvedValueOnce('{"albumName":"Cached Album","albumId":"123"}');
        await expect(
            deezerService.getTrackAlbum("Artist", "Track")
        ).resolves.toEqual({ albumName: "Cached Album", albumId: "123" });
        expect(mockAxiosGet).not.toHaveBeenCalled();

        mockRedisGet.mockResolvedValueOnce("{bad-json");
        await expect(deezerService.getTrackAlbum("Artist", "Track")).resolves.toBeNull();

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        artist: { name: "Artist Exact" },
                        album: { title: "Album Exact", id: 777 },
                    },
                    {
                        artist: { name: "Someone Else" },
                        album: { title: "Album Else", id: 888 },
                    },
                ],
            },
        });
        await expect(
            deezerService.getTrackAlbum("Artist Exact", "Track (feat. Guest)")
        ).resolves.toEqual({ albumName: "Album Exact", albumId: "777" });
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://api.deezer.com/search/track",
            expect.objectContaining({
                params: {
                    q: "Artist Exact Track",
                    limit: 5,
                },
            })
        );

        mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } });
        await expect(
            deezerService.getTrackAlbum("No Artist", "No Track")
        ).resolves.toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "deezer:track-album:no artist:no track",
            86400,
            "null"
        );

        mockAxiosGet.mockRejectedValueOnce(new Error("track album failed"));
        await expect(
            deezerService.getTrackAlbum("Err Artist", "Err Track")
        ).resolves.toBeNull();
    });

    it("parses Deezer URLs for playlist/album/track and rejects non-matching URLs", () => {
        expect(deezerService.parseUrl("https://www.deezer.com/playlist/123")).toEqual({
            type: "playlist",
            id: "123",
        });
        expect(deezerService.parseUrl("https://www.deezer.com/us/album/456")).toEqual({
            type: "album",
            id: "456",
        });
        expect(deezerService.parseUrl("https://www.deezer.com/track/789")).toEqual({
            type: "track",
            id: "789",
        });
        expect(deezerService.parseUrl("https://example.com/not-deezer")).toBeNull();
    });

    it("fetches playlists, chart playlists, and search playlists with mapping and errors", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                id: 100,
                title: "Playlist 100",
                description: "desc",
                creator: { name: "Curator" },
                picture_medium: "https://img/p100.jpg",
                nb_tracks: 2,
                public: false,
                tracks: {
                    data: [
                        {
                            id: 1,
                            title: "Track 1",
                            artist: { name: "Artist 1", id: 11 },
                            album: { title: "Album 1", id: 21, cover_medium: "https://img/a1.jpg" },
                            duration: 180,
                            preview: "https://prev/1.mp3",
                        },
                    ],
                },
            },
        });
        await expect(deezerService.getPlaylist("100")).resolves.toEqual(
            expect.objectContaining({
                id: "100",
                title: "Playlist 100",
                creator: "Curator",
                trackCount: 2,
                isPublic: false,
                tracks: [
                    expect.objectContaining({
                        deezerId: "1",
                        artist: "Artist 1",
                        durationMs: 180000,
                    }),
                ],
            })
        );

        mockAxiosGet.mockResolvedValueOnce({ data: { error: { message: "not found" } } });
        await expect(deezerService.getPlaylist("404")).resolves.toBeNull();

        mockAxiosGet.mockRejectedValueOnce(new Error("playlist failed"));
        await expect(deezerService.getPlaylist("500")).resolves.toBeNull();

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 1,
                        title: "Chart One",
                        user: { name: "Deezer" },
                        picture_medium: "https://img/chart1.jpg",
                        nb_tracks: 10,
                        fans: 20,
                    },
                ],
            },
        });
        await expect(deezerService.getChartPlaylists(5)).resolves.toEqual([
            {
                id: "1",
                title: "Chart One",
                description: null,
                creator: "Deezer",
                imageUrl: "https://img/chart1.jpg",
                trackCount: 10,
                fans: 20,
            },
        ]);

        mockAxiosGet.mockRejectedValueOnce(new Error("chart failed"));
        await expect(deezerService.getChartPlaylists(5)).resolves.toEqual([]);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 5,
                        title: "Search Hit",
                        user: { name: "User" },
                        picture: "https://img/search.jpg",
                        nb_tracks: 8,
                    },
                ],
            },
        });
        await expect(deezerService.searchPlaylists("jazz", 3)).resolves.toEqual([
            {
                id: "5",
                title: "Search Hit",
                description: null,
                creator: "User",
                imageUrl: "https://img/search.jpg",
                trackCount: 8,
                fans: 0,
            },
        ]);

        mockAxiosGet.mockRejectedValueOnce(new Error("search failed"));
        await expect(deezerService.searchPlaylists("jazz", 3)).resolves.toEqual([]);
    });

    it("returns featured playlists from cache and from chart+genre aggregation", async () => {
        mockRedisGet.mockResolvedValueOnce(
            JSON.stringify([{ id: "cached", title: "Cached", fans: 0 }])
        );
        await expect(deezerService.getFeaturedPlaylists(10)).resolves.toEqual([
            { id: "cached", title: "Cached", fans: 0 },
        ] as any);

        mockRedisGet.mockResolvedValueOnce(null);
        const chartSpy = jest
            .spyOn(deezerService, "getChartPlaylists")
            .mockResolvedValueOnce([
                {
                    id: "1",
                    title: "Chart 1",
                    description: null,
                    creator: "Deezer",
                    imageUrl: null,
                    trackCount: 10,
                    fans: 20,
                },
            ]);
        const searchSpy = jest
            .spyOn(deezerService, "searchPlaylists")
            .mockImplementation(async (query: string) => [
                {
                    id: query === "pop" ? "1" : `${query}-2`,
                    title: `${query} list`,
                    description: null,
                    creator: "User",
                    imageUrl: null,
                    trackCount: 5,
                    fans: 0,
                },
            ]);

        const result = await deezerService.getFeaturedPlaylists(3);
        expect(result).toEqual([
            expect.objectContaining({ id: "1" }),
            expect.objectContaining({ id: "rock-2" }),
            expect.objectContaining({ id: "hip hop-2" }),
        ]);
        expect(chartSpy).toHaveBeenCalledWith(3);
        expect(searchSpy).toHaveBeenCalled();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "deezer:playlists:featured:3",
            86400,
            JSON.stringify(result)
        );

        chartSpy.mockRestore();
        searchSpy.mockRestore();
    });

    it("handles genres and radio metadata with caching and error fallback", async () => {
        mockRedisGet.mockResolvedValueOnce(JSON.stringify([{ id: 99, name: "Cached" }]));
        await expect(deezerService.getGenres()).resolves.toEqual([
            { id: 99, name: "Cached" },
        ] as any);

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    { id: 0, name: "All", picture: "x" },
                    { id: 2, name: "Rock", picture_medium: "https://img/rock.jpg" },
                ],
            },
        });
        await expect(deezerService.getGenres()).resolves.toEqual([
            { id: 2, name: "Rock", imageUrl: "https://img/rock.jpg" },
        ]);

        mockAxiosGet.mockRejectedValueOnce(new Error("genres failed"));
        await expect(deezerService.getGenres()).resolves.toEqual([]);

        const searchSpy = jest
            .spyOn(deezerService, "searchPlaylists")
            .mockResolvedValueOnce([
                {
                    id: "s1",
                    title: "Rock Picks",
                    description: null,
                    creator: "User",
                    imageUrl: null,
                    trackCount: 10,
                    fans: 0,
                },
            ]);
        await expect(deezerService.getGenrePlaylists("Rock", 5)).resolves.toEqual([
            expect.objectContaining({ id: "s1" }),
        ]);
        searchSpy.mockRestore();

        mockRedisGet.mockResolvedValueOnce(JSON.stringify([{ id: "r1", title: "Cached Radio" }]));
        await expect(deezerService.getRadioStations()).resolves.toEqual([
            { id: "r1", title: "Cached Radio" },
        ] as any);

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    { id: 4, title: "Radio Four", picture: "https://img/r4.jpg" },
                ],
            },
        });
        await expect(deezerService.getRadioStations()).resolves.toEqual([
            {
                id: "4",
                title: "Radio Four",
                description: null,
                imageUrl: "https://img/r4.jpg",
                type: "radio",
            },
        ]);

        mockAxiosGet.mockRejectedValueOnce(new Error("radio stations failed"));
        await expect(deezerService.getRadioStations()).resolves.toEqual([]);

        mockRedisGet.mockResolvedValueOnce(JSON.stringify([{ id: 3, name: "Cached Genre" }]));
        await expect(deezerService.getRadiosByGenre()).resolves.toEqual([
            { id: 3, name: "Cached Genre" },
        ] as any);

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 10,
                        title: "Mood",
                        radios: [
                            { id: 55, title: "Mood Mix", picture_medium: "https://img/mood.jpg" },
                        ],
                    },
                ],
            },
        });
        await expect(deezerService.getRadiosByGenre()).resolves.toEqual([
            {
                id: 10,
                name: "Mood",
                radios: [
                    {
                        id: "55",
                        title: "Mood Mix",
                        description: null,
                        imageUrl: "https://img/mood.jpg",
                        type: "radio",
                    },
                ],
            },
        ]);

        mockAxiosGet.mockRejectedValueOnce(new Error("radio-by-genre failed"));
        await expect(deezerService.getRadiosByGenre()).resolves.toEqual([]);
    });

    it("fetches radio tracks and editorial content with success and fallback", async () => {
        mockAxiosGet
            .mockResolvedValueOnce({ data: { title: "Radio Name", picture_medium: "https://img/radio.jpg" } })
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            id: 7,
                            title: "Track Seven",
                            artist: { id: 70, name: "Artist Seven" },
                            album: { id: 700, title: "Album Seven", cover: "https://img/a7.jpg" },
                            duration: 210,
                            preview: "https://prev/7.mp3",
                        },
                    ],
                },
            });
        await expect(deezerService.getRadioTracks("88")).resolves.toEqual(
            expect.objectContaining({
                id: "radio-88",
                title: "Radio Name",
                trackCount: 1,
                tracks: [expect.objectContaining({ deezerId: "7", durationMs: 210000 })],
            })
        );

        mockAxiosGet.mockRejectedValueOnce(new Error("radio tracks failed"));
        await expect(deezerService.getRadioTracks("99")).resolves.toBeNull();

        const searchSpy = jest
            .spyOn(deezerService, "searchPlaylists")
            .mockResolvedValueOnce([
                {
                    id: "p1",
                    title: "Rock Curated",
                    description: null,
                    creator: "Deezer",
                    imageUrl: null,
                    trackCount: 11,
                    fans: 0,
                },
            ]);
        mockAxiosGet
            .mockResolvedValueOnce({ data: { name: "Rock" } })
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            id: 5,
                            title: "Rock",
                            radios: [
                                { id: 501, title: "Rock Radio", picture: "https://img/rockradio.jpg" },
                            ],
                        },
                    ],
                },
            });

        await expect(deezerService.getEditorialContent(5)).resolves.toEqual({
            playlists: [expect.objectContaining({ id: "p1" })],
            radios: [
                {
                    id: "501",
                    title: "Rock Radio",
                    description: null,
                    imageUrl: "https://img/rockradio.jpg",
                    type: "radio",
                },
            ],
        });

        searchSpy.mockRestore();

        mockAxiosGet.mockRejectedValueOnce(new Error("editorial failed"));
        await expect(deezerService.getEditorialContent(5)).resolves.toEqual({
            playlists: [],
            radios: [],
        });
    });

    it("continues featured playlist assembly when one genre search fails", async () => {
        mockRedisGet.mockResolvedValueOnce(null);

        const chartSpy = jest
            .spyOn(deezerService, "getChartPlaylists")
            .mockResolvedValueOnce([]);
        const searchSpy = jest
            .spyOn(deezerService, "searchPlaylists")
            .mockImplementation(async (query: string) => {
                if (query === "pop") {
                    throw new Error("pop search down");
                }

                return [
                    {
                        id: query,
                        title: `${query} playlist`,
                        description: null,
                        creator: "Genre",
                        imageUrl: null,
                        trackCount: 4,
                        fans: 0,
                    },
                ];
            });

        const result = await deezerService.getFeaturedPlaylists(3);

        expect(result).toEqual([
            expect.objectContaining({ id: "rock" }),
            expect.objectContaining({ id: "hip hop" }),
            expect.objectContaining({ id: "electronic" }),
        ]);
        expect(result).toHaveLength(3);
        expect(searchSpy).toHaveBeenCalledWith("pop", 10);
        expect(searchSpy).toHaveBeenCalledWith("rock", 10);

        chartSpy.mockRestore();
        searchSpy.mockRestore();
    });

    it("returns no playlist fallback and radios-only editorial content for genres without names", async () => {
        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    id: 55,
                    name: "",
                    picture_medium: null,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            id: 55,
                            title: "Rock",
                            radios: [
                                {
                                    id: 101,
                                    title: "Rock Radio",
                                    picture: "https://img/radio.jpg",
                                },
                            ],
                        },
                    ],
                },
            });

        await expect(deezerService.getEditorialContent(55)).resolves.toEqual({
            playlists: [],
            radios: [
                {
                    id: "101",
                    title: "Rock Radio",
                    description: null,
                    imageUrl: "https://img/radio.jpg",
                    type: "radio",
                },
            ],
        });

        expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    });

    it("falls back through artist image sizes and propagates missing values", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        name: "Artist One",
                        picture_xl: null,
                        picture_big: null,
                        picture_medium: "https://img/artist-medium.jpg",
                    },
                ],
            },
        });

        await expect(deezerService.getArtistImage("Artist One")).resolves.toBe(
            "https://img/artist-medium.jpg"
        );
    });

    it("returns null album cover from cache without issuing Deezer requests", async () => {
        mockRedisGet.mockResolvedValueOnce("null");

        await expect(
            deezerService.getAlbumCover("Cached Artist", "Cached Album")
        ).resolves.toBeNull();
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("returns cached track preview null without making a Deezer request", async () => {
        mockRedisGet.mockResolvedValueOnce("null");

        await expect(
            deezerService.getTrackPreview("Cached Artist", "Cached Track")
        ).resolves.toBeNull();
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("maps playlist response fields with image/count fallbacks", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                id: 20,
                title: "Playlist Fallback",
                description: null,
                creator: null,
                picture: "https://img/playlist-picture.jpg",
                tracks: {
                    data: [
                        {
                            id: 1,
                            title: "Track A",
                            artist: { name: "Artist", id: 11 },
                            album: { title: "Album A", id: 22, cover: "https://img/album-cover.jpg" },
                            duration: 121,
                        },
                        {
                            id: 2,
                            title: "Track B",
                            artist: null,
                            album: null,
                            duration: 0,
                            preview: null,
                        },
                    ],
                },
            },
        });

        await expect(deezerService.getPlaylist("20")).resolves.toEqual({
            id: "20",
            title: "Playlist Fallback",
            description: null,
            creator: "Unknown",
            imageUrl: "https://img/playlist-picture.jpg",
            trackCount: 2,
            tracks: [
                {
                    deezerId: "1",
                    title: "Track A",
                    artist: "Artist",
                    artistId: "11",
                    album: "Album A",
                    albumId: "22",
                    durationMs: 121000,
                    previewUrl: null,
                    coverUrl: "https://img/album-cover.jpg",
                },
                {
                    deezerId: "2",
                    title: "Track B",
                    artist: "Unknown Artist",
                    artistId: "",
                    album: "Unknown Album",
                    albumId: "",
                    durationMs: 0,
                    previewUrl: null,
                    coverUrl: null,
                },
            ],
            isPublic: true,
        });
    });

    it("filters invalid Deezer genres and falls back to picture fallback", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    { id: 0, name: "All", picture: "https://img/all.jpg" },
                    { id: 3, name: "Jazz", picture: "https://img/jazz.jpg" },
                ],
            },
        });

        await expect(deezerService.getGenres()).resolves.toEqual([
            { id: 3, name: "Jazz", imageUrl: "https://img/jazz.jpg" },
        ]);
    });

    it("maps radios by genre and normalizes radio image fallbacks", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 4,
                        title: "Rock",
                        radios: [
                            {
                                id: 77,
                                title: "Rock Pulse",
                                picture: "https://img/rock-pulse.jpg",
                            },
                        ],
                    },
                ],
            },
        });

        await expect(deezerService.getRadiosByGenre()).resolves.toEqual([
            {
                id: 4,
                name: "Rock",
                radios: [
                    {
                        id: "77",
                        title: "Rock Pulse",
                        description: null,
                        imageUrl: "https://img/rock-pulse.jpg",
                        type: "radio",
                    },
                ],
            },
        ]);
    });

    it("maps radio track payload with cover image fallback and radio metadata", async () => {
        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    title: "Late Night Radio",
                    picture: "https://img/radio-cover.jpg",
                },
            })
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            id: 99,
                            title: "Evening Drive",
                            artist: { name: "DJ Night", id: 12 },
                            album: { title: "Night Mix", id: 34, cover: "https://img/album-cover.jpg" },
                            duration: 210,
                            preview: "https://audio/night-drive.mp3",
                        },
                    ],
                },
            });

        await expect(deezerService.getRadioTracks("88")).resolves.toEqual({
            id: "radio-88",
            title: "Late Night Radio",
            description: "Deezer Radio - Late Night Radio",
            creator: "Deezer",
            imageUrl: "https://img/radio-cover.jpg",
            trackCount: 1,
            tracks: [
                {
                    deezerId: "99",
                    title: "Evening Drive",
                    artist: "DJ Night",
                    artistId: "12",
                    album: "Night Mix",
                    albumId: "34",
                    durationMs: 210000,
                    previewUrl: "https://audio/night-drive.mp3",
                    coverUrl: "https://img/album-cover.jpg",
                },
            ],
            isPublic: true,
        });
    });
});
