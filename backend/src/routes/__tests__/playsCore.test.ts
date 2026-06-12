import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

const mockLoggerError = jest.fn();

const prisma = {
    track: {
        findUnique: jest.fn(),
    },
    play: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        deleteMany: jest.fn(),
    },
};

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

jest.mock("../../utils/db", () => ({
    prisma,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        ensureRemoteTrack: jest.fn(),
    },
}));

jest.mock("../../services/remoteTrackMetadataResolver", () => ({
    resolveRemoteTrackMetadataForRequest: jest.fn(),
}));

import { prisma as prismaClient } from "../../utils/db";
import router from "../plays";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/plays", router);

describe("plays routes integration", () => {
    const mockTrackFindUnique = prismaClient.track.findUnique as jest.Mock;
    const mockPlayCreate = prismaClient.play.create as jest.Mock;
    const mockPlayFindMany = prismaClient.play.findMany as jest.Mock;
    const mockPlayCount = prismaClient.play.count as jest.Mock;
    const mockPlayDeleteMany = prismaClient.play.deleteMany as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackFindUnique.mockResolvedValue({ id: "track-1" });
        mockPlayCreate.mockResolvedValue({
            id: "play-1",
            userId: "user-1",
            trackId: "track-1",
            source: "LIBRARY",
        });
        mockPlayFindMany.mockResolvedValue([]);
        mockPlayCount.mockResolvedValue(0);
        mockPlayDeleteMany.mockResolvedValue({ count: 0 });
    });

    it("requires auth for all mounted plays routes", async () => {
        const [postRes, listRes, summaryRes, historyRes] = await Promise.all([
            request(app).post("/api/plays").send({ trackId: "track-1" }),
            request(app).get("/api/plays"),
            request(app).get("/api/plays/summary"),
            request(app).delete("/api/plays/history?range=all"),
        ]);

        expect(postRes.status).toBe(401);
        expect(listRes.status).toBe(401);
        expect(summaryRes.status).toBe(401);
        expect(historyRes.status).toBe(401);
        expect(postRes.body).toEqual({ error: "Not authenticated" });
        expect(listRes.body).toEqual({ error: "Not authenticated" });
        expect(summaryRes.body).toEqual({ error: "Not authenticated" });
        expect(historyRes.body).toEqual({ error: "Not authenticated" });
    });

    it("POST /api/plays creates a play record with trackId", async () => {
        const res = await request(app)
            .post("/api/plays")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ trackId: "track-1" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            id: "play-1",
            userId: "user-1",
            trackId: "track-1",
            source: "LIBRARY",
        });
        expect(mockTrackFindUnique).toHaveBeenCalledWith({
            where: { id: "track-1" },
        });
        expect(mockPlayCreate).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                trackId: "track-1",
                source: "LIBRARY",
            },
        });
    });

    it("POST /api/plays validates required fields", async () => {
        const res = await request(app)
            .post("/api/plays")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid request",
                details: expect.any(Array),
            })
        );
        expect(mockTrackFindUnique).not.toHaveBeenCalled();
        expect(mockPlayCreate).not.toHaveBeenCalled();
    });

    it("GET /api/plays returns recent plays for the authenticated user", async () => {
        mockPlayFindMany.mockResolvedValueOnce([
            {
                id: "play-local",
                playedAt: new Date("2026-03-01T10:00:00.000Z"),
                source: "LIBRARY",
                track: {
                    id: "track-1",
                    title: "Local Song",
                    duration: 210,
                    trackNumber: 7,
                    filePath: "/music/local-song.flac",
                    displayTitle: "Local Song (Remaster)",
                    album: {
                        id: "album-1",
                        title: "Local Album",
                        coverUrl: "native:albums/album-1.jpg",
                        artist: {
                            id: "artist-1",
                            name: "Local Artist",
                            mbid: null,
                        },
                    },
                },
                trackTidal: null,
                trackYtMusic: null,
            },
            {
                id: "play-tidal",
                playedAt: new Date("2026-03-02T10:00:00.000Z"),
                source: "TIDAL",
                track: null,
                trackTidal: {
                    id: "tidal-row-1",
                    tidalId: 12345,
                    title: "Tidal Song",
                    artist: "Tidal Artist",
                    album: "Tidal Album",
                    duration: 205,
                    artistId: "tidal-artist-1",
                    albumId: "tidal-album-1",
                },
                trackYtMusic: null,
            },
            {
                id: "play-youtube",
                playedAt: new Date("2026-03-03T10:00:00.000Z"),
                source: "YOUTUBE_MUSIC",
                track: null,
                trackTidal: null,
                trackYtMusic: {
                    id: "yt-row-1",
                    videoId: "video-123",
                    title: "YouTube Song",
                    artist: "YouTube Artist",
                    album: "YouTube Album",
                    duration: 199,
                    thumbnailUrl: "https://img.example/video-123.jpg",
                    artistId: "yt-artist-1",
                    albumId: "yt-album-1",
                },
            },
            {
                id: "play-orphaned",
                playedAt: new Date("2026-03-04T10:00:00.000Z"),
                source: "LIBRARY",
                track: null,
                trackTidal: null,
                trackYtMusic: null,
            },
        ]);

        const res = await request(app)
            .get("/api/plays?limit=3")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(mockPlayFindMany).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            orderBy: { playedAt: "desc" },
            take: 3,
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
                trackTidal: true,
                trackYtMusic: true,
            },
        });
        expect(res.body).toHaveLength(3);
        expect(res.body).toEqual([
            {
                id: "play-local",
                playedAt: "2026-03-01T10:00:00.000Z",
                source: "LIBRARY",
                track: {
                    id: "track-1",
                    title: "Local Song",
                    displayTitle: "Local Song (Remaster)",
                    duration: 210,
                    trackNo: 7,
                    source: "local",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: null,
                    },
                    filePath: "/music/local-song.flac",
                    artist: {
                        id: "artist-1",
                        name: "Local Artist",
                    },
                    album: {
                        id: "album-1",
                        title: "Local Album",
                        coverArt: "native:albums/album-1.jpg",
                        artist: {
                            id: "artist-1",
                            name: "Local Artist",
                        },
                    },
                },
            },
            {
                id: "play-tidal",
                playedAt: "2026-03-02T10:00:00.000Z",
                source: "TIDAL",
                track: {
                    id: "tidal:12345",
                    title: "Tidal Song",
                    displayTitle: null,
                    duration: 205,
                    trackNo: null,
                    source: "tidal",
                    provider: {
                        tidalTrackId: 12345,
                        youtubeVideoId: null,
                    },
                    filePath: null,
                    artist: {
                        id: "tidal-artist-1",
                        name: "Tidal Artist",
                    },
                    album: {
                        id: "tidal-album-1",
                        title: "Tidal Album",
                        coverArt: null,
                        artist: {
                            id: "tidal-artist-1",
                            name: "Tidal Artist",
                        },
                    },
                    streamSource: "tidal",
                    tidalTrackId: 12345,
                },
            },
            {
                id: "play-youtube",
                playedAt: "2026-03-03T10:00:00.000Z",
                source: "YOUTUBE_MUSIC",
                track: {
                    id: "yt:video-123",
                    title: "YouTube Song",
                    displayTitle: null,
                    duration: 199,
                    trackNo: null,
                    source: "youtube",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: "video-123",
                    },
                    filePath: null,
                    artist: {
                        id: "yt-artist-1",
                        name: "YouTube Artist",
                    },
                    album: {
                        id: "yt-album-1",
                        title: "YouTube Album",
                        coverArt: "https://img.example/video-123.jpg",
                        artist: {
                            id: "yt-artist-1",
                            name: "YouTube Artist",
                        },
                    },
                    streamSource: "youtube",
                    youtubeVideoId: "video-123",
                },
            },
        ]);
    });

    it("GET /api/plays/summary returns aggregated play statistics", async () => {
        mockPlayCount
            .mockResolvedValueOnce(120)
            .mockResolvedValueOnce(7)
            .mockResolvedValueOnce(30)
            .mockResolvedValueOnce(90);

        const res = await request(app)
            .get("/api/plays/summary")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            allTime: 120,
            last7Days: 7,
            last30Days: 30,
            last365Days: 90,
        });
        expect(mockPlayCount).toHaveBeenCalledTimes(4);
        expect(mockPlayCount).toHaveBeenNthCalledWith(1, {
            where: { userId: "user-1" },
        });
    });

    it("DELETE /api/plays/history rejects invalid ranges and clears bounded ranges", async () => {
        const invalidRes = await request(app)
            .delete("/api/plays/history?range=invalid")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(invalidRes.status).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Invalid range. Expected one of: 7d, 30d, 365d, all",
        });
        expect(mockPlayDeleteMany).not.toHaveBeenCalled();

        mockPlayDeleteMany.mockResolvedValueOnce({ count: 14 });

        const successRes = await request(app)
            .delete("/api/plays/history?range=7d")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(successRes.status).toBe(200);
        expect(successRes.body).toEqual({
            success: true,
            range: "7d",
            deletedCount: 14,
        });
        expect(mockPlayDeleteMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                userId: "user-1",
                playedAt: expect.objectContaining({
                    gte: expect.any(Date),
                    lte: expect.any(Date),
                }),
            }),
        });
    });

    it("returns 500 responses when database operations fail", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({ id: "track-1" });
        mockPlayCreate.mockRejectedValueOnce(new Error("create failed"));

        const postRes = await request(app)
            .post("/api/plays")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ trackId: "track-1" });

        expect(postRes.status).toBe(500);
        expect(postRes.body).toEqual({ error: "Failed to log play" });

        mockPlayFindMany.mockRejectedValueOnce(new Error("findMany failed"));

        const listRes = await request(app)
            .get("/api/plays")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(listRes.status).toBe(500);
        expect(listRes.body).toEqual({ error: "Failed to get plays" });

        mockPlayCount.mockRejectedValueOnce(new Error("count failed"));

        const summaryRes = await request(app)
            .get("/api/plays/summary")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(summaryRes.status).toBe(500);
        expect(summaryRes.body).toEqual({ error: "Failed to get play history summary" });

        mockPlayDeleteMany.mockRejectedValueOnce(new Error("delete failed"));

        const historyRes = await request(app)
            .delete("/api/plays/history?range=all")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(historyRes.status).toBe(500);
        expect(historyRes.body).toEqual({ error: "Failed to clear play history" });
        expect(mockLoggerError).toHaveBeenCalledTimes(4);
    });
});
