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

jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: jest.fn(async (_bucket: string, fn: () => Promise<unknown>) => fn()),
    },
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;

describe("deezer branch coverage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
    });

    it("parseUrl handles valid url shapes and rejects malformed/unsupported ids", () => {
        expect(deezerService.parseUrl("https://www.deezer.com/us/track/123456")).toEqual({
            type: "track",
            id: "123456",
        });
        expect(deezerService.parseUrl("https://www.deezer.com/album/987654?utm=1")).toEqual({
            type: "album",
            id: "987654",
        });
        expect(deezerService.parseUrl("https://www.deezer.com/playlist/321654/")).toEqual({
            type: "playlist",
            id: "321654",
        });

        expect(deezerService.parseUrl("https://www.deezer.com/artist/27")).toBeNull();
        expect(deezerService.parseUrl("https://www.deezer.com/track/not-a-number")).toBeNull();
        expect(deezerService.parseUrl("https://www.deezer.com/album/")).toBeNull();
    });

    it("maps playlist with missing nested fields and empty tracks", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                id: 444,
                title: null,
                creator: null,
                picture: null,
                tracks: {
                    data: [
                        {
                            id: 1,
                            title: null,
                            artist: null,
                            album: null,
                            duration: null,
                            preview: null,
                        },
                    ],
                },
            },
        });

        await expect(deezerService.getPlaylist("444")).resolves.toEqual({
            id: "444",
            title: "Unknown Playlist",
            description: null,
            creator: "Unknown",
            imageUrl: null,
            trackCount: 1,
            tracks: [
                {
                    deezerId: "1",
                    title: "Unknown",
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

        mockAxiosGet.mockResolvedValueOnce({ data: { id: 445, tracks: { data: [] } } });
        await expect(deezerService.getPlaylist("445")).resolves.toEqual(
            expect.objectContaining({
                id: "445",
                trackCount: 0,
                tracks: [],
            })
        );
    });

    it("returns null on playlist api error payload or transport failure", async () => {
        mockAxiosGet.mockResolvedValueOnce({ data: { error: { type: "DataException" } } });
        await expect(deezerService.getPlaylist("bad")).resolves.toBeNull();

        mockAxiosGet.mockRejectedValueOnce(new Error("playlist timeout"));
        await expect(deezerService.getPlaylist("boom")).resolves.toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Deezer playlist fetch error:",
            "playlist timeout"
        );
    });

    it("album cover search handles query failures, null payloads, and image fallback fields", async () => {
        mockAxiosGet
            .mockRejectedValueOnce(new Error("429"))
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            title: "Alpha",
                            artist: { name: "Artist" },
                            cover_big: "https://img/alpha-big.jpg",
                        },
                    ],
                },
            });

        await expect(deezerService.getAlbumCover("Artist", "Alpha")).resolves.toBe(
            "https://img/alpha-big.jpg"
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "deezer:album:artist:alpha",
            86400,
            "https://img/alpha-big.jpg"
        );
    });

    it("track album handles cached null, malformed cache, and null album branch", async () => {
        mockRedisGet.mockResolvedValueOnce("null");
        await expect(deezerService.getTrackAlbum("A", "B")).resolves.toBeNull();

        mockRedisGet.mockResolvedValueOnce("{not-json");
        await expect(deezerService.getTrackAlbum("A", "B")).resolves.toBeNull();

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        artist: { name: "Someone" },
                        album: null,
                    },
                ],
            },
        });
        await expect(deezerService.getTrackAlbum("Artist", "Song")).resolves.toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "deezer:track-album:artist:song",
            86400,
            "null"
        );
    });

    it("uses cache and fallback image/preview fields for artist and track lookups", async () => {
        mockRedisGet.mockResolvedValueOnce("https://cached/artist.jpg");
        await expect(deezerService.getArtistImage("Cached Artist")).resolves.toBe(
            "https://cached/artist.jpg"
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        name: "Fallback Artist",
                        picture_xl: null,
                        picture_big: null,
                        picture_medium: "https://img/artist-medium.jpg",
                    },
                ],
            },
        });
        await expect(deezerService.getArtistImage("Fallback Artist")).resolves.toBe(
            "https://img/artist-medium.jpg"
        );

        mockRedisGet.mockResolvedValueOnce("null");
        await expect(deezerService.getTrackPreview("A", "B")).resolves.toBeNull();

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({ data: { data: [{ preview: "https://p/1.mp3" }] } });
        await expect(deezerService.getTrackPreview("Artist", "Track")).resolves.toBe(
            "https://p/1.mp3"
        );
    });

    it("handles strict artist cache and exact normalized match selection", async () => {
        mockRedisGet.mockResolvedValueOnce("null");
        await expect(deezerService.getArtistImageStrict("Ghost")).resolves.toBeNull();

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    { name: "Ghostface", picture_medium: "https://img/ghostface.jpg" },
                    { name: "GHOST", picture_big: "https://img/ghost-big.jpg" },
                ],
            },
        });
        await expect(deezerService.getArtistImageStrict("ghost")).resolves.toBe(
            "https://img/ghost-big.jpg"
        );
    });

    it("covers featured/genres/radios/editorial aggregation branches", async () => {
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
                    fans: 1,
                },
            ]);
        const searchSpy = jest
            .spyOn(deezerService, "searchPlaylists")
            .mockImplementation(async (q: string) => [
                {
                    id: q === "pop" ? "1" : `${q}-id`,
                    title: q,
                    description: null,
                    creator: "User",
                    imageUrl: null,
                    trackCount: 1,
                    fans: 0,
                },
            ]);

        const featured = await deezerService.getFeaturedPlaylists(3);
        expect(featured).toHaveLength(3);
        expect(featured.map((p) => p.id)).toEqual(["1", "rock-id", "hip hop-id"]);
        chartSpy.mockRestore();
        searchSpy.mockRestore();

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: { data: [{ id: 0, name: "All" }, { id: 2, name: "Rock", picture: "https://g.jpg" }] },
        });
        await expect(deezerService.getGenres()).resolves.toEqual([
            { id: 2, name: "Rock", imageUrl: "https://g.jpg" },
        ]);

        const playlistSpy = jest
            .spyOn(deezerService, "searchPlaylists")
            .mockResolvedValueOnce([
                {
                    id: "gp-1",
                    title: "Rock Mix",
                    description: null,
                    creator: "User",
                    imageUrl: null,
                    trackCount: 5,
                    fans: 0,
                },
            ]);
        await expect(deezerService.getGenrePlaylists("Rock", 5)).resolves.toEqual([
            expect.objectContaining({ id: "gp-1" }),
        ]);
        playlistSpy.mockRestore();

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: { data: [{ id: 10, title: "Radio Ten", picture_medium: "https://r.jpg" }] },
        });
        await expect(deezerService.getRadioStations()).resolves.toEqual([
            {
                id: "10",
                title: "Radio Ten",
                description: null,
                imageUrl: "https://r.jpg",
                type: "radio",
            },
        ]);

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 5,
                        title: "Mood",
                        radios: [{ id: 90, title: "Mood 90", picture: "https://m.jpg" }],
                    },
                ],
            },
        });
        await expect(deezerService.getRadiosByGenre()).resolves.toEqual([
            {
                id: 5,
                name: "Mood",
                radios: [
                    {
                        id: "90",
                        title: "Mood 90",
                        description: null,
                        imageUrl: "https://m.jpg",
                        type: "radio",
                    },
                ],
            },
        ]);

        mockAxiosGet
            .mockResolvedValueOnce({ data: { title: "Drive", picture: "https://drive.jpg" } })
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            id: 12,
                            title: "Night Song",
                            artist: { id: 3, name: "DJ" },
                            album: { id: 4, title: "Night", cover_medium: "https://cover.jpg" },
                            duration: 200,
                            preview: "https://night.mp3",
                        },
                    ],
                },
            });
        await expect(deezerService.getRadioTracks("42")).resolves.toEqual(
            expect.objectContaining({
                id: "radio-42",
                title: "Drive",
                trackCount: 1,
            })
        );

        const searchEditorialSpy = jest
            .spyOn(deezerService, "searchPlaylists")
            .mockResolvedValueOnce([
                {
                    id: "e1",
                    title: "Rock Curated",
                    description: null,
                    creator: "Deezer",
                    imageUrl: null,
                    trackCount: 2,
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
                            radios: [{ id: 8, title: "Rock Radio", picture_medium: "https://rr.jpg" }],
                        },
                    ],
                },
            });

        await expect(deezerService.getEditorialContent(5)).resolves.toEqual({
            playlists: [expect.objectContaining({ id: "e1" })],
            radios: [
                {
                    id: "8",
                    title: "Rock Radio",
                    description: null,
                    imageUrl: "https://rr.jpg",
                    type: "radio",
                },
            ],
        });
        searchEditorialSpy.mockRestore();
    });

    it("returns [] for chart/search failures and maps empty-data results", async () => {
        mockAxiosGet.mockResolvedValueOnce({ data: {} });
        await expect(deezerService.getChartPlaylists(2)).resolves.toEqual([]);

        mockAxiosGet.mockRejectedValueOnce(new Error("search exploded"));
        await expect(deezerService.searchPlaylists("r&b / dance", 2)).resolves.toEqual([]);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Deezer playlist search error:",
            "search exploded"
        );
    });

    it("covers fallback branches across preview/album/playlist/chart/search transforms", async () => {
        mockRedisGet.mockResolvedValueOnce("https://cached/cover.jpg");
        await expect(deezerService.getAlbumCover("Cached", "Album")).resolves.toBe(
            "https://cached/cover.jpg"
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({ data: { data: [{ preview: null }] } });
        await expect(deezerService.getTrackPreview("No", "Preview")).resolves.toBeNull();

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        artist: { name: "Exact" },
                        album: { title: "Album Without Id" },
                    },
                ],
            },
        });
        await expect(deezerService.getTrackAlbum("Exact", "Song")).resolves.toEqual({
            albumName: "Album Without Id",
            albumId: "",
        });

        mockAxiosGet.mockResolvedValueOnce({ data: { id: 9 } });
        await expect(deezerService.getPlaylist("9")).resolves.toEqual(
            expect.objectContaining({ tracks: [], trackCount: 0 })
        );

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 11,
                        title: null,
                        user: null,
                        picture_medium: null,
                        picture: null,
                        nb_tracks: null,
                        fans: null,
                    },
                ],
            },
        });
        await expect(deezerService.getChartPlaylists()).resolves.toEqual([
            {
                id: "11",
                title: "Unknown",
                description: null,
                creator: "Deezer",
                imageUrl: null,
                trackCount: 0,
                fans: 0,
            },
        ]);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 12,
                        title: null,
                        user: null,
                        picture_medium: null,
                        picture: "https://p.jpg",
                        nb_tracks: null,
                    },
                ],
            },
        });
        await expect(deezerService.searchPlaylists("unicode ✓", 1)).resolves.toEqual([
            {
                id: "12",
                title: "Unknown",
                description: null,
                creator: "Unknown",
                imageUrl: "https://p.jpg",
                trackCount: 0,
                fans: 0,
            },
        ]);
    });

    it("covers fallback branches for genres/radios/editorial empty-name paths", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [
                    { id: 0, name: "All", picture_medium: "https://all.jpg" },
                    { id: 6, name: "Jazz", picture_medium: null, picture: "https://j.jpg" },
                ],
            },
        });
        await expect(deezerService.getGenres()).resolves.toEqual([
            { id: 6, name: "Jazz", imageUrl: "https://j.jpg" },
        ]);

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: { data: [{ id: 7, title: null, picture_medium: null, picture: "https://r7.jpg" }] },
        });
        await expect(deezerService.getRadioStations()).resolves.toEqual([
            {
                id: "7",
                title: "Unknown",
                description: null,
                imageUrl: "https://r7.jpg",
                type: "radio",
            },
        ]);

        mockRedisGet.mockResolvedValueOnce(null);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                data: [{ id: 22, title: null, radios: [{ id: 1, title: null, picture_medium: null, picture: "https://rr1.jpg" }] }],
            },
        });
        await expect(deezerService.getRadiosByGenre()).resolves.toEqual([
            {
                id: 22,
                name: "Unknown",
                radios: [
                    {
                        id: "1",
                        title: "Unknown",
                        description: null,
                        imageUrl: "https://rr1.jpg",
                        type: "radio",
                    },
                ],
            },
        ]);

        mockAxiosGet
            .mockResolvedValueOnce({ data: { title: null, picture_medium: null, picture: "https://radio.jpg" } })
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            id: 3,
                            title: null,
                            artist: null,
                            album: { title: null, id: null, cover_medium: null, cover: null },
                            duration: null,
                            preview: null,
                        },
                    ],
                },
            });
        await expect(deezerService.getRadioTracks("5")).resolves.toEqual(
            expect.objectContaining({
                title: "Radio Station",
                imageUrl: "https://radio.jpg",
                tracks: [expect.objectContaining({ title: "Unknown", artist: "Unknown Artist", coverUrl: null })],
            })
        );

        const searchSpy = jest.spyOn(deezerService, "searchPlaylists");
        mockAxiosGet
            .mockResolvedValueOnce({ data: { name: "" } })
            .mockResolvedValueOnce({
                data: {
                    data: [
                        {
                            id: 99,
                            title: "Genre",
                            radios: [{ id: 44, title: "Genre Radio", picture_medium: null, picture: "https://gr.jpg" }],
                        },
                    ],
                },
            });
        await expect(deezerService.getEditorialContent(99)).resolves.toEqual({
            playlists: [],
            radios: [
                {
                    id: "44",
                    title: "Genre Radio",
                    description: null,
                    imageUrl: "https://gr.jpg",
                    type: "radio",
                },
            ],
        });
        expect(searchSpy).not.toHaveBeenCalled();
        searchSpy.mockRestore();
    });
});
