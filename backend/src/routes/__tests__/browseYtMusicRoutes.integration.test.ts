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
        getBrowsePlaylist: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

import { ytMusicService } from "../../services/youtubeMusic";
import { getSystemSettings } from "../../utils/systemSettings";
import router from "../browse";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/browse", router);

describe("browse ytmusic routes integration", () => {
    const mockGetCharts = ytMusicService.getCharts as jest.Mock;
    const mockGetMoodCategories = ytMusicService.getMoodCategories as jest.Mock;
    const mockGetBrowsePlaylist = ytMusicService.getBrowsePlaylist as jest.Mock;
    const mockGetSystemSettings = getSystemSettings as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
    });

    it("requires auth for GET /api/browse/ytmusic/charts", async () => {
        const res = await request(app).get("/api/browse/ytmusic/charts");

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("returns 403 when ytmusic browse is disabled", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({ ytMusicEnabled: false });

        const res = await request(app)
            .get("/api/browse/ytmusic/charts")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(403);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: expect.stringContaining("not enabled"),
            })
        );
        expect(mockGetCharts).not.toHaveBeenCalled();
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
});
