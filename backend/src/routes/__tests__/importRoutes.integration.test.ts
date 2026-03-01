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

    it("maps unsupported source failures to 400 on execute", async () => {
        mockImportPlaylist.mockRejectedValueOnce(
            new Error("Unsupported playlist source")
        );

        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url: "https://example.com/not-supported/playlist/1",
                name: "Imported Playlist",
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: expect.stringContaining("Unsupported"),
            })
        );
    });

    it("executes imports and forwards response payload", async () => {
        const executeResult = {
            playlistId: "playlist-123",
            name: "Imported Playlist",
            added: 24,
        };
        mockImportPlaylist.mockResolvedValueOnce(executeResult);

        const url = "https://www.deezer.com/playlist/908070605";
        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                url,
                name: "Imported Playlist",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(executeResult);
        expect(mockImportPlaylist).toHaveBeenCalledWith(
            "user-1",
            url,
            "Imported Playlist"
        );
    });
});
