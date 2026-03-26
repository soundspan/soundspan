import { PassThrough } from "node:stream";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";

function passthroughAuth(req: Request, _res: Response, next: NextFunction) {
    req.user = {
        id: "user-1",
        username: "tester",
        role: "user",
    };
    next();
}

jest.mock("../../middleware/auth", () => ({
    requireAuth: passthroughAuth,
    requireAuthOrToken: passthroughAuth,
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

const ytMusicService = {
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
};

const normalizeYtMusicStreamQuality = jest.fn(
    (quality: string | null | undefined) => {
        const normalized = quality?.trim().toLowerCase();
        return normalized === "low" ||
            normalized === "medium" ||
            normalized === "high" ||
            normalized === "lossless"
            ? normalized
            : undefined;
    }
);

jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService,
    normalizeYtMusicStreamQuality,
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

const prisma = {
    userSettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const decrypt = jest.fn((value: string | null) =>
    typeof value === "string" ? value.replace(/^enc:/, "") : null
);
jest.mock("../../utils/encryption", () => ({
    encrypt: jest.fn((value: string) => `enc:${value}`),
    decrypt: (value: string | null) => decrypt(value),
}));

jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        upsertTrackYtMusic: jest.fn(),
    },
}));

import router from "../youtubeMusic";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/ytmusic", router);

describe("youtubeMusic routes branch coverage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({
            ytMusicEnabled: true,
            ytMusicClientId: "cid",
            ytMusicClientSecret: "csecret",
        });

        ytMusicService.getAuthStatus.mockResolvedValue({ authenticated: true });
        ytMusicService.searchCanonical.mockResolvedValue({
            query: "q",
            filter: null,
            total: 0,
            results: [],
        });
        ytMusicService.getAlbum.mockResolvedValue({ id: "album" });
        ytMusicService.getSong.mockResolvedValue({ id: "song" });
        ytMusicService.getStreamInfo.mockResolvedValue({
            videoId: "v1",
            abr: 160,
            acodec: "opus",
            duration: 100,
            content_type: "audio/webm",
        });
        ytMusicService.getStreamProxy.mockResolvedValue({
            status: 200,
            headers: {
                "content-type": "audio/webm",
                "content-length": "5",
            },
            data: new PassThrough(),
        });
        ytMusicService.getLibrarySongs.mockResolvedValue([{ id: "s1" }]);
        ytMusicService.findMatchForTrack.mockResolvedValue({ videoId: "v1" });

        prisma.userSettings.findUnique.mockResolvedValue({
            ytMusicOAuthJson: "enc:{\"token\":\"x\"}",
            ytMusicQuality: "LOW",
        });
    });

    it("returns 403 when integration is disabled", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({ ytMusicEnabled: false });

        const res = await request(app)
            .post("/api/ytmusic/search")
            .send({ query: "x" });

        expect(res.status).toBe(403);
        expect(res.body.error).toContain("not enabled");
    });

    it("uses __public__ for album when OAuth credentials are missing", async () => {
        ytMusicService.getAuthStatus.mockResolvedValueOnce({ authenticated: false });
        prisma.userSettings.findUnique.mockResolvedValueOnce({ ytMusicOAuthJson: null });

        const res = await request(app).get("/api/ytmusic/album/alb-1");

        expect(res.status).toBe(200);
        expect(ytMusicService.getAlbum).toHaveBeenCalledWith("__public__", "alb-1");
    });

    it("rejects library when user OAuth is missing/expired", async () => {
        ytMusicService.getAuthStatus.mockResolvedValueOnce({ authenticated: false });
        prisma.userSettings.findUnique.mockResolvedValueOnce({ ytMusicOAuthJson: null });

        const res = await request(app).get("/api/ytmusic/library/songs");

        expect(res.status).toBe(401);
        expect(res.body.error).toContain("authentication expired or missing");
        expect(ytMusicService.getLibrarySongs).not.toHaveBeenCalled();
    });

    it("rejects library when encrypted OAuth cannot be decrypted", async () => {
        ytMusicService.getAuthStatus.mockResolvedValueOnce({ authenticated: false });
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            ytMusicOAuthJson: "enc:broken",
        });
        decrypt.mockReturnValueOnce(null);

        const res = await request(app).get("/api/ytmusic/library/songs");

        expect(res.status).toBe(401);
        expect(res.body.error).toContain("authentication expired or missing");
    });

    it("returns unauthorized when OAuth restore throws", async () => {
        ytMusicService.getAuthStatus.mockResolvedValueOnce({ authenticated: false });
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            ytMusicOAuthJson: "enc:{\"refresh_token\":\"r\"}",
        });
        ytMusicService.restoreOAuthWithCredentials.mockRejectedValueOnce(
            new Error("restore failed")
        );

        const res = await request(app).get("/api/ytmusic/library/albums");

        expect(res.status).toBe(401);
        expect(res.body.error).toContain("authentication expired or missing");
    });

    it("falls back to default stream quality when stored quality is invalid", async () => {
        prisma.userSettings.findUnique.mockResolvedValueOnce({ ytMusicQuality: "ULTRA" });

        const res = await request(app).get("/api/ytmusic/stream-info/video-1?quality=   ");

        expect(res.status).toBe(200);
        expect(ytMusicService.getStreamInfo).toHaveBeenCalledWith(
            "user-1",
            "video-1",
            "high"
        );
    });

    it("falls back to default stream quality on user settings read failure", async () => {
        prisma.userSettings.findUnique.mockRejectedValueOnce(
            new Error("db unavailable")
        );

        const res = await request(app).get("/api/ytmusic/stream-info/video-1");

        expect(res.status).toBe(200);
        expect(ytMusicService.getStreamInfo).toHaveBeenCalledWith(
            "user-1",
            "video-1",
            "high"
        );
    });

    it("keeps explicit requested quality string without DB lookup", async () => {
        const res = await request(app).get(
            "/api/ytmusic/stream-info/video-1?quality=  custom-quality  "
        );

        expect(res.status).toBe(200);
        expect(prisma.userSettings.findUnique).not.toHaveBeenCalledWith(
            expect.objectContaining({ select: { ytMusicQuality: true } })
        );
        expect(ytMusicService.getStreamInfo).toHaveBeenCalledWith(
            "user-1",
            "video-1",
            "custom-quality"
        );
    });

    it("validates empty search query and invalid match payloads", async () => {
        const emptySearch = await request(app)
            .post("/api/ytmusic/search")
            .send({ query: "" });
        expect(emptySearch.status).toBe(400);

        const invalidMatch = await request(app)
            .post("/api/ytmusic/match")
            .send({ artist: "Artist", title: "Title", isrc: "123" });
        expect(invalidMatch.status).toBe(400);

        const tooManyTracks = Array.from({ length: 51 }, (_, i) => ({
            artist: `A${i}`,
            title: `T${i}`,
        }));
        const invalidBatch = await request(app)
            .post("/api/ytmusic/match-batch")
            .send({ tracks: tooManyTracks });
        expect(invalidBatch.status).toBe(400);
    });

    it("forwards only available stream proxy headers", async () => {
        const stream = new PassThrough();
        ytMusicService.getStreamProxy.mockResolvedValueOnce({
            status: 206,
            headers: {
                "content-type": "audio/webm",
                "content-length": "10",
                "content-range": "bytes 0-9/100",
                "accept-ranges": undefined,
            },
            data: stream,
        });

        const responsePromise = request(app)
            .get("/api/ytmusic/stream/video-9")
            .set("Range", "bytes=0-9");
        stream.end("0123456789");
        const res = await responsePromise;

        expect(res.status).toBe(206);
        expect(res.headers["content-type"]).toContain("audio/webm");
        expect(res.headers["content-range"]).toBe("bytes 0-9/100");
        expect(res.headers["accept-ranges"]).toBeUndefined();
    });

    it("returns song details for authenticated browse path", async () => {
        const res = await request(app).get("/api/ytmusic/song/video-1");
        expect(res.status).toBe(200);
        expect(ytMusicService.getSong).toHaveBeenCalledWith("user-1", "video-1");
    });

    it("maps public stream-info 451 and generic failures", async () => {
        ytMusicService.getStreamInfo.mockRejectedValueOnce({
            response: { status: 451 },
        });
        const ageRestricted = await request(app).get(
            "/api/ytmusic/stream-info-public/video-1"
        );
        expect(ageRestricted.status).toBe(451);
        expect(ageRestricted.body.error).toBe("age_restricted");

        ytMusicService.getStreamInfo.mockRejectedValueOnce(new Error("boom"));
        const genericError = await request(app).get(
            "/api/ytmusic/stream-info-public/video-1"
        );
        expect(genericError.status).toBe(500);
        expect(genericError.body).toEqual({ error: "Failed to get stream info" });
    });

    it("handles public stream proxy error callback and exception mapping", async () => {
        let earlyOnError: ((err: Error) => void) | undefined;
        const earlyErrorStream = {
            on: (event: string, cb: (err: Error) => void) => {
                if (event === "error") earlyOnError = cb;
                return earlyErrorStream;
            },
            pipe: () => {
                earlyOnError?.(new Error("upstream dropped"));
            },
        };
        ytMusicService.getStreamProxy.mockResolvedValueOnce({
            status: 200,
            headers: { "content-type": "audio/webm" },
            data: earlyErrorStream,
        });

        const upstreamErrorRes = await request(app).get(
            "/api/ytmusic/stream-public/video-1"
        );
        expect(upstreamErrorRes.status).toBe(502);

        let onError: ((err: Error) => void) | undefined;
        const syntheticStream = {
            on: (event: string, cb: (err: Error) => void) => {
                if (event === "error") onError = cb;
                return syntheticStream;
            },
            pipe: (res: Response) => {
                res.write("x");
                onError?.(new Error("late upstream error"));
            },
        };
        ytMusicService.getStreamProxy.mockResolvedValueOnce({
            status: 200,
            headers: { "content-type": "audio/webm" },
            data: syntheticStream,
        });
        const headersSentRes = await request(app).get(
            "/api/ytmusic/stream-public/video-2"
        );
        expect(headersSentRes.status).toBe(200);

        ytMusicService.getStreamProxy.mockRejectedValueOnce({
            response: { status: 404 },
        });
        const notFound = await request(app).get("/api/ytmusic/stream-public/missing");
        expect(notFound.status).toBe(404);

        ytMusicService.getStreamProxy.mockRejectedValueOnce({
            response: { status: 451 },
        });
        const restricted = await request(app).get("/api/ytmusic/stream-public/age");
        expect(restricted.status).toBe(451);

        ytMusicService.getStreamProxy.mockRejectedValueOnce(new Error("proxy failed"));
        const generic = await request(app).get("/api/ytmusic/stream-public/video-3");
        expect(generic.status).toBe(500);
        expect(generic.body).toEqual({ error: "Failed to stream audio" });
    });

    it("skips DB restore when sidecar already reports authenticated", async () => {
        ytMusicService.getAuthStatus.mockResolvedValueOnce({ authenticated: true });

        const res = await request(app).get("/api/ytmusic/library/songs?limit=5");

        expect(res.status).toBe(200);
        expect(ytMusicService.getLibrarySongs).toHaveBeenCalledWith("user-1", 5);
        expect(ytMusicService.restoreOAuthWithCredentials).not.toHaveBeenCalled();
        expect(prisma.userSettings.findUnique).not.toHaveBeenCalledWith(
            expect.objectContaining({ select: { ytMusicOAuthJson: true } })
        );
    });
});
