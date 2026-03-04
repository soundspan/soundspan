import { PassThrough } from "stream";
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

jest.mock("../../middleware/rateLimiter", () => ({
    ytMusicSearchLimiter: (
        _req: Request,
        _res: Response,
        next: NextFunction
    ) => next(),
    ytMusicStreamLimiter: (
        _req: Request,
        _res: Response,
        next: NextFunction
    ) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService: {
        isAvailable: jest.fn(),
        getAuthStatus: jest.fn(),
        restoreOAuthWithCredentials: jest.fn(),
        initiateDeviceAuth: jest.fn(),
        pollDeviceAuth: jest.fn(),
        clearAuth: jest.fn(),
        searchCanonical: jest.fn(),
        getAlbum: jest.fn(),
        getArtist: jest.fn(),
        getSong: jest.fn(),
        getStreamInfo: jest.fn(),
        getStreamProxy: jest.fn(),
        getLibrarySongs: jest.fn(),
        getLibraryAlbums: jest.fn(),
        findMatchForTrack: jest.fn(),
        findMatchesForAlbum: jest.fn(),
    },
    normalizeYtMusicStreamQuality: jest.fn((quality: string) => `norm:${quality}`),
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        userSettings: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        upsertTrackYtMusic: jest.fn(),
    },
}));

jest.mock("../../utils/encryption", () => ({
    encrypt: jest.fn((value: string) => `enc:${value}`),
    decrypt: jest.fn((value: string) => value.replace(/^enc:/, "")),
}));

import {
    normalizeYtMusicStreamQuality,
    ytMusicService,
} from "../../services/youtubeMusic";
import { getSystemSettings } from "../../utils/systemSettings";
import router from "../youtubeMusic";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/ytmusic", router);

describe("youtube music public stream routes integration", () => {
    const mockGetSystemSettings = getSystemSettings as jest.Mock;
    const mockNormalizeQuality =
        normalizeYtMusicStreamQuality as unknown as jest.Mock;
    const mockGetStreamInfo = ytMusicService.getStreamInfo as jest.Mock;
    const mockGetStreamProxy = ytMusicService.getStreamProxy as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
    });

    it("requires auth for /api/ytmusic/stream-info-public/:videoId", async () => {
        const res = await request(app).get(
            "/api/ytmusic/stream-info-public/video-1"
        );

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("returns 403 when ytmusic is disabled", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({ ytMusicEnabled: false });

        const res = await request(app)
            .get("/api/ytmusic/stream-info-public/video-1")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(403);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: expect.stringContaining("not enabled"),
            })
        );
        expect(mockGetStreamInfo).not.toHaveBeenCalled();
    });

    it("uses __public__ sentinel user for stream-info-public", async () => {
        mockGetStreamInfo.mockResolvedValueOnce({
            videoId: "video-1",
            abr: 192,
            acodec: "opus",
            duration: 203,
            content_type: "audio/webm",
            ignored_field: "not returned",
        });

        const res = await request(app)
            .get("/api/ytmusic/stream-info-public/video-1?quality=low")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            videoId: "video-1",
            abr: 192,
            acodec: "opus",
            duration: 203,
            content_type: "audio/webm",
        });
        expect(mockNormalizeQuality).toHaveBeenCalledWith("low");
        expect(mockGetStreamInfo).toHaveBeenCalledWith(
            "__public__",
            "video-1",
            "norm:low"
        );
    });

    it("maps stream-info-public missing content to 404", async () => {
        mockGetStreamInfo.mockRejectedValueOnce({
            response: { status: 404 },
        });

        const res = await request(app)
            .get("/api/ytmusic/stream-info-public/missing-video")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Stream not found" });
    });

    it("proxies /stream-public with sentinel user, default quality, and range header", async () => {
        const upstream = new PassThrough();
        mockGetStreamProxy.mockResolvedValueOnce({
            status: 206,
            headers: {
                "content-type": "audio/webm",
                "content-length": "10",
                "content-range": "bytes 0-9/100",
                "accept-ranges": "bytes",
            },
            data: upstream,
        });

        const responsePromise = request(app)
            .get("/api/ytmusic/stream-public/video-2")
            .set(AUTH_HEADER, AUTH_VALUE)
            .set("Range", "bytes=0-9");

        upstream.end("0123456789");
        const res = await responsePromise;

        expect(res.status).toBe(206);
        expect(res.headers["content-type"]).toContain("audio/webm");
        expect(res.headers["content-range"]).toBe("bytes 0-9/100");
        expect(res.headers["accept-ranges"]).toBe("bytes");
        expect(mockNormalizeQuality).toHaveBeenCalledWith("HIGH");
        expect(mockGetStreamProxy).toHaveBeenCalledWith(
            "__public__",
            "video-2",
            "norm:HIGH",
            "bytes=0-9"
        );
    });
});
