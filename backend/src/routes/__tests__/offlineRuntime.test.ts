// requireAuth populates req.user (never req.session) — this mock mirrors that
// so tests exercise the same request shape a real authenticated client
// produces. Unused by the getHandler-extraction calls below (they bypass
// router.use middleware entirely), kept accurate so it isn't misleading.
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: () => void) => {
        req.user = { id: "u1", username: "u1", role: "user" };
        next();
    },
}));

const mockLoggerError = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

const prisma = {
    userSettings: {
        findUnique: jest.fn(),
    },
    album: {
        findUnique: jest.fn(),
    },
    track: {
        findFirst: jest.fn(),
    },
    cachedTrack: {
        aggregate: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

import router from "../offline";
import { prisma as prismaClient } from "../../utils/db";

const mockUserSettingsFindUnique = prismaClient.userSettings
    .findUnique as jest.Mock;
const mockAlbumFindUnique = prismaClient.album.findUnique as jest.Mock;
const mockTrackFindFirst = prismaClient.track.findFirst as jest.Mock;
const mockCachedTrackAggregate = prismaClient.cachedTrack
    .aggregate as jest.Mock;
const mockCachedTrackUpsert = prismaClient.cachedTrack.upsert as jest.Mock;
const mockCachedTrackFindMany = prismaClient.cachedTrack.findMany as jest.Mock;
const mockCachedTrackDeleteMany = prismaClient.cachedTrack
    .deleteMany as jest.Mock;

function getHandler(method: "get" | "post" | "delete", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };

    return res;
}

describe("offline routes runtime", () => {
    const postAlbumDownload = getHandler("post", "/albums/:id/download");
    const postTrackComplete = getHandler("post", "/tracks/:id/complete");
    const getAlbums = getHandler("get", "/albums");
    const deleteAlbum = getHandler("delete", "/albums/:id");
    const getStats = getHandler("get", "/stats");

    beforeEach(() => {
        jest.clearAllMocks();

        mockUserSettingsFindUnique.mockResolvedValue({
            userId: "u1",
            playbackQuality: "medium",
            maxCacheSizeMb: 2048,
        });
        mockAlbumFindUnique.mockResolvedValue({
            id: "album-1",
            title: "Album One",
            artist: { name: "Artist One" },
            tracks: [
                {
                    id: "t1",
                    title: "Track 1",
                    trackNo: 1,
                    duration: 120,
                    discNo: 1,
                },
                {
                    id: "t2",
                    title: "Track 2",
                    trackNo: 2,
                    duration: 130,
                    discNo: 1,
                },
            ],
        });
        mockTrackFindFirst.mockResolvedValue({ id: "t1" });
        mockCachedTrackAggregate.mockResolvedValue({
            _sum: { fileSizeMb: 100 },
            _count: 2,
        });
        mockCachedTrackUpsert.mockResolvedValue({
            id: "cached-1",
            userId: "u1",
            trackId: "t1",
            localPath: "/music/t1.mp3",
            quality: "high",
            fileSizeMb: 11.2,
        });
        mockCachedTrackFindMany.mockResolvedValue([
            {
                id: "cached-1",
                localPath: "/music/t1.mp3",
                quality: "high",
                fileSizeMb: 11.2,
                track: {
                    id: "t1",
                    title: "Track 1",
                    removedAt: null,
                    origin: "LOCAL",
                    album: {
                        id: "album-1",
                        title: "Album One",
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                            mbid: "mbid-1",
                        },
                    },
                },
            },
            {
                id: "cached-2",
                localPath: "/music/t2.mp3",
                quality: "medium",
                fileSizeMb: 9.8,
                track: {
                    id: "t2",
                    title: "Track 2",
                    removedAt: null,
                    origin: "LOCAL",
                    album: {
                        id: "album-1",
                        title: "Album One",
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                            mbid: "mbid-1",
                        },
                    },
                },
            },
        ]);
        mockCachedTrackDeleteMany.mockResolvedValue({ count: 2 });
    });

    it("creates download jobs with explicit quality", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "album-1" },
            body: { quality: "high" },
        } as any;
        const res = createRes();

        await postAlbumDownload(req, res);

        expect(mockAlbumFindUnique).toHaveBeenCalledWith({
            where: { id: "album-1" },
            include: {
                tracks: {
                    where: {
                        removedAt: null,
                        origin: "LOCAL",
                        album: {
                            location: {
                                in: [
                                    "LIBRARY",
                                    "DISCOVER",
                                    "REMOTE",
                                    "FEDERATED",
                                ],
                            },
                        },
                    },
                    orderBy: [{ discNo: "asc" }, { trackNo: "asc" }],
                },
                artist: {
                    select: { name: true },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                albumId: "album-1",
                albumTitle: "Album One",
                artistName: "Artist One",
                quality: "high",
                estimatedSizeMb: 20,
                tracks: expect.arrayContaining([
                    expect.objectContaining({
                        trackId: "t1",
                        streamUrl: "/library/tracks/t1/stream?quality=high",
                    }),
                ]),
            }),
        );
    });

    it("uses user default quality when request omits quality", async () => {
        mockUserSettingsFindUnique
            .mockResolvedValueOnce({
                userId: "u1",
                playbackQuality: "low",
                maxCacheSizeMb: 2048,
            })
            .mockResolvedValueOnce({
                userId: "u1",
                playbackQuality: "low",
                maxCacheSizeMb: 2048,
            });

        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "album-1" },
            body: {},
        } as any;
        const res = createRes();

        await postAlbumDownload(req, res);

        expect(mockUserSettingsFindUnique).toHaveBeenCalledTimes(2);
        expect(res.statusCode).toBe(200);
        expect(res.body.quality).toBe("low");
        expect(res.body.estimatedSizeMb).toBe(8);
    });

    it("returns 404 when album does not exist", async () => {
        mockAlbumFindUnique.mockResolvedValueOnce(null);
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "missing-album" },
            body: { quality: "medium" },
        } as any;
        const res = createRes();

        await postAlbumDownload(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Album not found" });
    });

    it("rejects downloads that exceed cache limit", async () => {
        mockUserSettingsFindUnique.mockResolvedValue({
            userId: "u1",
            playbackQuality: "medium",
            maxCacheSizeMb: 110,
        });
        mockCachedTrackAggregate.mockResolvedValueOnce({
            _sum: { fileSizeMb: 100 },
        });

        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "album-1" },
            body: { quality: "high" },
        } as any;
        const res = createRes();

        await postAlbumDownload(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Cache size limit exceeded",
            currentSize: 100,
            maxSize: 110,
            needed: 20,
        });
    });

    it("returns 400 for invalid payload and 500 for unexpected failures", async () => {
        const invalidReq = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "album-1" },
            body: { quality: "ultra" },
        } as any;
        const invalidRes = createRes();
        await postAlbumDownload(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Invalid request",
            details: expect.any(Array),
        });

        mockAlbumFindUnique.mockRejectedValueOnce(new Error("db down"));
        const errorReq = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "album-1" },
            body: { quality: "high" },
        } as any;
        const errorRes = createRes();
        await postAlbumDownload(errorReq, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to create download job",
        });
    });

    it("validates required fields for track completion", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "t1" },
            body: {},
        } as any;
        const res = createRes();

        await postTrackComplete(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid request",
            details: expect.any(Array),
        });
        expect(mockCachedTrackUpsert).not.toHaveBeenCalled();
    });

    it("rejects an out-of-allowlist completion quality", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "t1" },
            body: {
                localPath: "/cache/t1.mp3",
                quality: "ultra",
                fileSizeMb: 15.5,
            },
        } as any;
        const res = createRes();

        await postTrackComplete(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid request",
            details: expect.any(Array),
        });
        expect(mockCachedTrackUpsert).not.toHaveBeenCalled();
    });

    it.each([
        ["negative", -1],
        ["NaN", "NaN"],
        ["over the per-file maximum", 4097],
    ])("rejects a %s completion file size", async (_label, fileSizeMb) => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "t1" },
            body: {
                localPath: "/cache/t1.mp3",
                quality: "high",
                fileSizeMb,
            },
        } as any;
        const res = createRes();

        await postTrackComplete(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid request",
            details: expect.any(Array),
        });
        expect(mockCachedTrackUpsert).not.toHaveBeenCalled();
    });

    it("rejects an overlong completion local path", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "t1" },
            body: {
                localPath: "x".repeat(1025),
                quality: "high",
                fileSizeMb: 15.5,
            },
        } as any;
        const res = createRes();

        await postTrackComplete(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid request",
            details: expect.any(Array),
        });
        expect(mockCachedTrackUpsert).not.toHaveBeenCalled();
    });

    it("upserts completed cached tracks with a parsed numeric size", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "t1" },
            body: {
                localPath: "/cache/t1.mp3",
                quality: "high",
                fileSizeMb: "15.5",
            },
        } as any;
        const res = createRes();

        await postTrackComplete(req, res);

        expect(mockTrackFindFirst).toHaveBeenCalledWith({
            where: {
                id: "t1",
                removedAt: null,
                origin: "LOCAL",
                album: {
                    location: {
                        in: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
                    },
                },
            },
            select: { id: true },
        });

        expect(mockCachedTrackUpsert).toHaveBeenCalledWith({
            where: {
                userId_trackId_quality: {
                    userId: "u1",
                    trackId: "t1",
                    quality: "high",
                },
            },
            create: {
                userId: "u1",
                trackId: "t1",
                localPath: "/cache/t1.mp3",
                quality: "high",
                fileSizeMb: 15.5,
            },
            update: {
                localPath: "/cache/t1.mp3",
                fileSizeMb: 15.5,
                lastAccessedAt: expect.any(Date),
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({ id: "cached-1", trackId: "t1" }),
        );
    });

    it("returns 404 without caching a removed track", async () => {
        mockTrackFindFirst.mockResolvedValueOnce(null);
        const req = {
            user: { id: "u1" },
            params: { id: "removed-track" },
            body: {
                localPath: "/cache/removed.flac",
                quality: "high",
                fileSizeMb: 12,
            },
        } as any;
        const res = createRes();

        await postTrackComplete(req, res);

        expect(res.statusCode).toBe(404);
        expect(mockCachedTrackUpsert).not.toHaveBeenCalled();
    });

    it("returns 500 when a completed track upsert fails", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "t1" },
            body: {
                localPath: "/cache/t1.mp3",
                quality: "high",
                fileSizeMb: "15.5",
            },
        } as any;
        const res = createRes();

        mockCachedTrackUpsert.mockRejectedValueOnce(new Error("write failed"));
        await postTrackComplete(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to complete download" });
    });

    it("returns cached albums grouped by album id", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
        } as any;
        const res = createRes();

        await getAlbums(req, res);

        expect(mockCachedTrackFindMany).toHaveBeenCalledWith({
            where: { userId: "u1" },
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
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toEqual(
            expect.objectContaining({
                id: "album-1",
                totalSizeMb: 21,
                cachedTracks: expect.arrayContaining([
                    expect.objectContaining({
                        id: "t1",
                        cachedPath: "/music/t1.mp3",
                        cachedQuality: "high",
                    }),
                ]),
            }),
        );
    });

    it("evicts and omits cached rows for removed tracks", async () => {
        mockCachedTrackFindMany.mockResolvedValueOnce([
            {
                id: "cached-removed",
                localPath: "/music/removed.flac",
                quality: "original",
                fileSizeMb: 20,
                track: {
                    id: "removed-track",
                    title: "Removed",
                    removedAt: new Date("2026-01-01T00:00:00.000Z"),
                    album: {
                        id: "album-1",
                        title: "Album One",
                        artist: { id: "artist-1", name: "Artist One" },
                    },
                },
            },
        ]);
        const req = {
            user: { id: "u1", username: "u1", role: "user" },
        } as any;
        const res = createRes();

        await getAlbums(req, res);

        expect(mockCachedTrackDeleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["cached-removed"] }, userId: "u1" },
        });
        expect(res.body).toEqual([]);
    });

    it("returns 500 when cached albums query fails", async () => {
        mockCachedTrackFindMany.mockRejectedValueOnce(new Error("db down"));
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
        } as any;
        const res = createRes();

        await getAlbums(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get cached albums" });
    });

    it("deletes all cached tracks for an album and returns deleted count", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "album-1" },
        } as any;
        const res = createRes();

        await deleteAlbum(req, res);

        expect(mockCachedTrackFindMany).toHaveBeenCalledWith({
            where: {
                userId: "u1",
                track: {
                    albumId: "album-1",
                },
            },
        });
        expect(mockCachedTrackDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "u1",
                track: {
                    albumId: "album-1",
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Album removed from cache",
            deletedCount: 2,
        });
    });

    it("returns 500 when album cache deletion fails", async () => {
        mockCachedTrackDeleteMany.mockRejectedValueOnce(
            new Error("delete failed"),
        );
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            params: { id: "album-1" },
        } as any;
        const res = createRes();

        await deleteAlbum(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to delete cached album" });
    });

    it("returns cache usage stats and default max when settings are missing", async () => {
        mockUserSettingsFindUnique.mockResolvedValueOnce(null);
        mockCachedTrackAggregate.mockResolvedValueOnce({
            _sum: { fileSizeMb: 80 },
            _count: 5,
        });

        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
        } as any;
        const res = createRes();
        await getStats(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            usedMb: 80,
            maxMb: 5120,
            availableMb: 5040,
            percentUsed: (80 / 5120) * 100,
            trackCount: 5,
        });
    });

    it("returns 500 when stats query fails", async () => {
        mockCachedTrackAggregate.mockRejectedValueOnce(
            new Error("aggregate failed"),
        );
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
        } as any;
        const res = createRes();

        await getStats(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get cache stats" });
    });

    it("scopes /stats to the authenticated user, not a hardcoded id", async () => {
        // Regression guard for the req.session.userId! bug (roadmap F11 step 1):
        // a second, differently-authenticated user must see their OWN userId
        // reach Prisma, proving userId is read from req.user and not stale
        // session state or a copy-pasted literal.
        const otherUserReq = {
            session: {},
            user: { id: "u2", username: "u2", role: "user" },
        } as any;
        const res = createRes();

        await getStats(otherUserReq, res);

        expect(mockUserSettingsFindUnique).toHaveBeenCalledWith({
            where: { userId: "u2" },
        });
        expect(mockCachedTrackAggregate).toHaveBeenCalledWith({
            where: { userId: "u2" },
            _sum: { fileSizeMb: true },
            _count: true,
        });
    });
});
