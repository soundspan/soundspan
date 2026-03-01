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

jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        getMappingsForAlbum: jest.fn(),
        createMapping: jest.fn(),
    },
}));

import { trackMappingService } from "../../services/trackMappingService";
import router from "../trackMappings";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/track-mappings", router);

describe("track mappings routes integration", () => {
    const mockGetMappingsForAlbum =
        trackMappingService.getMappingsForAlbum as jest.Mock;
    const mockCreateMapping = trackMappingService.createMapping as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("requires auth for GET /api/track-mappings/album/:albumId", async () => {
        const res = await request(app).get("/api/track-mappings/album/album-1");

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("returns mappings for an album", async () => {
        const mappings = [
            {
                trackId: "track-1",
                trackYtMusicId: "yt-1",
                confidence: 0.97,
                source: "manual",
            },
        ];
        mockGetMappingsForAlbum.mockResolvedValueOnce(mappings);

        const res = await request(app)
            .get("/api/track-mappings/album/album-42")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ mappings });
        expect(mockGetMappingsForAlbum).toHaveBeenCalledWith("album-42");
    });

    it("validates POST /api/track-mappings/batch payload", async () => {
        const res = await request(app)
            .post("/api/track-mappings/batch")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ mappings: [] });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid mappings array",
            })
        );
        expect(mockCreateMapping).not.toHaveBeenCalled();
    });

    it("creates mappings in batch and returns created rows", async () => {
        mockCreateMapping
            .mockResolvedValueOnce({
                id: "map-1",
                trackId: "track-1",
                trackYtMusicId: "yt-1",
                confidence: 0.95,
                source: "manual",
            })
            .mockResolvedValueOnce({
                id: "map-2",
                trackTidalId: "tidal-2",
                trackYtMusicId: "yt-2",
                confidence: 0.88,
                source: "import-match",
            });

        const payload = {
            mappings: [
                {
                    trackId: "track-1",
                    trackYtMusicId: "yt-1",
                    confidence: 0.95,
                    source: "manual",
                },
                {
                    trackTidalId: "tidal-2",
                    trackYtMusicId: "yt-2",
                    confidence: 0.88,
                    source: "import-match",
                },
            ],
        };

        const res = await request(app)
            .post("/api/track-mappings/batch")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send(payload);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            mappings: [
                expect.objectContaining({ id: "map-1", trackYtMusicId: "yt-1" }),
                expect.objectContaining({ id: "map-2", trackYtMusicId: "yt-2" }),
            ],
        });
        expect(mockCreateMapping).toHaveBeenCalledTimes(2);
        expect(mockCreateMapping).toHaveBeenNthCalledWith(1, payload.mappings[0]);
        expect(mockCreateMapping).toHaveBeenNthCalledWith(2, payload.mappings[1]);
    });
});
