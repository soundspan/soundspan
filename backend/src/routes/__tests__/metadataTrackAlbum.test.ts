import type { NextFunction, Request, Response } from "express";

const mockResolveAlbumForExternalTrack = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        if (req.headers.authorization === "Bearer test-token") {
            return next();
        }
        return res
            .status(401)
            .json({ error: "Not authenticated", code: "AUTH_REQUIRED" });
    },
}));

jest.mock("../../services/trackAlbumResolution", () => ({
    resolveAlbumForExternalTrack: mockResolveAlbumForExternalTrack,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue({ error: jest.fn() }),
    },
}));

import request from "supertest";
import router from "../metadata";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/metadata", router);
const authenticatedGet = (query = "") =>
    request(app)
        .get(`/api/metadata/track-album${query}`)
        .set("Authorization", "Bearer test-token");

describe("GET /api/metadata/track-album", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("requires authentication", async () => {
        const response = await request(app).get(
            "/api/metadata/track-album?artist=Radiohead&title=Paranoid%20Android",
        );

        expect(response.status).toBe(401);
        expect(mockResolveAlbumForExternalTrack).not.toHaveBeenCalled();
    });

    it("rejects missing and oversized query parameters", async () => {
        const missing = await authenticatedGet("?artist=Radiohead");
        const oversized = await authenticatedGet(
            `?artist=${"a".repeat(257)}&title=Song`,
        );

        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({
            error: "Invalid track album query",
            code: "INVALID_QUERY",
        });
        expect(oversized.status).toBe(400);
        expect(mockResolveAlbumForExternalTrack).not.toHaveBeenCalled();
    });

    it("returns a clean 404 when the track album cannot be resolved", async () => {
        mockResolveAlbumForExternalTrack.mockResolvedValueOnce({
            status: "miss",
        });

        const response = await authenticatedGet(
            "?artist=Radiohead&title=Paranoid%20Android",
        );

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
            error: "Track album not found",
            code: "TRACK_ALBUM_NOT_FOUND",
        });
    });

    it("returns 503 with a distinct code when resolution times out", async () => {
        mockResolveAlbumForExternalTrack.mockResolvedValueOnce({
            status: "timeout",
        });

        const response = await authenticatedGet(
            "?artist=Radiohead&title=Paranoid%20Android",
        );

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            error: "Track album resolution timed out",
            code: "RESOLUTION_TIMEOUT",
        });
    });

    it("returns the resolution and trims bounded query input", async () => {
        const resolution = {
            albumTitle: "OK Computer",
            rgMbid: "rg-ok-computer",
            artistName: "Radiohead",
            source: "musicbrainz-recording",
        };
        mockResolveAlbumForExternalTrack.mockResolvedValueOnce({
            status: "resolved",
            resolution,
        });

        const response = await authenticatedGet(
            "?artist=%20Radiohead%20&title=%20Paranoid%20Android%20&album=%20Unknown%20Album%20",
        );

        expect(response.status).toBe(200);
        expect(response.body).toEqual(resolution);
        expect(mockResolveAlbumForExternalTrack).toHaveBeenCalledWith({
            artistName: "Radiohead",
            trackTitle: "Paranoid Android",
            albumTitle: "Unknown Album",
        });
    });
});
