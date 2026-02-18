import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const deezerService = {
    getFeaturedPlaylists: jest.fn(),
    searchPlaylists: jest.fn(),
    getPlaylist: jest.fn(),
    getRadioStations: jest.fn(),
    getRadiosByGenre: jest.fn(),
    getRadioTracks: jest.fn(),
    getGenres: jest.fn(),
    getEditorialContent: jest.fn(),
    getGenrePlaylists: jest.fn(),
    parseUrl: jest.fn(),
};

jest.mock("../../services/deezer", () => ({
    deezerService,
}));

const spotifyService = {
    parseUrl: jest.fn(),
};

jest.mock("../../services/spotify", () => ({
    spotifyService,
}));

import router from "../browse";

function getHandler(path: string, method: "get" | "post") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }

    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };

    return res;
}

describe("browse route runtime", () => {
    const getFeaturedPlaylists = getHandler("/playlists/featured", "get");
    const searchPlaylists = getHandler("/playlists/search", "get");
    const getPlaylist = getHandler("/playlists/:id", "get");
    const getRadios = getHandler("/radios", "get");
    const getRadiosByGenre = getHandler("/radios/by-genre", "get");
    const getRadioById = getHandler("/radios/:id", "get");
    const getGenres = getHandler("/genres", "get");
    const getGenreContent = getHandler("/genres/:id", "get");
    const getGenrePlaylists = getHandler("/genres/:id/playlists", "get");
    const parsePlaylistUrl = getHandler("/playlists/parse", "post");
    const getAllBrowseContent = getHandler("/all", "get");

    const deezerPlaylistPreview = {
        id: "dz-1",
        title: "Top Hits",
        description: "Curated hits",
        creator: "Deezer Editors",
        imageUrl: "https://cdn.example/playlist.jpg",
        trackCount: 42,
        fans: 1000,
    };

    const deezerRadioStation = {
        id: "radio-1",
        title: "Focus Radio",
        description: "Stay productive",
        imageUrl: "https://cdn.example/radio.jpg",
        type: "radio" as const,
    };

    const deezerPlaylistDetail = {
        id: "dz-1",
        title: "Top Hits",
        description: "Curated hits",
        creator: "Deezer Editors",
        imageUrl: "https://cdn.example/playlist.jpg",
        trackCount: 2,
        tracks: [
            {
                deezerId: "track-1",
                title: "Song A",
                artist: "Artist A",
                artistId: "artist-1",
                album: "Album A",
                albumId: "album-1",
                durationMs: 180000,
                previewUrl: "https://cdn.example/preview.mp3",
                coverUrl: "https://cdn.example/cover.jpg",
            },
        ],
        isPublic: true,
    };

    const deezerGenres = [
        { id: 10, name: "Rock", imageUrl: "https://cdn.example/rock.jpg" },
        { id: 20, name: "Pop", imageUrl: null },
    ];

    beforeEach(() => {
        jest.clearAllMocks();

        deezerService.getFeaturedPlaylists.mockResolvedValue([
            deezerPlaylistPreview,
        ]);
        deezerService.searchPlaylists.mockResolvedValue([deezerPlaylistPreview]);
        deezerService.getPlaylist.mockResolvedValue(deezerPlaylistDetail);
        deezerService.getRadioStations.mockResolvedValue([deezerRadioStation]);
        deezerService.getRadiosByGenre.mockResolvedValue([
            {
                id: 10,
                name: "Rock",
                radios: [deezerRadioStation],
            },
        ]);
        deezerService.getRadioTracks.mockResolvedValue(deezerPlaylistDetail);
        deezerService.getGenres.mockResolvedValue(deezerGenres);
        deezerService.getEditorialContent.mockResolvedValue({
            playlists: [deezerPlaylistPreview],
            radios: [deezerRadioStation],
        });
        deezerService.getGenrePlaylists.mockResolvedValue([deezerPlaylistPreview]);
        deezerService.parseUrl.mockReturnValue(null);

        spotifyService.parseUrl.mockReturnValue(null);
    });

    it("handles GET /playlists/featured success and error branches", async () => {
        const successReq = { query: { limit: "500" } } as any;
        const successRes = createRes();

        await getFeaturedPlaylists(successReq, successRes);

        expect(deezerService.getFeaturedPlaylists).toHaveBeenCalledWith(200);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            playlists: [
                {
                    id: "dz-1",
                    source: "deezer",
                    type: "playlist",
                    title: "Top Hits",
                    description: "Curated hits",
                    creator: "Deezer Editors",
                    imageUrl: "https://cdn.example/playlist.jpg",
                    trackCount: 42,
                    url: "https://www.deezer.com/playlist/dz-1",
                },
            ],
            total: 1,
            source: "deezer",
        });

        deezerService.getFeaturedPlaylists.mockRejectedValueOnce(
            new Error("deezer unavailable")
        );

        const errorReq = { query: {} } as any;
        const errorRes = createRes();
        await getFeaturedPlaylists(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "deezer unavailable" });
    });

    it("handles GET /playlists/search validation, success, and error branches", async () => {
        const shortReq = { query: { q: "a" } } as any;
        const shortRes = createRes();

        await searchPlaylists(shortReq, shortRes);

        expect(shortRes.statusCode).toBe(400);
        expect(shortRes.body).toEqual({
            error: "Search query must be at least 2 characters",
        });
        expect(deezerService.searchPlaylists).not.toHaveBeenCalled();

        const successReq = { query: { q: "lofi", limit: "500" } } as any;
        const successRes = createRes();

        await searchPlaylists(successReq, successRes);

        expect(deezerService.searchPlaylists).toHaveBeenCalledWith("lofi", 100);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            playlists: [
                {
                    id: "dz-1",
                    source: "deezer",
                    type: "playlist",
                    title: "Top Hits",
                    description: "Curated hits",
                    creator: "Deezer Editors",
                    imageUrl: "https://cdn.example/playlist.jpg",
                    trackCount: 42,
                    url: "https://www.deezer.com/playlist/dz-1",
                },
            ],
            total: 1,
            query: "lofi",
            source: "deezer",
        });

        deezerService.searchPlaylists.mockRejectedValueOnce(
            new Error("search failed")
        );
        const errorReq = { query: { q: "rock" } } as any;
        const errorRes = createRes();

        await searchPlaylists(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "search failed" });
    });

    it("handles GET /playlists/:id 404, success, and error branches", async () => {
        deezerService.getPlaylist.mockResolvedValueOnce(null);

        const missingReq = { params: { id: "missing" } } as any;
        const missingRes = createRes();
        await getPlaylist(missingReq, missingRes);

        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Playlist not found" });

        const successReq = { params: { id: "dz-1" } } as any;
        const successRes = createRes();
        await getPlaylist(successReq, successRes);

        expect(deezerService.getPlaylist).toHaveBeenCalledWith("dz-1");
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            ...deezerPlaylistDetail,
            source: "deezer",
            url: "https://www.deezer.com/playlist/dz-1",
        });

        deezerService.getPlaylist.mockRejectedValueOnce(new Error("fetch exploded"));

        const errorReq = { params: { id: "dz-2" } } as any;
        const errorRes = createRes();
        await getPlaylist(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "fetch exploded" });
    });

    it("handles GET /radios success and error branches", async () => {
        const successReq = {} as any;
        const successRes = createRes();

        await getRadios(successReq, successRes);

        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            radios: [
                {
                    id: "radio-1",
                    source: "deezer",
                    type: "radio",
                    title: "Focus Radio",
                    description: "Stay productive",
                    creator: "Deezer",
                    imageUrl: "https://cdn.example/radio.jpg",
                    trackCount: 0,
                    url: "https://www.deezer.com/radio-radio-1",
                },
            ],
            total: 1,
            source: "deezer",
        });

        deezerService.getRadioStations.mockRejectedValueOnce(
            new Error("radio listing failed")
        );

        const errorReq = {} as any;
        const errorRes = createRes();
        await getRadios(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "radio listing failed" });
    });

    it("handles GET /radios/by-genre success and error branches", async () => {
        const successReq = {} as any;
        const successRes = createRes();

        await getRadiosByGenre(successReq, successRes);

        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            genres: [
                {
                    id: 10,
                    name: "Rock",
                    radios: [
                        {
                            id: "radio-1",
                            source: "deezer",
                            type: "radio",
                            title: "Focus Radio",
                            description: "Stay productive",
                            creator: "Deezer",
                            imageUrl: "https://cdn.example/radio.jpg",
                            trackCount: 0,
                            url: "https://www.deezer.com/radio-radio-1",
                        },
                    ],
                },
            ],
            total: 1,
            source: "deezer",
        });

        deezerService.getRadiosByGenre.mockRejectedValueOnce(
            new Error("genre radios failed")
        );

        const errorReq = {} as any;
        const errorRes = createRes();
        await getRadiosByGenre(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "genre radios failed" });
    });

    it("handles GET /radios/:id 404, success, and error branches", async () => {
        deezerService.getRadioTracks.mockResolvedValueOnce(null);

        const missingReq = { params: { id: "radio-missing" } } as any;
        const missingRes = createRes();
        await getRadioById(missingReq, missingRes);

        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Radio station not found" });

        const successReq = { params: { id: "radio-1" } } as any;
        const successRes = createRes();
        await getRadioById(successReq, successRes);

        expect(deezerService.getRadioTracks).toHaveBeenCalledWith("radio-1");
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            ...deezerPlaylistDetail,
            source: "deezer",
            type: "radio",
        });

        deezerService.getRadioTracks.mockRejectedValueOnce(new Error("radio failed"));

        const errorReq = { params: { id: "radio-2" } } as any;
        const errorRes = createRes();
        await getRadioById(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "radio failed" });
    });

    it("handles GET /genres success and error branches", async () => {
        const successReq = {} as any;
        const successRes = createRes();

        await getGenres(successReq, successRes);

        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            genres: deezerGenres,
            total: 2,
            source: "deezer",
        });

        deezerService.getGenres.mockRejectedValueOnce(new Error("genres failed"));

        const errorReq = {} as any;
        const errorRes = createRes();
        await getGenres(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "genres failed" });
    });

    it("handles GET /genres/:id invalid id, success, and error branches", async () => {
        const invalidReq = { params: { id: "not-a-number" } } as any;
        const invalidRes = createRes();

        await getGenreContent(invalidReq, invalidRes);

        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid genre ID" });
        expect(deezerService.getEditorialContent).not.toHaveBeenCalled();

        const successReq = { params: { id: "10" } } as any;
        const successRes = createRes();

        await getGenreContent(successReq, successRes);

        expect(deezerService.getEditorialContent).toHaveBeenCalledWith(10);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            genreId: 10,
            playlists: [
                {
                    id: "dz-1",
                    source: "deezer",
                    type: "playlist",
                    title: "Top Hits",
                    description: "Curated hits",
                    creator: "Deezer Editors",
                    imageUrl: "https://cdn.example/playlist.jpg",
                    trackCount: 42,
                    url: "https://www.deezer.com/playlist/dz-1",
                },
            ],
            radios: [
                {
                    id: "radio-1",
                    source: "deezer",
                    type: "radio",
                    title: "Focus Radio",
                    description: "Stay productive",
                    creator: "Deezer",
                    imageUrl: "https://cdn.example/radio.jpg",
                    trackCount: 0,
                    url: "https://www.deezer.com/radio-radio-1",
                },
            ],
            source: "deezer",
        });

        deezerService.getEditorialContent.mockRejectedValueOnce(
            new Error("editorial failed")
        );

        const errorReq = { params: { id: "12" } } as any;
        const errorRes = createRes();
        await getGenreContent(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "editorial failed" });
    });

    it("handles GET /genres/:id/playlists missing genre, success, and error branches", async () => {
        deezerService.getGenres.mockResolvedValueOnce([
            { id: 99, name: "Jazz", imageUrl: null },
        ]);

        const missingReq = { params: { id: "10" }, query: {} } as any;
        const missingRes = createRes();

        await getGenrePlaylists(missingReq, missingRes);

        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Genre not found" });
        expect(deezerService.getGenrePlaylists).not.toHaveBeenCalled();

        const successReq = { params: { id: "10" }, query: { limit: "99" } } as any;
        const successRes = createRes();

        await getGenrePlaylists(successReq, successRes);

        expect(deezerService.getGenrePlaylists).toHaveBeenCalledWith("Rock", 50);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            playlists: [
                {
                    id: "dz-1",
                    source: "deezer",
                    type: "playlist",
                    title: "Top Hits",
                    description: "Curated hits",
                    creator: "Deezer Editors",
                    imageUrl: "https://cdn.example/playlist.jpg",
                    trackCount: 42,
                    url: "https://www.deezer.com/playlist/dz-1",
                },
            ],
            total: 1,
            genre: "Rock",
            source: "deezer",
        });

        deezerService.getGenrePlaylists.mockRejectedValueOnce(
            new Error("genre playlists failed")
        );

        const errorReq = { params: { id: "10" }, query: {} } as any;
        const errorRes = createRes();
        await getGenrePlaylists(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "genre playlists failed" });
    });

    it("handles POST /playlists/parse branches", async () => {
        const missingUrlReq = { body: {} } as any;
        const missingUrlRes = createRes();

        await parsePlaylistUrl(missingUrlReq, missingUrlRes);

        expect(missingUrlRes.statusCode).toBe(400);
        expect(missingUrlRes.body).toEqual({ error: "URL is required" });

        deezerService.parseUrl.mockReturnValueOnce({
            type: "playlist",
            id: "dz-777",
        });

        const deezerReq = {
            body: { url: "https://www.deezer.com/playlist/777" },
        } as any;
        const deezerRes = createRes();
        await parsePlaylistUrl(deezerReq, deezerRes);

        expect(deezerRes.statusCode).toBe(200);
        expect(deezerRes.body).toEqual({
            source: "deezer",
            type: "playlist",
            id: "dz-777",
            url: "https://www.deezer.com/playlist/dz-777",
        });
        expect(spotifyService.parseUrl).not.toHaveBeenCalled();

        deezerService.parseUrl.mockReturnValueOnce(null);
        spotifyService.parseUrl.mockReturnValueOnce({
            type: "playlist",
            id: "sp-888",
        });

        const spotifyReq = {
            body: { url: "https://open.spotify.com/playlist/888" },
        } as any;
        const spotifyRes = createRes();
        await parsePlaylistUrl(spotifyReq, spotifyRes);

        expect(spotifyRes.statusCode).toBe(200);
        expect(spotifyRes.body).toEqual({
            source: "spotify",
            type: "playlist",
            id: "sp-888",
            url: "https://open.spotify.com/playlist/sp-888",
        });

        deezerService.parseUrl.mockReturnValueOnce(null);
        spotifyService.parseUrl.mockReturnValueOnce(null);

        const unsupportedReq = { body: { url: "https://example.com/list/1" } } as any;
        const unsupportedRes = createRes();
        await parsePlaylistUrl(unsupportedReq, unsupportedRes);

        expect(unsupportedRes.statusCode).toBe(400);
        expect(unsupportedRes.body).toEqual({
            error: "Invalid or unsupported URL. Please provide a Spotify or Deezer playlist URL.",
        });
    });

    it("handles POST /playlists/parse unexpected errors", async () => {
        deezerService.parseUrl.mockImplementationOnce(() => {
            throw new Error("parse crash");
        });

        const req = { body: { url: "https://www.deezer.com/playlist/1" } } as any;
        const res = createRes();

        await parsePlaylistUrl(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "parse crash" });
    });

    it("handles GET /all success and error branches", async () => {
        const successReq = {} as any;
        const successRes = createRes();

        await getAllBrowseContent(successReq, successRes);

        expect(deezerService.getFeaturedPlaylists).toHaveBeenCalledWith(200);
        expect(deezerService.getGenres).toHaveBeenCalled();
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            playlists: [
                {
                    id: "dz-1",
                    source: "deezer",
                    type: "playlist",
                    title: "Top Hits",
                    description: "Curated hits",
                    creator: "Deezer Editors",
                    imageUrl: "https://cdn.example/playlist.jpg",
                    trackCount: 42,
                    url: "https://www.deezer.com/playlist/dz-1",
                },
            ],
            radios: [],
            genres: deezerGenres,
            source: "deezer",
        });

        deezerService.getGenres.mockRejectedValueOnce(new Error("browse all failed"));

        const errorReq = {} as any;
        const errorRes = createRes();

        await getAllBrowseContent(errorReq, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "browse all failed" });
    });
});
