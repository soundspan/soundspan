import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
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

jest.mock("../../services/playlistImportService", () => ({
    playlistImportService: {
        previewImport: jest.fn(),
        importPlaylist: jest.fn(),
    },
}));

import { playlistImportService } from "../../services/playlistImportService";
import router from "../playlistImport";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/import", router);

describe("import routes integration", () => {
    const mockPreviewImport = playlistImportService.previewImport as jest.Mock;
    const mockImportPlaylist = playlistImportService.importPlaylist as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("requires auth for POST /api/import/preview", async () => {
        const res = await request(app)
            .post("/api/import/preview")
            .send({ url: "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk" });

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("validates preview payload and returns 400 for invalid url", async () => {
        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "not-a-url" });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Valid playlist URL is required",
            })
        );
        expect(mockPreviewImport).not.toHaveBeenCalled();
    });

    it("returns preview results for valid import URLs", async () => {
        const preview = {
            source: "spotify",
            playlistName: "Weekend Mix",
            totalTracks: 2,
            resolvedTracks: [
                { title: "Track 1", matched: true },
                { title: "Track 2", matched: false },
            ],
        };
        mockPreviewImport.mockResolvedValueOnce(preview);

        const url = "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk";
        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(preview);
        expect(mockPreviewImport).toHaveBeenCalledWith("user-1", url);
    });

    it("rejects execute when previewData is missing", async () => {
        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ name: "Test" });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Valid previewData is required",
            })
        );
        expect(mockImportPlaylist).not.toHaveBeenCalled();
    });

    it("rejects execute when source/ID linkage is inconsistent", async () => {
        const previewData = {
            playlistName: "Bad Playlist",
            resolved: [
                {
                    index: 0,
                    artist: "A1",
                    title: "T1",
                    source: "local",
                    confidence: 100,
                    // source is "local" but has no trackId — inconsistent
                },
            ],
            summary: { total: 1, local: 1, youtube: 0, tidal: 0, unresolved: 0 },
        };

        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ previewData });

        expect(res.status).toBe(400);
        expect(mockImportPlaylist).not.toHaveBeenCalled();
    });

    it("rejects execute when youtube source has no trackYtMusicId", async () => {
        const previewData = {
            playlistName: "Bad YT Playlist",
            resolved: [
                {
                    index: 0,
                    artist: "A1",
                    title: "T1",
                    source: "youtube",
                    confidence: 85,
                    // missing trackYtMusicId
                },
            ],
            summary: { total: 1, local: 0, youtube: 1, tidal: 0, unresolved: 0 },
        };

        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ previewData });

        expect(res.status).toBe(400);
        expect(mockImportPlaylist).not.toHaveBeenCalled();
    });

    it("returns 502 when sidecar fetch fails during preview", async () => {
        mockPreviewImport.mockRejectedValueOnce(
            new Error("ECONNREFUSED: connect failed to ytmusic-streamer:8586")
        );

        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "https://music.youtube.com/playlist?list=PLtest" });

        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/external service/i);
    });

    it("returns 400 when Tidal auth is required but missing during preview", async () => {
        mockPreviewImport.mockRejectedValueOnce(
            new Error("Tidal import requires authentication")
        );

        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "https://tidal.com/playlist/a1b2c3d4-e5f6-0000-0000-000000000001" });

        expect(res.status).toBe(400);
    });

    it("executes imports with previewData and forwards response payload", async () => {
        const executeResult = {
            playlistId: "playlist-123",
            summary: {
                total: 2,
                local: 1,
                youtube: 1,
                tidal: 0,
                unresolved: 0,
            },
        };
        mockImportPlaylist.mockResolvedValueOnce(executeResult);

        const previewData = {
            playlistName: "Imported Playlist",
            resolved: [
                {
                    index: 0,
                    artist: "A1",
                    title: "T1",
                    source: "local",
                    confidence: 100,
                    trackId: "track_1",
                },
                {
                    index: 1,
                    artist: "A2",
                    title: "T2",
                    source: "youtube",
                    confidence: 85,
                    trackYtMusicId: "cy_1",
                },
            ],
            summary: {
                total: 2,
                local: 1,
                youtube: 1,
                tidal: 0,
                unresolved: 0,
            },
        };

        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                previewData,
                name: "Custom Name",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(executeResult);
        expect(mockImportPlaylist).toHaveBeenCalledWith(
            "user-1",
            previewData,
            "Custom Name"
        );
    });
});
