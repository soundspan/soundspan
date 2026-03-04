import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = {
            id: "user-1",
            username: "tester",
            role: "user",
        };
        next();
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/spotify", () => ({
    spotifyService: {
        parseUrl: jest.fn(),
    },
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        parseUrl: jest.fn(),
    },
}));

jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService: {
        getCharts: jest.fn(),
        getMoodCategories: jest.fn(),
        getHome: jest.fn(),
        getMoodPlaylists: jest.fn(),
        getBrowsePlaylist: jest.fn(),
        getBrowseAlbum: jest.fn(),
    },
}));

jest.mock("../../services/tidalStreaming", () => ({
    tidalStreamingService: {
        isEnabled: jest.fn(),
        isAvailable: jest.fn(),
    },
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

import { ytMusicService } from "../../services/youtubeMusic";
import router from "../browse";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/browse", router);

describe("browse ytmusic routes integration", () => {
    const mockGetCharts = ytMusicService.getCharts as jest.Mock;
    const mockGetMoodCategories = ytMusicService.getMoodCategories as jest.Mock;
    const mockGetHome = ytMusicService.getHome as jest.Mock;
    const mockGetMoodPlaylists = ytMusicService.getMoodPlaylists as jest.Mock;
    const mockGetBrowsePlaylist = ytMusicService.getBrowsePlaylist as jest.Mock;
    const mockGetBrowseAlbum = ytMusicService.getBrowseAlbum as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
    });

    it("requires auth for GET /api/browse/ytmusic/charts", async () => {
        const res = await request(app).get("/api/browse/ytmusic/charts");

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("returns charts payload with source metadata", async () => {
        const charts = {
            songs: [{ videoId: "vid-1", title: "Song 1" }],
            videos: [],
            artists: [],
        };
        mockGetCharts.mockResolvedValueOnce(charts);

        const res = await request(app)
            .get("/api/browse/ytmusic/charts?country=CA")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            charts,
            country: "CA",
            source: "ytmusic",
        });
        expect(mockGetCharts).toHaveBeenCalledWith("CA");
    });

    it("returns categories and marks source as ytmusic", async () => {
        const categories = [
            { title: "Focus", params: "focus-param" },
            { title: "Energy", params: "energy-param" },
        ];
        mockGetMoodCategories.mockResolvedValueOnce(categories);

        const res = await request(app)
            .get("/api/browse/ytmusic/categories")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            categories,
            source: "ytmusic",
        });
    });

    it("returns home shelves and clamps limit values into allowed bounds", async () => {
        mockGetHome.mockResolvedValueOnce([{ title: "For You", contents: [] }]);

        const invalidLimitRes = await request(app)
            .get("/api/browse/ytmusic/home?limit=-4")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(invalidLimitRes.status).toBe(200);
        expect(mockGetHome).toHaveBeenCalledWith(1);

        mockGetHome.mockResolvedValueOnce([{ title: "For You", contents: [] }]);

        const cappedLimitRes = await request(app)
            .get("/api/browse/ytmusic/home?limit=999")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(cappedLimitRes.status).toBe(200);
        expect(mockGetHome).toHaveBeenCalledWith(20);
    });

    it("validates mood params and returns payload", async () => {
        mockGetMoodPlaylists.mockResolvedValueOnce([
            { playlistId: "pl-1", title: "Focus", thumbnailUrl: null, author: "YT Music" },
        ]);

        const okRes = await request(app)
            .get("/api/browse/ytmusic/mood-playlists?params=focus_vibes")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(okRes.status).toBe(200);
        expect(okRes.body).toEqual({
            playlists: [
                {
                    playlistId: "pl-1",
                    title: "Focus",
                    thumbnailUrl: null,
                    author: "YT Music",
                },
            ],
            source: "ytmusic",
        });
        expect(mockGetMoodPlaylists).toHaveBeenCalledWith("focus_vibes");

        const invalidRes = await request(app)
            .get("/api/browse/ytmusic/mood-playlists?params=%20%20%20")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(invalidRes.status).toBe(400);
        expect(mockGetMoodPlaylists).toHaveBeenCalledTimes(1);
    });

    it("maps sidecar 4xx mood-playlists responses to route 4xx", async () => {
        mockGetMoodPlaylists.mockRejectedValueOnce({
            response: { status: 422, data: { detail: "Invalid mood category params" } },
        });

        const res = await request(app)
            .get("/api/browse/ytmusic/mood-playlists?params=bad")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: "Invalid mood category params" });
    });

    it("caps playlist limit and returns playlist payload", async () => {
        mockGetBrowsePlaylist.mockResolvedValueOnce({
            id: "playlist-1",
            title: "Top Tracks",
            tracks: [{ videoId: "vid-1", title: "Song 1" }],
        });

        const res = await request(app)
            .get("/api/browse/ytmusic/playlist/playlist-1?limit=999")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "playlist-1",
                source: "ytmusic",
            })
        );
        expect(mockGetBrowsePlaylist).toHaveBeenCalledWith("playlist-1", 500);
    });

    it("maps sidecar 404 playlist responses to route 404", async () => {
        mockGetBrowsePlaylist.mockRejectedValueOnce({
            response: { status: 404 },
        });

        const res = await request(app)
            .get("/api/browse/ytmusic/playlist/missing-playlist")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Playlist not found" });
    });

    it("returns album normalized to playlist shape", async () => {
        mockGetBrowseAlbum.mockResolvedValueOnce({
            browseId: "MPREb_abc123",
            title: "Test Album",
            artist: "Test Artist",
            artists: ["Test Artist"],
            year: "2024",
            trackCount: 2,
            duration: "25 minutes",
            type: "Album",
            thumbnails: [{ url: "http://img/large", width: 500, height: 500 }],
            coverUrl: "http://img/large",
            tracks: [
                {
                    videoId: "vid1",
                    title: "Track One",
                    artist: "Test Artist",
                    artists: ["Test Artist"],
                    trackNumber: 1,
                    duration: "3:45",
                    duration_seconds: 225,
                    isExplicit: false,
                    likeStatus: null,
                },
            ],
            description: "A great album",
        });

        const res = await request(app)
            .get("/api/browse/ytmusic/album/MPREb_abc123")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "MPREb_abc123",
                title: "Test Album",
                description: "Test Artist \u00B7 2024",
                source: "ytmusic",
                type: "album",
                trackCount: 2,
                thumbnailUrl: "http://img/large",
            })
        );
        expect(res.body.tracks).toHaveLength(1);
        expect(res.body.tracks[0]).toEqual(
            expect.objectContaining({
                videoId: "vid1",
                title: "Track One",
                artist: "Test Artist",
                album: "Test Album",
                duration: 225,
            })
        );
        expect(mockGetBrowseAlbum).toHaveBeenCalledWith("MPREb_abc123");
    });

    it("maps sidecar 404 album responses to route 404", async () => {
        mockGetBrowseAlbum.mockRejectedValueOnce({
            response: { status: 404 },
        });

        const res = await request(app)
            .get("/api/browse/ytmusic/album/MPREb_missing")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Album not found" });
    });

    it("returns multiple home shelves with expected shape", async () => {
        const shelves = [
            {
                title: "Listen again",
                contents: [
                    { title: "Chill Vibes", playlistId: "PL1", thumbnailUrl: "http://img/1", subtitle: "Lo-Fi Radio" },
                ],
            },
            {
                title: "Trending",
                contents: [
                    { title: "Hot Album", browseId: "BR1", thumbnailUrl: null, subtitle: "New release" },
                ],
            },
        ];
        mockGetHome.mockResolvedValueOnce(shelves);

        const res = await request(app)
            .get("/api/browse/ytmusic/home?limit=6")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            shelves,
            source: "ytmusic",
        });
        expect(mockGetHome).toHaveBeenCalledWith(6);
    });
});
