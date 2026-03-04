import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: "user-1", username: "tester", role: "user" };
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

jest.mock("../../config", () => ({
    config: { music: { musicPath: "/srv/music" } },
}));

jest.mock("../../services/browseImageCache", () => ({
    cacheExternalImage: jest.fn(),
    getOrCacheImage: jest.fn(),
}));

jest.mock("../../services/imageProxy", () => ({
    fetchExternalImage: jest.fn(),
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

import router from "../browse";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/browse", router);
const { spotifyService } = jest.requireMock("../../services/spotify") as {
    spotifyService: { parseUrl: jest.Mock };
};
const mockSpotifyParseUrl = spotifyService.parseUrl as jest.Mock;

describe("browse URL parse — YouTube Music & TIDAL expansion", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSpotifyParseUrl.mockReset();
        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
    });

    // ── YouTube Music URLs ─────────────────────────────────────────

    it("parses a YouTube Music playlist URL", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://music.youtube.com/playlist?list=PLxA687tYuMWjPSBVFwsGXfUVzSq3hzP3S",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            source: "youtube",
            type: "playlist",
            id: "PLxA687tYuMWjPSBVFwsGXfUVzSq3hzP3S",
            url: "https://music.youtube.com/playlist?list=PLxA687tYuMWjPSBVFwsGXfUVzSq3hzP3S",
        });
    });

    it("parses a regular YouTube playlist URL", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://youtube.com/playlist?list=PLAbc123_-def456",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            source: "youtube",
            type: "playlist",
            id: "PLAbc123_-def456",
            url: "https://music.youtube.com/playlist?list=PLAbc123_-def456",
        });
    });

    it("parses a mobile YouTube playlist URL", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://m.youtube.com/playlist?list=PLmobile123",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            source: "youtube",
            type: "playlist",
            id: "PLmobile123",
            url: "https://music.youtube.com/playlist?list=PLmobile123",
        });
    });

    it("parses a Spotify URI playlist link", async () => {
        mockSpotifyParseUrl.mockReturnValueOnce({
            type: "playlist",
            id: "sp_uri_123",
        });

        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "spotify:playlist:sp_uri_123",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            source: "spotify",
            type: "playlist",
            id: "sp_uri_123",
            url: "https://open.spotify.com/playlist/sp_uri_123",
        });
    });

    // ── TIDAL URLs ─────────────────────────────────────────────────

    it("parses a TIDAL playlist URL (listen.tidal.com)", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://listen.tidal.com/playlist/12345678-abcd-ef01-2345-1234567890ab",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            source: "tidal",
            type: "playlist",
            id: "12345678-abcd-ef01-2345-1234567890ab",
            url: "https://listen.tidal.com/playlist/12345678-abcd-ef01-2345-1234567890ab",
        });
    });

    it("parses a TIDAL browse playlist URL (tidal.com/browse)", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://tidal.com/browse/playlist/aabbccdd-1234-5678-9012-abcdefabcdef",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            source: "tidal",
            type: "playlist",
            id: "aabbccdd-1234-5678-9012-abcdefabcdef",
            url: "https://listen.tidal.com/playlist/aabbccdd-1234-5678-9012-abcdefabcdef",
        });
    });

    // ── Rejection ──────────────────────────────────────────────────

    it("returns 400 for unsupported URLs", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "https://example.com/not-a-playlist" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/unsupported/i);
    });

    it("rejects URLs that only contain embedded provider links in query params", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://evil.example/?next=https://music.youtube.com/playlist?list=PLabc123",
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/unsupported/i);
    });

    it("rejects URLs that only contain embedded Spotify links in query params", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://evil.example/?next=https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/unsupported/i);
    });

    it("returns 400 when no URL provided", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
    });

    it("requires authentication for URL parse", async () => {
        const res = await request(app)
            .post("/api/browse/playlists/parse")
            .send({ url: "https://music.youtube.com/playlist?list=PLabc" });

        expect(res.status).toBe(401);
    });
});
