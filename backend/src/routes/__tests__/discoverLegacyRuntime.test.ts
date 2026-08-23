import { Request, Response } from "express";
import fs from "fs";

jest.mock("@prisma/client", () => ({
    Prisma: {
        PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
        PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
        PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
        sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
            strings,
            values,
        }),
    },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
    requireAdmin: (req: any, res: any, next: () => void) => {
        if (!req.user || req.user.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
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

jest.mock("../../config", () => ({
    config: {
        discover: {
            mode: "legacy",
        },
        music: {
            musicPath: "/music",
        },
        workers: {
            providerTrackRetentionDays: 30,
        },
    },
}));

const prisma = {
    discoveryBatch: {
        findFirst: jest.fn(async () => null),
    },
    discoveryAlbum: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(async () => null),
        update: jest.fn(async () => undefined),
        updateMany: jest.fn(async () => ({ count: 1 })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    unavailableAlbum: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    track: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    album: {
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
        update: jest.fn(async () => undefined),
        updateMany: jest.fn(async () => ({ count: 0 })),
        delete: jest.fn(async () => undefined),
        deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    ownedAlbum: {
        findFirst: jest.fn(async () => null),
        upsert: jest.fn(async () => undefined),
        updateMany: jest.fn(async () => ({ count: 0 })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    discoveryTrack: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    play: {
        updateMany: jest.fn(async () => ({ count: 0 })),
    },
    downloadJob: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    artist: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    similarArtist: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    userDiscoverConfig: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async (args: any) => ({
            userId: args?.data?.userId ?? "user-1",
            playlistSize: 10,
            maxRetryAttempts: 3,
            exclusionMonths: 6,
            downloadRatio: 1.3,
            enabled: true,
        })),
        upsert: jest.fn(
            async (args: any) => args?.create ?? args?.update ?? {},
        ),
    },
};

const queryRaw = jest.fn(async () => [{ catalogAlbumId: null }]);

const prismaTransaction = jest.fn(
    async (callback: (transaction: typeof prisma) => unknown) =>
        callback(prisma),
);
Object.assign(prisma, { $queryRaw: queryRaw, $transaction: prismaTransaction });

jest.mock("../../utils/db", () => ({
    prisma,
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {},
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({})),
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
        delete: jest.fn(),
        put: jest.fn(),
    },
}));

jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        removeDiscoveryTagByMbid: jest.fn(async () => undefined),
        getArtists: jest.fn(async () => []),
        getDiscoveryArtists: jest.fn(async () => []),
        deleteArtistById: jest.fn(async () => ({
            success: true,
            message: "ok",
        })),
        getOrCreateDiscoveryTag: jest.fn(async () => 999),
        removeTagsFromArtist: jest.fn(async () => undefined),
    },
}));

const discoverQueue = {
    add: jest.fn(async () => ({ id: "job-legacy" })),
    getJobs: jest.fn(async () => []),
    getJob: jest.fn(async () => null),
};
const scanQueue = {
    add: jest.fn(async () => undefined),
};
const cleanupOrphanedLibraryEntities = jest.fn(async () => ({
    albumsDeleted: 0,
    artistsDeleted: 0,
}));

jest.mock("../../services/libraryOrphanCleanup", () => ({
    cleanupOrphanedLibraryEntities,
}));

jest.mock("../../workers/queues", () => ({
    discoverQueue,
    scanQueue,
}));

jest.mock("../../services/discovery", () => ({
    discoveryRecommendationsService: {
        getCurrentPlaylist: jest.fn(),
        clearCurrentPlaylist: jest.fn(),
    },
}));

import router from "../discover";
import { lidarrService } from "../../services/lidarr";
import axios from "axios";
import { getSystemSettings } from "../../utils/systemSettings";

const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;
const mockAxiosPut = axios.put as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "delete" | "patch",
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokePostRouteStack(path: string, req: any, res: any) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.post,
    );
    if (!layer) throw new Error(`Route not found: POST ${path}`);

    const maxRouteHandlers = 3;
    for (let index = 0; index < maxRouteHandlers; index += 1) {
        const handler = layer.route.stack[index]?.handle;
        if (!handler) return;

        let continued = false;
        await handler(req, res, () => {
            continued = true;
        });
        if (!continued) return;
    }

    throw new Error(`POST ${path} exceeded the test handler limit`);
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

describe("discover legacy-mode runtime behavior", () => {
    const batchStatusHandler = getRouteHandler("/batch-status", "get");
    const generateHandler = getRouteHandler("/generate", "post");
    const currentHandler = getRouteHandler("/current", "get");
    const likeHandler = getRouteHandler("/like", "post");
    const unlikeHandler = getRouteHandler("/unlike", "delete");
    const configGetHandler = getRouteHandler("/config", "get");
    const configPatchHandler = getRouteHandler("/config", "patch");
    const clearHandler = getRouteHandler("/clear", "delete");
    const cleanupLidarrHandler = getRouteHandler("/cleanup-lidarr", "post");
    const fixTaggingHandler = getRouteHandler("/fix-tagging", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        let lockedDiscoveryId = "discovery-album-1";
        (queryRaw as jest.Mock).mockImplementation(
            async (query: {
                strings: readonly string[];
                values: unknown[];
            }) => {
                const sql = query.strings.join("");
                if (!sql.includes("DiscoveryAlbum")) {
                    return [{ id: query.values[0] }];
                }
                lockedDiscoveryId = String(query.values[0]);
                const status =
                    lockedDiscoveryId.includes("liked") ||
                    lockedDiscoveryId.includes("no-tracks")
                        ? "LIKED"
                        : "ACTIVE";
                return [
                    { id: lockedDiscoveryId, catalogAlbumId: null, status },
                ];
            },
        );
        (prisma.discoveryAlbum.findMany as jest.Mock).mockImplementation(
            async (args: { where?: { catalogAlbumId?: string } }) =>
                args.where?.catalogAlbumId
                    ? [{ id: lockedDiscoveryId, status: "ACTIVE" }]
                    : [],
        );
        (prisma.album.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        (prisma.discoveryAlbum.findUnique as jest.Mock).mockResolvedValue({
            catalogAlbumId: null,
        });
        (prisma.album.findUnique as jest.Mock).mockImplementation(async () => {
            const fallbackResult = (
                prisma.album.findFirst as jest.Mock
            ).mock.results.at(-1);
            return fallbackResult ? await fallbackResult.value : null;
        });
        (prisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({
            count: 1,
        });
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "lidarr-key",
        });
        mockAxiosGet.mockResolvedValue({ data: [] });
        mockAxiosDelete.mockResolvedValue({ data: {} });
        mockAxiosPut.mockResolvedValue({ data: {} });
    });

    it("returns inactive legacy batch status when no active batch exists", async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await batchStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            active: false,
            status: null,
            progress: null,
        });
    });

    it("maps legacy batch status progress from completed + failed jobs", async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "batch-1",
            status: "downloading",
            jobs: [
                { status: "completed" },
                { status: "failed" },
                { status: "processing" },
                { status: "pending" },
            ],
        });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await batchStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            active: true,
            status: "downloading",
            batchId: "batch-1",
            progress: 50,
            completed: 1,
            failed: 1,
            total: 4,
        });
    });

    it("reports zero progress for legacy batches with no job history", async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "batch-empty",
            status: "downloading",
            jobs: [],
        });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await batchStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            active: true,
            status: "downloading",
            batchId: "batch-empty",
            progress: 0,
            completed: 0,
            failed: 0,
            total: 0,
        });
    });

    it("returns conflict when legacy generation is already in progress", async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "batch-active",
            status: "scanning",
        });

        const req = { user: { id: "user-1", role: "admin" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "Generation already in progress",
            batchId: "batch-active",
            status: "scanning",
        });
    });

    it("returns 500 when legacy generation lookup fails before queueing", async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockRejectedValueOnce(
            new Error("discovery unavailable"),
        );

        const req = { user: { id: "user-1", role: "admin" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to start generation",
        });
    });

    it("queues legacy generation when no active batch exists", async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );
        discoverQueue.add.mockResolvedValueOnce({ id: "job-legacy-77" });

        const req = { user: { id: "user-1", role: "admin" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(discoverQueue.add).toHaveBeenCalledWith({ userId: "user-1" });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Discover Weekly generation started",
            jobId: "job-legacy-77",
        });
    });

    it("forbids non-admin legacy generation before lookup or queueing", async () => {
        const req = { user: { id: "user-1", role: "user" } } as any;
        const res = createRes();

        await generateHandler(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({
            error: "Discover Weekly downloads are admin-only on this server",
        });
        expect(prisma.discoveryBatch.findFirst).not.toHaveBeenCalled();
        expect(discoverQueue.add).not.toHaveBeenCalled();
    });

    it("returns empty current-week legacy playlist when no discovery data exists", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValueOnce(
            [],
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await currentHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                tracks: [],
                unavailable: [],
                totalCount: 0,
                unavailableCount: 0,
            }),
        );
    });

    it("returns 500 for legacy current route failures", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockRejectedValueOnce(
            new Error("db boom"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await currentHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get Discover Weekly playlist",
        });
    });

    it("builds current-week payload with imported, pending, and unavailable albums", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "da-1",
                rgMbid: "rg-1",
                artistName: "Artist One",
                albumTitle: "Album One",
                status: "ACTIVE",
                likedAt: null,
                similarity: 0.7,
                tier: "high",
                tracks: [{ trackId: "track-1" }],
            },
            {
                id: "da-2",
                rgMbid: "rg-2",
                artistName: "Artist Two",
                albumTitle: "Album Two",
                status: "LIKED",
                likedAt: new Date("2026-02-16T12:00:00.000Z"),
                similarity: 0.6,
                tier: "medium",
                tracks: [],
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-1",
                title: "Song One",
                duration: 180,
                loudnessLufs: -17.1,
                truePeakDb: -1.2,
                album: {
                    coverUrl: "https://cover/one.jpg",
                    albumLoudnessLufs: -18.2,
                    albumTruePeakDb: -0.6,
                    artist: { name: "Artist One" },
                },
            },
        ]);
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "ua-skip-success",
                albumMbid: "rg-1",
                albumTitle: "Album One",
                artistName: "Artist One",
                similarity: 0.7,
                tier: "high",
                previewUrl: null,
                deezerTrackId: null,
                deezerAlbumId: null,
                attemptNumber: 1,
                originalAlbumId: "orig-1",
            },
            {
                id: "ua-skip-owned",
                albumMbid: "rg-owned",
                albumTitle: "Owned Album",
                artistName: "Owned Artist",
                similarity: 0.5,
                tier: "explore",
                previewUrl: null,
                deezerTrackId: null,
                deezerAlbumId: null,
                attemptNumber: 1,
                originalAlbumId: "orig-2",
            },
            {
                id: "ua-keep",
                albumMbid: "rg-unavailable",
                albumTitle: "Missing Album",
                artistName: "Missing Artist",
                similarity: 0.4,
                tier: "wildcard",
                previewUrl: "https://preview",
                deezerTrackId: "dz-track",
                deezerAlbumId: "dz-album",
                attemptNumber: 2,
                originalAlbumId: "orig-3",
            },
        ]);
        (prisma.album.findFirst as jest.Mock).mockImplementation(
            async (query: any) => {
                // Fallback lookup for discovery album #2 -> unresolved, becomes pending
                if (
                    query?.where?.title === "Album Two" &&
                    query?.where?.artist
                ) {
                    return null;
                }
                // Unavailable filter lookups
                if (query?.where?.OR) {
                    const contains = query.where.OR?.[1]?.title?.contains;
                    if (contains === "owned album") {
                        return { id: "album-owned" };
                    }
                    return null;
                }
                return null;
            },
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await currentHandler(req, res);

        expect(prisma.album.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                include: expect.objectContaining({
                    tracks: {
                        where: { removedAt: null },
                        take: 1,
                        orderBy: { trackNo: "asc" },
                    },
                }),
            }),
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.totalCount).toBe(2);
        expect(res.body.unavailableCount).toBe(1);
        expect(res.body.tracks[0]).toEqual(
            expect.objectContaining({
                id: "track-1",
                title: "Song One",
                available: true,
                loudnessLufs: -17.1,
                truePeakDb: -1.2,
                albumLoudnessLufs: -18.2,
                albumTruePeakDb: -0.6,
            }),
        );
        expect(res.body.tracks[1]).toEqual(
            expect.objectContaining({
                id: "pending-da-2",
                isPending: true,
                available: false,
            }),
        );
        expect(res.body.unavailable[0]).toEqual(
            expect.objectContaining({
                albumId: "rg-unavailable",
                title: "Missing Album",
                artist: "Missing Artist",
            }),
        );
    });

    it("likes a discovery album and promotes it to library ownership state", async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "discovery-1",
            artistName: "Liked Artist",
            artistMbid: "artist-mbid-1",
            albumTitle: "Liked Album",
            rgMbid: "rg-liked-1",
            status: "ACTIVE",
        });
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "album-1",
            artistId: "artist-1",
            rgMbid: "rg-liked-1",
            title: "Liked Album",
            artist: { name: "Liked Artist" },
        });
        (prisma.discoveryTrack.findMany as jest.Mock).mockResolvedValueOnce([
            { trackId: "track-1" },
            { trackId: "track-2" },
        ]);

        const req = {
            user: { id: "user-1" },
            body: { albumId: "rg-liked-1" },
        } as any;
        const res = createRes();
        await likeHandler(req, res);

        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "discovery-1", status: "ACTIVE" },
                data: expect.objectContaining({
                    status: "LIKED",
                }),
            }),
        );
        expect(lidarrService.removeDiscoveryTagByMbid).toHaveBeenCalledWith(
            "artist-mbid-1",
        );
        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-1" },
            data: { location: "LIBRARY" },
        });
        expect(prisma.ownedAlbum.upsert).toHaveBeenCalled();
        expect(prismaTransaction).toHaveBeenCalledTimes(1);
        expect(prismaTransaction.mock.invocationCallOrder[0]).toBeLessThan(
            (lidarrService.removeDiscoveryTagByMbid as jest.Mock).mock
                .invocationCallOrder[0],
        );
        expect(prisma.play.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    source: "DISCOVERY",
                    trackId: { in: ["track-1", "track-2"] },
                }),
                data: { source: "DISCOVERY_KEPT" },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
    });

    it("validates like requests require albumId", async () => {
        const req = { user: { id: "user-1" }, body: {} } as any;
        const res = createRes();

        await likeHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "albumId required" });
    });

    it("returns 404 when liking an album not in active discovery", async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );

        const req = {
            user: { id: "user-1" },
            body: { albumId: "rg-missing" },
        } as any;
        const res = createRes();

        await likeHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Album not in active discovery" });
    });

    it("rejects a like when its catalog album is absent", async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "discovery-temp",
            artistName: "Lookup Artist",
            artistMbid: "temp-artist-1",
            albumTitle: "Lookup Album",
            rgMbid: "rg-temp-1",
            status: "ACTIVE",
        });
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (lidarrService.getArtists as jest.Mock).mockResolvedValueOnce([
            { id: 42, artistName: "Lookup Artist", tags: [999] },
        ]);
        (
            lidarrService.getOrCreateDiscoveryTag as jest.Mock
        ).mockResolvedValueOnce(999);

        const req = {
            user: { id: "user-1" },
            body: { albumId: "rg-temp-1" },
        } as any;
        const res = createRes();

        await likeHandler(req, res);

        expect(lidarrService.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
        expect(lidarrService.removeTagsFromArtist).not.toHaveBeenCalled();
        expect(prisma.play.updateMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Album not in active discovery" });
    });

    it("unlikes a previously liked album and reverts discovery ownership markers", async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "discovery-liked",
            rgMbid: "rg-liked-2",
            status: "LIKED",
        });
        (prisma.discoveryTrack.findMany as jest.Mock).mockResolvedValueOnce([
            { trackId: "track-a" },
        ]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "album-liked",
            artistId: "artist-liked",
            rgMbid: "rg-liked-2",
            artist: { name: "Liked Artist" },
        });

        const req = {
            user: { id: "user-1" },
            body: { albumId: "rg-liked-2" },
        } as any;
        const res = createRes();
        await unlikeHandler(req, res);

        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: "discovery-liked", status: "LIKED" },
            data: { status: "ACTIVE", likedAt: null },
        });
        expect(prisma.ownedAlbum.deleteMany).toHaveBeenCalledWith({
            where: {
                artistId: "artist-liked",
                rgMbid: "rg-liked-2",
                source: "discovery_liked",
            },
        });
        expect(prisma.play.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    source: "DISCOVERY_KEPT",
                    trackId: { in: ["track-a"] },
                }),
                data: { source: "DISCOVERY" },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
    });

    it("validates unlike requests require albumId", async () => {
        const req = { user: { id: "user-1" }, body: {} } as any;
        const res = createRes();

        await unlikeHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "albumId required" });
    });

    it("returns 404 when unliking an album that is not liked", async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );

        const req = {
            user: { id: "user-1" },
            body: { albumId: "rg-not-liked" },
        } as any;
        const res = createRes();

        await unlikeHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Album not liked" });
    });

    it("unlikes album without touching play history when discovery tracks are absent", async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "discovery-no-tracks",
            rgMbid: "rg-no-tracks",
            status: "LIKED",
        });
        (prisma.discoveryTrack.findMany as jest.Mock).mockResolvedValueOnce([
            { trackId: null },
        ]);

        const req = {
            user: { id: "user-1" },
            body: { albumId: "rg-no-tracks" },
        } as any;
        const res = createRes();

        await unlikeHandler(req, res);

        expect(prisma.play.updateMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
    });

    it("creates default discover config when none exists and validates patch bounds", async () => {
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce(null);
        const getReq = { user: { id: "user-1" } } as any;
        const getRes = createRes();
        await configGetHandler(getReq, getRes);

        expect(prisma.userDiscoverConfig.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: "user-1",
                    playlistSize: 10,
                    enabled: true,
                }),
            }),
        );
        expect(getRes.statusCode).toBe(200);

        const patchReq = {
            user: { id: "user-1" },
            body: { playlistSize: 7 },
        } as any;
        const patchRes = createRes();
        await configPatchHandler(patchReq, patchRes);

        expect(patchRes.statusCode).toBe(400);
        expect(patchRes.body).toEqual({
            error: "Invalid playlist size. Must be between 5-50 in increments of 5.",
        });
    });

    it("clears legacy playlist and delegates orphan pruning to tombstone-aware cleanup", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            lidarrEnabled: false,
            lidarrUrl: "",
            lidarrApiKey: "",
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "da-liked",
                userId: "user-1",
                status: "LIKED",
                artistName: "Liked Artist",
                albumTitle: "Liked Album",
                artistMbid: "mbid-liked",
                rgMbid: "rg-liked",
                lidarrAlbumId: 11,
            },
            {
                id: "da-active",
                userId: "user-1",
                status: "ACTIVE",
                artistName: "Active Artist",
                albumTitle: "Active Album",
                artistMbid: "mbid-active",
                rgMbid: "rg-active",
                lidarrAlbumId: 22,
            },
        ]);
        (prisma.album.findFirst as jest.Mock).mockImplementation(
            async (args: any) => {
                if (args?.where?.rgMbid === "rg-liked") {
                    return {
                        id: "album-liked",
                        artistId: "artist-liked",
                        rgMbid: "rg-liked",
                        artist: { id: "artist-liked", name: "Liked Artist" },
                    };
                }
                if (args?.where?.rgMbid === "rg-active") {
                    return {
                        id: "album-active",
                        artistId: "artist-active",
                        rgMbid: "rg-active",
                        tracks: [{ id: "track-active-1" }],
                        artist: { id: "artist-active", name: "Active Artist" },
                    };
                }
                return null;
            },
        );
        (prisma.discoveryTrack.deleteMany as jest.Mock)
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 2 });
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "orphan-album-1",
                rgMbid: "rg-orphan",
                title: "Orphan Album",
                artist: { id: "artist-orphan", name: "Orphan Artist" },
                tracks: [{ id: "orphan-track-1" }],
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([
            { id: "artist-orphan", name: "Orphan Artist" },
        ]);
        (prisma.discoveryAlbum.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 1,
        });
        (prisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValueOnce(
            {
                count: 3,
            },
        );
        cleanupOrphanedLibraryEntities.mockResolvedValueOnce({
            albumsDeleted: 1,
            artistsDeleted: 1,
        });
        scanQueue.add.mockResolvedValueOnce(undefined);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearHandler(req, res);

        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-liked" },
            data: { location: "LIBRARY" },
        });
        expect(prisma.ownedAlbum.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    artistId: "artist-liked",
                    rgMbid: "rg-liked",
                    source: "discovery_liked",
                }),
            }),
        );
        expect(prisma.track.deleteMany).not.toHaveBeenCalledWith({
            where: expect.objectContaining({ albumId: "album-active" }),
        });
        expect(prisma.album.deleteMany).toHaveBeenCalledWith({
            where: {
                id: "album-active",
                hasUserOverrides: false,
                NOT: expect.any(Object),
                discoveryRecords: { none: { status: "LIKED" } },
                ownedBy: { none: {} },
                tracksTidal: { none: { NOT: expect.any(Object) } },
                tracksYtMusic: { none: { NOT: expect.any(Object) } },
            },
        });
        expect(
            (prisma.album.deleteMany as jest.Mock).mock.invocationCallOrder[0],
        ).toBeLessThan(
            (prisma.discoveryTrack.deleteMany as jest.Mock).mock
                .invocationCallOrder[0],
        );
        expect(prisma.album.findMany).toHaveBeenCalledWith({
            where: {
                location: "DISCOVER",
                hasUserOverrides: false,
                NOT: expect.any(Object),
                discoveryRecords: { none: { status: "LIKED" } },
                ownedBy: { none: {} },
                tracksTidal: { none: { NOT: expect.any(Object) } },
                tracksYtMusic: { none: { NOT: expect.any(Object) } },
            },
            include: { artist: true, tracks: true },
        });
        expect(prisma.artist.deleteMany).not.toHaveBeenCalled();
        expect(cleanupOrphanedLibraryEntities).toHaveBeenCalledTimes(1);
        expect(scanQueue.add).toHaveBeenCalledWith("scan", {
            userId: "user-1",
            musicPath: "/music",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Discovery playlist cleared",
            likedMoved: 1,
            activeDeleted: 1,
            orphanedAlbumsDeleted: 1,
            lidarrArtistsRemoved: 0,
        });
    });

    it("preserves files, links, and state when legacy cleanup loses a like race", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "da-raced",
                userId: "user-1",
                status: "ACTIVE",
                artistName: "Raced Artist",
                albumTitle: "Raced Album",
                rgMbid: "rg-raced",
                lidarrAlbumId: 44,
            },
        ]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "album-raced",
            rgMbid: "rg-raced",
        });
        (prisma.album.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 0,
        });
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([]);
        const existsSpy = jest.spyOn(fs, "existsSync");
        const res = createRes();

        await clearHandler({ user: { id: "user-1" } } as any, res);

        expect(mockAxiosDelete).not.toHaveBeenCalled();
        expect(existsSpy).not.toHaveBeenCalled();
        expect(prisma.discoveryTrack.deleteMany).not.toHaveBeenCalledWith({
            where: { discoveryAlbumId: "da-raced" },
        });
        expect(prisma.discoveryAlbum.updateMany).not.toHaveBeenCalledWith({
            where: { id: { in: ["da-raced"] }, status: "DELETED" },
            data: { status: "ACTIVE" },
        });
        expect(res.body).toEqual(expect.objectContaining({ activeDeleted: 0 }));
    });

    it("finishes legacy links and state when a retry finds the catalog album absent", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({ lidarrEnabled: false });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "da-absent",
                userId: "user-1",
                status: "ACTIVE",
                artistName: "Absent Artist",
                albumTitle: "Absent Album",
                rgMbid: "rg-absent",
                lidarrAlbumId: null,
            },
        ]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([]);
        const res = createRes();

        await clearHandler({ user: { id: "user-1" } } as any, res);

        expect(prisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
            where: { discoveryAlbumId: "da-absent" },
        });
        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["da-absent"] },
                status: { in: ["ACTIVE", "DELETED"] },
            },
            data: { status: "DELETED" },
        });
        expect(res.body).toEqual(expect.objectContaining({ activeDeleted: 1 }));
    });

    it("returns no-op clear payload when no legacy discovery albums exist", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "No discovery albums to clear",
            likedMoved: 0,
            activeDeleted: 0,
        });
    });

    it("returns 500 when legacy clear processing throws", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockRejectedValueOnce(
            new Error("clear boom"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to clear discovery playlist",
        });
        expect(JSON.stringify(res.body)).not.toContain("clear boom");
    });

    it("covers lidarr-enabled legacy clear flows for moved, deleted, extra, failed, and tagged artists", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "lidarr-key",
        });

        (prisma.discoveryAlbum.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "da-liked",
                    userId: "user-1",
                    status: "LIKED",
                    artistName: "Liked Artist",
                    albumTitle: "Liked Album",
                    artistMbid: "mbid-liked",
                    rgMbid: "rg-liked",
                    lidarrAlbumId: 11,
                },
                {
                    id: "da-active",
                    userId: "user-1",
                    status: "ACTIVE",
                    artistName: "Active Artist",
                    albumTitle: "Active Album",
                    artistMbid: "mbid-active",
                    rgMbid: "rg-active",
                    lidarrAlbumId: 22,
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "da-active",
                    status: "ACTIVE",
                },
            ])
            .mockResolvedValueOnce([
                {
                    rgMbid: "rg-liked",
                    artistName: "Liked Artist",
                    albumTitle: "Liked Album",
                    status: "MOVED",
                },
                {
                    rgMbid: "rg-active",
                    artistName: "Active Artist",
                    albumTitle: "Active Album",
                    status: "DELETED",
                },
            ]);

        (prisma.downloadJob.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "job-extra-1",
                    userId: "user-1",
                    status: "completed",
                    discoveryBatchId: "batch-1",
                    targetMbid: "rg-extra",
                    lidarrAlbumId: 33,
                    metadata: {
                        artistName: "Extra Artist",
                        albumTitle: "Extra Album",
                        artistMbid: "mbid-extra",
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "job-failed-1",
                    userId: "user-1",
                    status: "failed",
                    discoveryBatchId: "batch-1",
                    metadata: {
                        artistMbid: "mbid-failed",
                        artistName: "Failed Artist",
                    },
                },
            ]);

        (prisma.album.findFirst as jest.Mock).mockImplementation(
            async (args: any) => {
                if (args?.where?.rgMbid === "rg-liked") {
                    return {
                        id: "album-liked",
                        artistId: "artist-liked",
                        rgMbid: "rg-liked",
                        artist: { id: "artist-liked", name: "Liked Artist" },
                    };
                }
                if (args?.where?.rgMbid === "rg-active") {
                    return {
                        id: "album-active",
                        artistId: "artist-active",
                        rgMbid: "rg-active",
                        tracks: [{ id: "track-active-1" }],
                        artist: { id: "artist-active", name: "Active Artist" },
                    };
                }
                return null;
            },
        );
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);

        (prisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({
            count: 1,
        });
        (prisma.discoveryAlbum.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 0,
        });
        (prisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValueOnce(
            {
                count: 0,
            },
        );
        (prisma.downloadJob.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 1,
        });

        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockImplementation(
            async ({ where }: any) => {
                if (
                    where?.artistMbid === "mbid-keep" &&
                    Array.isArray(where?.status?.in)
                ) {
                    return { id: "kept-artist" };
                }
                return null;
            },
        );

        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([
            {
                id: 1,
                foreignArtistId: "mbid-keep",
                artistName: "Kept Tagged Artist",
            },
            {
                id: 2,
                foreignArtistId: "mbid-delete",
                artistName: "Deleted Tagged Artist",
            },
        ]);
        (lidarrService.deleteArtistById as jest.Mock).mockResolvedValueOnce({
            success: true,
            message: "deleted",
        });

        mockAxiosGet.mockImplementation(async (url: string) => {
            if (url.endsWith("/api/v1/album/11")) {
                return { data: { artistId: 101 } };
            }
            if (url.endsWith("/api/v1/artist/101")) {
                return { data: { path: "/music/discovery/Liked Artist" } };
            }
            if (url.endsWith("/api/v1/album/22")) {
                return { data: { artistId: 202 } };
            }
            if (url.endsWith("/api/v1/artist/202")) {
                return {
                    data: {
                        foreignArtistId: "mbid-active",
                        artistName: "Active Artist",
                    },
                };
            }
            if (url.endsWith("/api/v1/album/33")) {
                return { data: { artistId: 303 } };
            }
            if (url.endsWith("/api/v1/artist")) {
                return {
                    data: [
                        {
                            id: 404,
                            foreignArtistId: "mbid-failed",
                            artistName: "Failed Artist",
                        },
                    ],
                };
            }
            throw new Error(`unexpected axios.get url: ${url}`);
        });
        mockAxiosDelete.mockResolvedValue({ data: {} });
        mockAxiosPut.mockResolvedValue({ data: {} });

        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockImplementation((targetPath: fs.PathLike) =>
                String(targetPath).includes("Active Artist"),
            );
        const rmSpy = jest
            .spyOn(fs, "rmSync")
            .mockImplementation(() => undefined as unknown as void);

        scanQueue.add.mockRejectedValueOnce(new Error("queue down"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearHandler(req, res);

        expect(mockAxiosPut).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/artist/101",
            expect.objectContaining({
                path: "/music/Liked Artist",
                moveFiles: true,
            }),
            expect.any(Object),
        );
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/album/22",
            expect.any(Object),
        );
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/artist/202",
            expect.any(Object),
        );
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/album/33",
            expect.any(Object),
        );
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/artist/303",
            expect.any(Object),
        );
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/artist/404",
            expect.any(Object),
        );
        expect(lidarrService.removeDiscoveryTagByMbid).toHaveBeenCalledWith(
            "mbid-keep",
        );
        expect(lidarrService.deleteArtistById).toHaveBeenCalledWith(2, true);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                success: true,
                likedMoved: 1,
                activeDeleted: 1,
                lidarrArtistsRemoved: 1,
            }),
        );

        existsSpy.mockRestore();
        rmSpy.mockRestore();
    });

    it("returns 400 for cleanup when Lidarr is not configured", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            lidarrEnabled: false,
            lidarrUrl: "",
            lidarrApiKey: "",
        });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await cleanupLidarrHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Lidarr not configured" });
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("cleans up only unprotected discovery-only Lidarr artists", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: [
                {
                    id: 1,
                    foreignArtistId: "mbid-native",
                    artistName: "Native Artist",
                },
                {
                    id: 2,
                    foreignArtistId: "mbid-liked",
                    artistName: "Liked Artist",
                },
                {
                    id: 3,
                    foreignArtistId: "mbid-active",
                    artistName: "Active Artist",
                },
                {
                    id: 4,
                    foreignArtistId: "mbid-remove",
                    artistName: "Remove Artist",
                },
                {
                    id: 5,
                    foreignArtistId: "mbid-error",
                    artistName: "Error Artist",
                },
            ],
        });

        (prisma.ownedAlbum.findFirst as jest.Mock).mockImplementation(
            async ({ where }: any) => {
                if (where.artist?.mbid === "mbid-native") {
                    return { id: "owned-1", source: "native_scan" };
                }
                return null;
            },
        );

        (prisma.discoveryAlbum.findFirst as jest.Mock).mockImplementation(
            async ({ where }: any) => {
                if (
                    where.artistMbid === "mbid-liked" &&
                    Array.isArray(where.status?.in)
                ) {
                    return { id: "liked-1" };
                }

                if (
                    where.artistMbid === "mbid-active" &&
                    where.status === "ACTIVE"
                ) {
                    return { id: "active-1" };
                }

                return null;
            },
        );

        mockAxiosDelete.mockImplementation(async (url: string) => {
            if (url.endsWith("/5")) {
                throw new Error("delete failed");
            }
            return { data: {} };
        });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await cleanupLidarrHandler(req, res);

        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/artist/4",
            expect.objectContaining({
                params: { deleteFiles: true },
                headers: { "X-Api-Key": "lidarr-key" },
            }),
        );
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/artist/5",
            expect.objectContaining({
                params: { deleteFiles: true },
                headers: { "X-Api-Key": "lidarr-key" },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            removed: ["Remove Artist"],
            kept: [
                "Native Artist (has native library or kept albums)",
                "Liked Artist (has native library or kept albums)",
                "Active Artist (has active discovery)",
            ],
            errors: ["Failed to process Error Artist"],
            summary: {
                removed: 1,
                kept: 3,
                errors: 1,
            },
        });
    });

    it("returns 500 when Lidarr cleanup throws unexpectedly", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("lidarr unavailable"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await cleanupLidarrHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to cleanup Lidarr" });
        expect(JSON.stringify(res.body)).not.toContain("lidarr unavailable");
    });

    it("repairs mistagged discovery albums while preserving protected artists", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            { artistMbid: "mbid-native", artistName: "Native Artist" },
            { artistMbid: "mbid-liked", artistName: "Liked Artist" },
            { artistMbid: "mbid-fix", artistName: "Fix Artist" },
            { artistMbid: null, artistName: "No Mbid" },
        ]);

        (prisma.ownedAlbum.findFirst as jest.Mock).mockImplementation(
            async ({ where }: any) => {
                if (where.artist?.mbid === "mbid-native") {
                    return { source: "native_scan" };
                }
                return null;
            },
        );

        (prisma.discoveryAlbum.findFirst as jest.Mock).mockImplementation(
            async ({ where }: any) => {
                if (
                    where.artistMbid === "mbid-liked" &&
                    Array.isArray(where.status?.in)
                ) {
                    return { id: "liked-kept" };
                }
                return null;
            },
        );

        (prisma.album.findMany as jest.Mock).mockImplementation(
            async ({ where }: any) => {
                if (where.artist?.mbid === "mbid-fix") {
                    return [{ id: "album-1" }, { id: "album-2" }];
                }
                return [];
            },
        );
        (prisma.album.updateMany as jest.Mock).mockResolvedValueOnce({
            count: 2,
        });
        (prisma.ownedAlbum.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 1,
        });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await fixTaggingHandler(req, res);

        expect(prisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                artist: { mbid: "mbid-fix" },
                location: "LIBRARY",
            },
            data: { location: "DISCOVER" },
        });
        expect(prisma.ownedAlbum.deleteMany).toHaveBeenCalledWith({
            where: {
                artist: { mbid: "mbid-fix" },
                source: { notIn: ["native_scan", "discovery_liked"] },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            albumsFixed: 2,
            ownedRecordsRemoved: 1,
            fixedArtists: ["Fix Artist"],
        });
    });

    it("allows only admins to invoke global tagging repair", async () => {
        const nonAdminRes = createRes();
        await invokePostRouteStack(
            "/fix-tagging",
            {
                headers: {},
                session: { userId: "user-1" },
                user: { id: "user-1", role: "user" },
            },
            nonAdminRes,
        );

        expect(nonAdminRes.statusCode).toBe(403);
        expect(nonAdminRes.body).toEqual({ error: "Admin access required" });
        expect(prisma.discoveryAlbum.findMany).not.toHaveBeenCalled();

        const apiKeyRes = createRes();
        await invokePostRouteStack(
            "/fix-tagging",
            {
                headers: { "x-api-key": "device-key" },
                user: { id: "user-1", role: "user" },
            },
            apiKeyRes,
        );

        expect(apiKeyRes.statusCode).toBe(403);
        expect(apiKeyRes.body).toEqual({ error: "Admin access required" });
        expect(prisma.discoveryAlbum.findMany).not.toHaveBeenCalled();

        const adminRes = createRes();
        await invokePostRouteStack(
            "/fix-tagging",
            {
                headers: {},
                session: { userId: "admin-1" },
                user: { id: "admin-1", role: "admin" },
            },
            adminRes,
        );

        expect(adminRes.statusCode).toBe(200);
        expect(adminRes.body).toEqual({
            success: true,
            albumsFixed: 0,
            ownedRecordsRemoved: 0,
            fixedArtists: [],
        });
        expect(prisma.discoveryAlbum.findMany).toHaveBeenCalledTimes(1);
    });

    it("returns 500 when fix-tagging fails", async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockRejectedValueOnce(
            new Error("discover table unavailable"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await fixTaggingHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to fix album tagging" });
        expect(JSON.stringify(res.body)).not.toContain(
            "discover table unavailable",
        );
    });
});
