jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (req: any, res: any, next: () => void) => {
        if (!req.user || req.user.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
        next();
    },
}));

const childLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(() => childLogger),
    },
}));

const prisma = {
    hiddenPlaylist: {
        findMany: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    playlist: {
        findMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
    playlistItem: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
    },
    userSettings: {
        findUnique: jest.fn(),
    },
    systemSettings: {
        findUnique: jest.fn(),
    },
    trackMapping: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
    },
    track: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
    },
    trackTidal: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
    },
    trackYtMusic: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
    },
    playlistPendingTrack: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
    downloadJob: {
        create: jest.fn(),
        update: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

const trackMappingService = {
    ensureRemoteTrack: jest.fn(),
};
jest.mock("../../services/trackMappingService", () => ({
    trackMappingService,
}));

const deezerService = {
    getTrackPreview: jest.fn(),
};
jest.mock("../../services/deezer", () => ({
    deezerService,
}));

const spotifyImportService = {
    reconcilePendingTracks: jest.fn(),
};
jest.mock("../../services/spotifyImport", () => ({
    spotifyImportService,
}));

const soulseekService = {
    searchTrack: jest.fn(),
    downloadBestMatch: jest.fn(),
};
jest.mock("../../services/soulseek", () => ({
    soulseekService,
}));

const getSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings,
}));

const scanQueue = {
    add: jest.fn(),
};
jest.mock("../../workers/queues", () => ({
    scanQueue,
}));

jest.mock("../../utils/playlistLogger", () => ({
    sessionLog: jest.fn(),
}));

import { z } from "zod";
import router from "../playlists";
import { requireAdmin } from "../../middleware/auth";

type HttpMethod = "get" | "post" | "put" | "delete";
const MAX_ROUTE_HANDLERS = 4;

function getRouteLayer(path: string, method: HttpMethod) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }
    return layer;
}

function getHandler(path: string, method: HttpMethod) {
    const layer = getRouteLayer(path, method);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeRouteStack(
    path: string,
    method: HttpMethod,
    req: any,
    res: any,
) {
    const { stack } = getRouteLayer(path, method).route;
    if (stack.length > MAX_ROUTE_HANDLERS) {
        throw new Error(`Too many route handlers: ${stack.length}`);
    }
    for (let index = 0; index < MAX_ROUTE_HANDLERS; index += 1) {
        const entry = stack[index];
        if (!entry) {
            return;
        }
        let nextCalled = false;
        await entry.handle(req, res, () => {
            nextCalled = true;
        });
        if (!nextCalled) {
            return;
        }
    }
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

async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

describe("playlists route runtime", () => {
    const listPlaylists = getHandler("/", "get");
    const createPlaylist = getHandler("/", "post");
    const getPlaylist = getHandler("/:id", "get");
    const updatePlaylist = getHandler("/:id", "put");
    const hidePlaylist = getHandler("/:id/hide", "post");
    const unhidePlaylist = getHandler("/:id/hide", "delete");
    const deletePlaylist = getHandler("/:id", "delete");
    const addItem = getHandler("/:id/items", "post");
    const removeItem = getHandler("/:id/items/:trackId", "delete");
    const reorderItems = getHandler("/:id/items/reorder", "put");
    const getPending = getHandler("/:id/pending", "get");
    const deletePending = getHandler("/:id/pending/:trackId", "delete");
    const previewPending = getHandler("/:id/pending/:trackId/preview", "get");
    const retryPending = getHandler("/:id/pending/:trackId/retry", "post");
    const reconcilePending = getHandler("/:id/pending/reconcile", "post");

    beforeEach(() => {
        jest.clearAllMocks();

        prisma.hiddenPlaylist.findMany.mockResolvedValue([]);
        prisma.hiddenPlaylist.upsert.mockResolvedValue({});
        prisma.hiddenPlaylist.deleteMany.mockResolvedValue({ count: 1 });

        prisma.playlist.findMany.mockResolvedValue([]);
        prisma.playlist.create.mockResolvedValue({
            id: "pl-new",
            userId: "u1",
            name: "New Playlist",
            isPublic: false,
        });
        prisma.playlist.findUnique.mockResolvedValue({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
            hiddenByUsers: [],
            _count: { items: 0, pendingTracks: 0 },
            items: [],
            pendingTracks: [],
            user: { username: "owner" },
            spotifyPlaylistId: null,
        });
        prisma.playlist.update.mockResolvedValue({
            id: "pl-1",
            userId: "u1",
            name: "Updated Playlist",
            isPublic: true,
        });
        prisma.playlist.delete.mockResolvedValue({
            id: "pl-1",
        });

        prisma.playlistItem.findUnique.mockResolvedValue(null);
        prisma.playlistItem.findFirst.mockResolvedValue(null);
        prisma.playlistItem.findMany.mockResolvedValue([]);
        prisma.playlistItem.create.mockResolvedValue({
            id: "pli-1",
            playlistId: "pl-1",
            trackId: "t-1",
            trackTidalId: null,
            trackYtMusicId: null,
            sort: 6,
            track: {
                id: "t-1",
                title: "Track 1",
                duration: 210,
                album: {
                    title: "Album 1",
                    coverUrl: "native:albums/a1.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist 1",
                        mbid: null,
                    },
                },
            },
            trackTidal: null,
            trackYtMusic: null,
        });
        prisma.playlistItem.delete.mockResolvedValue({});
        prisma.playlistItem.update.mockResolvedValue({});
        prisma.playlistItem.aggregate.mockResolvedValue({
            _max: { sort: 5 },
        });
        prisma.playlistItem.groupBy.mockResolvedValue([]);

        prisma.userSettings.findUnique.mockResolvedValue({
            tidalOAuthJson: "tidal-token",
            ytMusicOAuthJson: "yt-token",
        });
        prisma.systemSettings.findUnique.mockResolvedValue({
            ytMusicEnabled: true,
        });
        prisma.trackMapping.findMany.mockResolvedValue([]);
        prisma.trackMapping.findFirst.mockResolvedValue(null);
        prisma.trackMapping.findUnique.mockResolvedValue(null);
        prisma.track.findUnique.mockResolvedValue({ id: "t-1" });
        prisma.track.findMany.mockResolvedValue([]);
        prisma.trackTidal.findMany.mockResolvedValue([]);
        prisma.trackTidal.findUnique.mockResolvedValue(null);
        prisma.trackYtMusic.findMany.mockResolvedValue([]);
        prisma.trackYtMusic.findUnique.mockResolvedValue(null);

        prisma.playlistPendingTrack.findMany.mockResolvedValue([]);
        prisma.playlistPendingTrack.findUnique.mockResolvedValue(null);
        prisma.playlistPendingTrack.update.mockResolvedValue({});
        prisma.playlistPendingTrack.delete.mockResolvedValue({});

        prisma.downloadJob.create.mockResolvedValue({
            id: "job-1",
            metadata: {},
        });
        prisma.downloadJob.update.mockResolvedValue({});
        prisma.$queryRaw.mockResolvedValue([
            {
                id: "pl-1",
                userId: "u1",
                mixId: null,
            },
        ]);
        prisma.$transaction.mockImplementation(async (operation: unknown) => {
            if (typeof operation === "function") {
                return operation(prisma);
            }
            return Promise.all(operation as Promise<unknown>[]);
        });

        deezerService.getTrackPreview.mockResolvedValue(null);
        spotifyImportService.reconcilePendingTracks.mockResolvedValue({
            tracksAdded: 0,
            playlistsUpdated: 0,
        });
        soulseekService.searchTrack.mockResolvedValue({
            found: false,
            allMatches: [],
        });
        soulseekService.downloadBestMatch.mockResolvedValue({
            success: true,
            filePath: "/tmp/song.mp3",
        });
        trackMappingService.ensureRemoteTrack.mockResolvedValue({
            provider: "tidal",
            id: "tt-1",
            created: false,
        });
        getSystemSettings.mockResolvedValue({
            musicPath: null,
            soulseekUsername: null,
            soulseekPassword: null,
        });
        scanQueue.add.mockResolvedValue({ id: "scan-1" });
    });

    it("requires admin authorization for pending-track retries", () => {
        const middlewares = getRouteLayer(
            "/:id/pending/:trackId/retry",
            "post",
        ).route.stack.map((entry: { handle: unknown }) => entry.handle);

        expect(middlewares).toContain(requireAdmin);
    });

    it("rejects non-admin pending-track retries before downloads or writes", async () => {
        const req = {
            user: { id: "u1", role: "user" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const res = createRes();

        await invokeRouteStack("/:id/pending/:trackId/retry", "post", req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Admin access required" });
        expect(soulseekService.downloadBestMatch).not.toHaveBeenCalled();
        expect(prisma.hiddenPlaylist.upsert).not.toHaveBeenCalled();
        expect(prisma.hiddenPlaylist.deleteMany).not.toHaveBeenCalled();
        expect(prisma.playlist.create).not.toHaveBeenCalled();
        expect(prisma.playlist.update).not.toHaveBeenCalled();
        expect(prisma.playlist.delete).not.toHaveBeenCalled();
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();
        expect(prisma.playlistItem.delete).not.toHaveBeenCalled();
        expect(prisma.playlistItem.update).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.update).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.delete).not.toHaveBeenCalled();
        expect(prisma.downloadJob.create).not.toHaveBeenCalled();
        expect(prisma.downloadJob.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("allows admin pending-track retries through the route stack", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-1",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Album",
            albumMbid: null,
            artistMbid: null,
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        const req = {
            user: { id: "u1", role: "admin" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const res = createRes();

        await invokeRouteStack("/:id/pending/:trackId/retry", "post", req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: false,
            message: "Track not found on Soulseek",
            error: "No matching files found",
        });
        expect(soulseekService.searchTrack).toHaveBeenCalledWith(
            "Artist",
            "Title",
        );
    });

    it("rejects unauthenticated listing", async () => {
        const req = {} as any;
        const res = createRes();

        await listPlaylists(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("lists owned and shared playlists with visibility metadata", async () => {
        prisma.hiddenPlaylist.findMany.mockResolvedValue([
            { playlistId: "pl-2" },
        ]);
        prisma.playlist.findMany.mockResolvedValue([
            {
                id: "pl-1",
                userId: "u1",
                name: "Mine",
                user: { username: "owner" },
                _count: { items: 7 },
                items: [
                    {
                        id: "i-1",
                        sort: 0,
                        track: {
                            album: { coverUrl: "/covers/album.jpg" },
                        },
                    },
                    { id: "i-2", sort: 1, track: null },
                ],
            },
            {
                id: "pl-2",
                userId: "u2",
                name: "Shared",
                user: { username: "friend" },
                _count: { items: 0 },
                items: [],
            },
        ]);
        prisma.playlistItem.groupBy.mockResolvedValueOnce([
            { playlistId: "pl-1", _count: { _all: 2 } },
        ]);

        const req = { user: { id: "u1" }, query: {} } as any;
        const res = createRes();
        await listPlaylists(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "pl-1",
                isOwner: true,
                isHidden: false,
                trackCount: 7,
                unplayableCount: 2,
                items: [
                    {
                        id: "i-1",
                        track: {
                            album: { coverArt: "/covers/album.jpg" },
                        },
                    },
                    { id: "i-2", track: null },
                ],
            }),
            expect.objectContaining({
                id: "pl-2",
                isOwner: false,
                isHidden: true,
                trackCount: 0,
            }),
        ]);
        expect(res.body[0]).not.toHaveProperty("_count");
    });

    it("excludes station rows from bounded playlist pages and cover previews", async () => {
        const req = { user: { id: "u1" }, query: {} } as any;
        const res = createRes();

        await listPlaylists(req, res);

        expect(prisma.playlist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    AND: [
                        { OR: [{ userId: "u1" }, { isPublic: true }] },
                        {
                            OR: [
                                { mixId: null },
                                {
                                    NOT: {
                                        mixId: {
                                            startsWith: "radio-ephemeral:",
                                        },
                                    },
                                },
                            ],
                        },
                    ],
                },
                take: 500,
                skip: 0,
                include: {
                    user: { select: { username: true } },
                    _count: { select: { items: true } },
                    items: {
                        where: {
                            OR: [
                                { trackId: null },
                                { track: { removedAt: null } },
                            ],
                        },
                        select: {
                            id: true,
                            sort: true,
                            track: {
                                select: {
                                    album: { select: { coverUrl: true } },
                                },
                            },
                        },
                        orderBy: { sort: "asc" },
                        take: 12,
                    },
                },
            }),
        );
    });

    it.each([
        ["clamps oversized limits", { limit: "99999" }, 1000, 0],
        ["defaults invalid limits", { limit: "abc" }, 500, 0],
        ["applies offsets", { offset: "5" }, 500, 5],
        ["defaults zero limits", { limit: "0" }, 500, 0],
        ["defaults negative limits", { limit: "-1" }, 500, 0],
    ])("%s", async (_description, query, take, skip) => {
        const req = { user: { id: "u1" }, query } as any;
        const res = createRes();

        await listPlaylists(req, res);

        expect(prisma.playlist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take, skip }),
        );
    });

    it("returns 500 when playlist listing throws", async () => {
        prisma.hiddenPlaylist.findMany.mockRejectedValueOnce(
            new Error("hidden lookup failed"),
        );

        const req = { user: { id: "u1" } } as any;
        const res = createRes();
        await listPlaylists(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get playlists" });
    });

    it("validates and creates playlists", async () => {
        const invalidReq = { user: { id: "u1" }, body: { name: "" } } as any;
        const invalidRes = createRes();
        await createPlaylist(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body.error).toBe("Invalid request");

        const req = { user: { id: "u1" }, body: { name: "Road Trip" } } as any;
        const res = createRes();
        await createPlaylist(req, res);

        expect(prisma.playlist.create).toHaveBeenCalledWith({
            data: {
                userId: "u1",
                name: "Road Trip",
                isPublic: false,
            },
        });
        expect(res.statusCode).toBe(200);
    });

    it("handles unauthenticated and server-error create playlist branches", async () => {
        const unauthReq = { body: { name: "Road Trip" } } as any;
        const unauthRes = createRes();
        await createPlaylist(unauthReq, unauthRes);
        expect(unauthRes.statusCode).toBe(401);
        expect(unauthRes.body).toEqual({ error: "Unauthorized" });

        prisma.playlist.create.mockRejectedValueOnce(
            new Error("create failed"),
        );
        const errReq = {
            user: { id: "u1" },
            body: { name: "Road Trip", isPublic: true },
        } as any;
        const errRes = createRes();
        await createPlaylist(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to create playlist" });
    });

    it("handles GET /:id not-found and access-denied", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            params: { id: "missing" },
        } as any;
        const missingRes = createRes();
        await getPlaylist(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-private",
            userId: "u2",
            isPublic: false,
            hiddenByUsers: [],
            items: [],
            pendingTracks: [],
            user: { username: "owner2" },
        });
        prisma.playlistItem.groupBy.mockResolvedValueOnce([
            { playlistId: "pl-removed", _count: { _all: 1 } },
        ]);
        const deniedReq = {
            user: { id: "u1" },
            params: { id: "pl-private" },
        } as any;
        const deniedRes = createRes();
        await getPlaylist(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);
    });

    it("handles unauthenticated and server-error playlist detail branches", async () => {
        const unauthReq = { params: { id: "pl-1" } } as any;
        const unauthRes = createRes();
        await getPlaylist(unauthReq, unauthRes);
        expect(unauthRes.statusCode).toBe(401);
        expect(unauthRes.body).toEqual({ error: "Unauthorized" });

        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("lookup failed"),
        );
        const errReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const errRes = createRes();
        await getPlaylist(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to get playlist" });
    });

    it("keeps removed playlist tracks visible but flags them unplayable", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-removed",
            userId: "u1",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [],
            _count: { items: 1, pendingTracks: 0 },
            items: [
                {
                    id: "pli-removed",
                    playlistId: "pl-removed",
                    trackId: "track-removed",
                    trackTidalId: null,
                    trackYtMusicId: null,
                    sort: 0,
                    track: {
                        id: "track-removed",
                        title: "Removed Song",
                        duration: 180,
                        trackNo: 1,
                        filePath: "Artist/Removed.flac",
                        displayTitle: null,
                        removedAt: new Date("2026-08-01T00:00:00Z"),
                        album: {
                            id: "album-1",
                            title: "Album",
                            coverUrl: null,
                            artist: { id: "artist-1", name: "Artist" },
                        },
                    },
                    trackTidal: null,
                    trackYtMusic: null,
                },
            ],
            pendingTracks: [],
        });

        const res = createRes();
        await getPlaylist(
            { user: { id: "u1" }, params: { id: "pl-removed" } } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.unplayableCount).toBe(1);
        expect(res.body.items[0].playback).toEqual(
            expect.objectContaining({
                isPlayable: false,
                reason: "track_removed",
            }),
        );
    });

    it("blocks adding a removed local track to a playlist", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            items: [],
        });
        prisma.track.findUnique.mockImplementationOnce(
            async ({ where }: { where: { removedAt?: null } }) =>
                where.removedAt === null ? null : { id: "track-removed" },
        );
        const res = createRes();

        await addItem(
            {
                user: { id: "u1" },
                params: { id: "pl-1" },
                body: { trackId: "track-removed" },
            } as any,
            res,
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();
    });

    it("truncates oversized playlist detail with bounded bulk resolution", async () => {
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: null,
            ytMusicOAuthJson: null,
        });
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-oversized",
            userId: "u-oversized",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [],
            _count: { items: 1000, pendingTracks: 1 },
            items: Array.from({ length: 1000 }, (_, index) => ({
                id: `pli-${index + 1}`,
                playlistId: "pl-oversized",
                trackId: null,
                trackTidalId: `tt-${index + 1}`,
                trackYtMusicId: null,
                sort: index + 1,
                track: null,
                trackTidal: {
                    id: `tt-${index + 1}`,
                    tidalId: 1000 + index,
                    title: `Tidal Song ${index}`,
                    artist: "Tidal Artist",
                    album: "Tidal Album",
                    duration: 180,
                },
                trackYtMusic: null,
            })),
            pendingTracks: [
                {
                    id: "pt-first",
                    sort: 0,
                    spotifyArtist: "Pending Artist",
                    spotifyTitle: "Pending Song",
                    spotifyAlbum: "Pending Album",
                    deezerPreviewUrl: null,
                },
            ],
        });

        const req = {
            user: { id: "u-oversized" },
            params: { id: "pl-oversized" },
        } as any;
        const res = createRes();
        await getPlaylist(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.items).toHaveLength(999);
        expect(res.body.pendingTracks).toHaveLength(1);
        expect(res.body.mergedItems).toHaveLength(1000);
        expect(res.body.totalItemCount).toBe(1001);
        expect(res.body.truncated).toBe(true);
        expect(res.body.items[998].id).toBe("pli-999");
        expect(res.body.items).not.toContainEqual(
            expect.objectContaining({ id: "pli-1000" }),
        );
        expect(res.body.mergedItems[0].id).toBe("pt-first");
        expect(prisma.playlist.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                include: expect.objectContaining({
                    _count: {
                        select: { items: true, pendingTracks: true },
                    },
                    items: expect.objectContaining({ take: 1001 }),
                    pendingTracks: expect.objectContaining({ take: 1001 }),
                }),
            }),
        );
        expect(prisma.trackMapping.findMany).toHaveBeenCalledTimes(1);
        const mappingQuery = prisma.trackMapping.findMany.mock.calls[0][0];
        const tidalIds = mappingQuery.where.OR.find(
            (clause: any) => clause.trackTidalId,
        ).trackTidalId.in;
        expect(tidalIds).toHaveLength(999);
        expect(tidalIds[998]).toBe("tt-999");
        expect(tidalIds).not.toContain("tt-1000");
        expect(prisma.trackMapping.findFirst).not.toHaveBeenCalled();
        expect(prisma.trackMapping.findUnique).not.toHaveBeenCalled();
        expect(prisma.trackTidal.findUnique).not.toHaveBeenCalled();
    });

    it("bulk-resolves cross-provider mappings and misses without per-item queries", async () => {
        const itemCount = 50;
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: null,
            ytMusicOAuthJson: null,
        });
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-bounded-resolution",
            userId: "u-bounded-resolution",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [],
            _count: { items: itemCount, pendingTracks: 0 },
            items: Array.from({ length: itemCount }, (_, index) => ({
                id: `pli-tidal-${index}`,
                playlistId: "pl-bounded-resolution",
                trackId: null,
                trackTidalId: `tt-${index}`,
                trackYtMusicId: null,
                sort: index,
                track: null,
                trackTidal: {
                    id: `tt-${index}`,
                    tidalId: 1000 + index,
                    title: `Tidal Song ${index}`,
                    artist: "Tidal Artist",
                    album: "Tidal Album",
                    duration: 180,
                },
                trackYtMusic: null,
            })),
            pendingTracks: [],
        });
        prisma.trackMapping.findMany.mockImplementation(async (args: any) => {
            if (args?.where?.id?.in) {
                return [
                    {
                        id: "map-tt-0-yt",
                        stale: false,
                        confidence: 0.95,
                        trackId: null,
                        trackTidal: {
                            id: "tt-0",
                            tidalId: 1000,
                            duration: 180,
                        },
                        trackYtMusic: {
                            id: "yt-fallback",
                            videoId: "yt-fallback-video",
                            duration: 180,
                        },
                    },
                ];
            }
            if (args?.select?.id) {
                return [
                    {
                        id: "map-tt-0-yt",
                        trackId: null,
                        trackTidalId: "tt-0",
                        trackYtMusicId: "yt-fallback",
                        source: "import-match",
                        confidence: 0.95,
                        createdAt: new Date("2026-08-01T00:00:00.000Z"),
                    },
                ];
            }
            return [
                {
                    trackId: null,
                    trackTidalId: "tt-0",
                    trackYtMusicId: "yt-fallback",
                },
            ];
        });
        prisma.trackTidal.findMany.mockResolvedValueOnce([
            { id: "tt-0", tidalId: 1000, duration: 180 },
        ]);
        prisma.trackYtMusic.findMany.mockResolvedValueOnce([
            {
                id: "yt-fallback",
                videoId: "yt-fallback-video",
                title: "Fallback Song",
                artist: "Fallback Artist",
                album: "Fallback Album",
                duration: 180,
                thumbnailUrl: "https://yt/fallback.jpg",
            },
        ]);

        const req = {
            user: { id: "u-bounded-resolution" },
            params: { id: "pl-bounded-resolution" },
        } as any;
        const res = createRes();
        await getPlaylist(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.items).toHaveLength(itemCount);
        expect(res.body.items[0].provider.source).toBe("youtube");
        expect(res.body.items[0].playback.isPlayable).toBe(true);
        expect(res.body.items[0].track.youtubeVideoId).toBe(
            "yt-fallback-video",
        );
        expect(
            res.body.items
                .slice(1)
                .every(
                    (item: any) =>
                        item.provider.source === "tidal" &&
                        item.playback.reason === "provider_unavailable",
                ),
        ).toBe(true);
        expect(prisma.trackMapping.findMany).toHaveBeenCalledTimes(3);
        expect(prisma.trackMapping.findFirst).not.toHaveBeenCalled();
        expect(prisma.trackMapping.findUnique).not.toHaveBeenCalled();
        expect(prisma.trackTidal.findUnique).not.toHaveBeenCalled();
    });

    it("formats playlist detail with provider/playability metadata and merged items", async () => {
        prisma.trackTidal.findMany.mockResolvedValueOnce([
            {
                id: "tt-1",
                tidalId: 991,
                duration: 245,
            },
        ]);
        prisma.trackYtMusic.findMany.mockResolvedValueOnce([
            {
                id: "yt-1",
                videoId: "yt-video-7",
                duration: 199,
            },
        ]);
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [{ id: "hidden-1" }],
            _count: { items: 4, pendingTracks: 1 },
            items: [
                {
                    id: "pli-1",
                    playlistId: "pl-1",
                    trackId: "t-1",
                    trackTidalId: null,
                    trackYtMusicId: null,
                    sort: 2,
                    track: {
                        id: "t-1",
                        title: "Song",
                        duration: 180,
                        album: {
                            title: "Album",
                            coverUrl: "native:albums/a1.jpg",
                            artist: {
                                id: "a-1",
                                name: "Artist",
                                mbid: "mbid-a1",
                            },
                        },
                    },
                    trackTidal: null,
                    trackYtMusic: null,
                },
                {
                    id: "pli-2",
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: "tt-1",
                    trackYtMusicId: null,
                    sort: 3,
                    track: null,
                    trackTidal: {
                        id: "tt-1",
                        tidalId: 991,
                        title: "Tidal Song",
                        artist: "Tidal Artist",
                        album: "Tidal Album",
                        duration: 245,
                    },
                    trackYtMusic: null,
                },
                {
                    id: "pli-3",
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-1",
                    sort: 4,
                    track: null,
                    trackTidal: null,
                    trackYtMusic: {
                        id: "yt-1",
                        videoId: "yt-video-7",
                        title: "YT Song",
                        artist: "YT Artist",
                        album: "YT Album",
                        duration: 199,
                        thumbnailUrl: "https://yt/thumb.jpg",
                    },
                },
                {
                    id: "pli-4",
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: null,
                    sort: 5,
                    track: null,
                    trackTidal: null,
                    trackYtMusic: null,
                },
            ],
            pendingTracks: [
                {
                    id: "pt-1",
                    sort: 1,
                    spotifyArtist: "Pending Artist",
                    spotifyTitle: "Pending Song",
                    spotifyAlbum: "Pending Album",
                    deezerPreviewUrl: "https://preview",
                },
            ],
        });

        const req = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const res = createRes();
        await getPlaylist(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.trackCount).toBe(4);
        expect(res.body.pendingCount).toBe(1);
        expect(res.body.totalItemCount).toBe(5);
        expect(res.body.truncated).toBe(false);
        expect(res.body.isOwner).toBe(true);
        expect(res.body.isHidden).toBe(true);
        expect(res.body.items[0].track.album.coverArt).toBe(
            "native:albums/a1.jpg",
        );
        expect(res.body.items[0].provider.source).toBe("local");
        expect(res.body.items[0].playback.isPlayable).toBe(true);

        const tidalItem = res.body.items.find(
            (entry: any) => entry.provider?.source === "tidal",
        );
        expect(tidalItem).toBeDefined();
        expect(tidalItem.playback.isPlayable).toBe(true);
        expect(tidalItem.track.streamSource).toBe("tidal");
        expect(tidalItem.track.tidalTrackId).toBe(991);

        const ytItem = res.body.items.find(
            (entry: any) => entry.provider?.source === "youtube",
        );
        expect(ytItem).toBeDefined();
        expect(ytItem.playback.isPlayable).toBe(true);
        expect(ytItem.track.streamSource).toBe("youtube");
        expect(ytItem.track.youtubeVideoId).toBe("yt-video-7");

        const unknownItem = res.body.items.find(
            (entry: any) => entry.provider?.source === "unknown",
        );
        expect(unknownItem).toBeDefined();
        expect(unknownItem.playback.isPlayable).toBe(false);
        expect(unknownItem.playback.message).toContain(
            "no longer has an attached track source",
        );

        expect(res.body.pendingTracks[0].playback.isPlayable).toBe(false);
        expect(res.body.pendingTracks[0].provider.source).toBe("pending");
        expect(res.body.mergedItems[0].type).toBe("pending");
        expect(res.body.mergedItems[1].type).toBe("track");
    });

    it("resolves remote playlist items to local when a mapping links to a local track", async () => {
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: null,
            ytMusicOAuthJson: null,
        });
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [],
            _count: { items: 1, pendingTracks: 0 },
            items: [
                {
                    id: "pli-yt-1",
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-1",
                    sort: 1,
                    track: null,
                    trackTidal: null,
                    trackYtMusic: {
                        id: "yt-1",
                        videoId: "yt-video-1",
                        title: "Mapped Song",
                        artist: "Mapped Artist",
                        album: "Mapped Album",
                        duration: 201,
                        thumbnailUrl: "https://yt/thumb.jpg",
                    },
                },
            ],
            pendingTracks: [],
        });
        prisma.trackMapping.findMany
            .mockResolvedValueOnce([
                {
                    id: "map-yt-local",
                    trackId: "t-local-1",
                    trackTidalId: null,
                    trackYtMusicId: "yt-1",
                    source: "import-match",
                    confidence: 0.96,
                    createdAt: new Date("2026-03-01T00:00:00.000Z"),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "map-yt-local",
                    stale: false,
                    confidence: 0.96,
                    trackId: "t-local-1",
                    trackTidal: null,
                    trackYtMusic: {
                        id: "yt-1",
                        videoId: "yt-video-1",
                        duration: 201,
                    },
                },
            ]);
        prisma.trackYtMusic.findMany.mockResolvedValueOnce([
            {
                id: "yt-1",
                videoId: "yt-video-1",
                duration: 201,
            },
        ]);
        prisma.track.findMany.mockResolvedValueOnce([
            {
                id: "t-local-1",
                title: "Mapped Song",
                duration: 201,
                filePath: "/music/mapped-song.flac",
                displayTitle: null,
                album: {
                    id: "alb-1",
                    title: "Mapped Album",
                    coverUrl: "native:albums/alb-1.jpg",
                    artist: {
                        id: "art-1",
                        name: "Mapped Artist",
                        mbid: null,
                    },
                },
            },
        ]);

        const req = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const res = createRes();
        await getPlaylist(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.items[0].provider.source).toBe("local");
        expect(res.body.items[0].playback.isPlayable).toBe(true);
        expect(res.body.items[0].track.source).toBe("local");
        expect(res.body.items[0].track.filePath).toBe(
            "/music/mapped-song.flac",
        );
    });

    it("prefers a local-linked mapping when multiple mappings share the same remote token", async () => {
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: null,
            ytMusicOAuthJson: null,
        });
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u-conflict",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [],
            _count: { items: 1, pendingTracks: 0 },
            items: [
                {
                    id: "pli-yt-conflict",
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-1",
                    sort: 1,
                    track: null,
                    trackTidal: null,
                    trackYtMusic: {
                        id: "yt-1",
                        videoId: "yt-video-1",
                        title: "Conflict Song",
                        artist: "Conflict Artist",
                        album: "Conflict Album",
                        duration: 200,
                        thumbnailUrl: "https://yt/conflict.jpg",
                    },
                },
            ],
            pendingTracks: [],
        });
        prisma.trackMapping.findMany
            .mockResolvedValueOnce([
                {
                    id: "map-remote-manual",
                    trackId: null,
                    trackTidalId: "tt-remote-only",
                    trackYtMusicId: "yt-1",
                    source: "manual",
                    confidence: 1,
                    createdAt: new Date("2026-03-04T00:00:00.000Z"),
                },
                {
                    id: "map-local-import",
                    trackId: "t-local-conflict",
                    trackTidalId: null,
                    trackYtMusicId: "yt-1",
                    source: "import-match",
                    confidence: 0.8,
                    createdAt: new Date("2026-03-01T00:00:00.000Z"),
                },
            ])
            .mockImplementationOnce(async (args: any) => {
                const ids: string[] = args?.where?.id?.in ?? [];
                if (ids.includes("map-remote-manual")) {
                    return [
                        {
                            id: "map-remote-manual",
                            stale: false,
                            confidence: 1,
                            trackId: null,
                            trackTidal: {
                                id: "tt-remote-only",
                                tidalId: 88888,
                                duration: 200,
                            },
                            trackYtMusic: {
                                id: "yt-1",
                                videoId: "yt-video-1",
                                duration: 200,
                            },
                        },
                    ];
                }
                return [
                    {
                        id: "map-local-import",
                        stale: false,
                        confidence: 0.8,
                        trackId: "t-local-conflict",
                        trackTidal: null,
                        trackYtMusic: {
                            id: "yt-1",
                            videoId: "yt-video-1",
                            duration: 200,
                        },
                    },
                ];
            });
        prisma.trackYtMusic.findMany.mockResolvedValueOnce([
            {
                id: "yt-1",
                videoId: "yt-video-1",
                duration: 200,
            },
        ]);
        prisma.track.findMany.mockResolvedValueOnce([
            {
                id: "t-local-conflict",
                title: "Conflict Song",
                duration: 200,
                filePath: "/music/conflict-song.flac",
                displayTitle: null,
                album: {
                    id: "alb-conflict",
                    title: "Conflict Album",
                    coverUrl: "native:albums/conflict.jpg",
                    artist: {
                        id: "art-conflict",
                        name: "Conflict Artist",
                        mbid: null,
                    },
                },
            },
        ]);

        const req = {
            user: { id: "u-conflict" },
            params: { id: "pl-1" },
        } as any;
        const res = createRes();
        await getPlaylist(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.items[0].provider.source).toBe("local");
        expect(res.body.items[0].playback.isPlayable).toBe(true);
        expect(res.body.items[0].track.source).toBe("local");
    });

    it("marks provider-only playlist items unplayable when user lacks provider connectivity", async () => {
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: null,
            ytMusicOAuthJson: null,
        });
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u-no-provider",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [],
            _count: { items: 1, pendingTracks: 0 },
            items: [
                {
                    id: "pli-tidal-1",
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: "tt-1",
                    trackYtMusicId: null,
                    sort: 1,
                    track: null,
                    trackTidal: {
                        id: "tt-1",
                        tidalId: 991,
                        title: "Tidal Song",
                        artist: "Tidal Artist",
                        album: "Tidal Album",
                        duration: 245,
                    },
                    trackYtMusic: null,
                },
            ],
            pendingTracks: [],
        });
        prisma.trackTidal.findMany.mockResolvedValueOnce([
            {
                id: "tt-1",
                tidalId: 991,
                duration: 245,
            },
        ]);

        const req = {
            user: { id: "u-no-provider" },
            params: { id: "pl-1" },
        } as any;
        const res = createRes();
        await getPlaylist(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.items[0].provider.source).toBe("tidal");
        expect(res.body.items[0].playback.isPlayable).toBe(false);
        expect(res.body.items[0].playback.reason).toBe("provider_unavailable");
        expect(res.body.items[0].playback.message).toContain("not connected");
    });

    it("keeps youtube playlist items playable without user youtube oauth token", async () => {
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: null,
            ytMusicOAuthJson: null,
        });
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-yt-public",
            userId: "u-yt-public",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [],
            _count: { items: 1, pendingTracks: 0 },
            items: [
                {
                    id: "pli-yt-1",
                    playlistId: "pl-yt-public",
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-1",
                    sort: 1,
                    track: null,
                    trackTidal: null,
                    trackYtMusic: {
                        id: "yt-1",
                        videoId: "yt-video-1",
                        title: "YouTube Song",
                        artist: "YouTube Artist",
                        album: "YouTube Album",
                        duration: 219,
                        thumbnailUrl: "https://yt/thumb.jpg",
                    },
                },
            ],
            pendingTracks: [],
        });
        prisma.trackYtMusic.findMany.mockResolvedValueOnce([
            {
                id: "yt-1",
                videoId: "yt-video-1",
                duration: 219,
            },
        ]);

        const req = {
            user: { id: "u-yt-public" },
            params: { id: "pl-yt-public" },
        } as any;
        const res = createRes();
        await getPlaylist(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.items[0].provider.source).toBe("youtube");
        expect(res.body.items[0].playback.isPlayable).toBe(true);
        expect(res.body.items[0].track.streamSource).toBe("youtube");
        expect(res.body.items[0].track.youtubeVideoId).toBe("yt-video-1");
    });

    it("validates and updates playlists with ownership checks", async () => {
        const invalidReq = {
            user: { id: "u1" },
            body: { name: "" },
            params: { id: "pl-1" },
        } as any;
        const invalidRes = createRes();
        await updatePlaylist(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            body: { name: "New Name", isPublic: true },
            params: { id: "pl-1" },
        } as any;
        const missingRes = createRes();
        await updatePlaylist(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
        });
        const deniedReq = {
            user: { id: "u1" },
            body: { name: "New Name", isPublic: true },
            params: { id: "pl-1" },
        } as any;
        const deniedRes = createRes();
        await updatePlaylist(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        const okReq = {
            user: { id: "u1" },
            body: { name: "New Name", isPublic: true },
            params: { id: "pl-1" },
        } as any;
        const okRes = createRes();
        await updatePlaylist(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
    });

    it("handles unauthenticated and server-error update branches", async () => {
        const unauthReq = {
            body: { name: "New Name", isPublic: true },
            params: { id: "pl-1" },
        } as any;
        const unauthRes = createRes();
        await updatePlaylist(unauthReq, unauthRes);
        expect(unauthRes.statusCode).toBe(401);
        expect(unauthRes.body).toEqual({ error: "Unauthorized" });

        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("update failed"),
        );
        const errReq = {
            user: { id: "u1" },
            body: { name: "New Name", isPublic: true },
            params: { id: "pl-1" },
        } as any;
        const errRes = createRes();
        await updatePlaylist(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to update playlist" });
    });

    it("hides and unhides playlists", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
        } as any;
        const missingRes = createRes();
        await hidePlaylist(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-2",
            userId: "u2",
            isPublic: false,
        });
        const deniedReq = { user: { id: "u1" }, params: { id: "pl-2" } } as any;
        const deniedRes = createRes();
        await hidePlaylist(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-2",
            userId: "u2",
            isPublic: true,
        });
        const okReq = { user: { id: "u1" }, params: { id: "pl-2" } } as any;
        const okRes = createRes();
        await hidePlaylist(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(prisma.hiddenPlaylist.upsert).toHaveBeenCalled();

        const unhideReq = { user: { id: "u1" }, params: { id: "pl-2" } } as any;
        const unhideRes = createRes();
        await unhidePlaylist(unhideReq, unhideRes);
        expect(unhideRes.statusCode).toBe(200);
        expect(prisma.hiddenPlaylist.deleteMany).toHaveBeenCalledWith({
            where: { userId: "u1", playlistId: "pl-2" },
        });
    });

    it("handles unauthenticated and server-error hide/unhide branches", async () => {
        const hideUnauthReq = { params: { id: "pl-1" } } as any;
        const hideUnauthRes = createRes();
        await hidePlaylist(hideUnauthReq, hideUnauthRes);
        expect(hideUnauthRes.statusCode).toBe(401);
        expect(hideUnauthRes.body).toEqual({ error: "Unauthorized" });

        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("hide failed"),
        );
        const hideErrReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
        } as any;
        const hideErrRes = createRes();
        await hidePlaylist(hideErrReq, hideErrRes);
        expect(hideErrRes.statusCode).toBe(500);
        expect(hideErrRes.body).toEqual({ error: "Failed to hide playlist" });

        const unhideUnauthReq = { params: { id: "pl-1" } } as any;
        const unhideUnauthRes = createRes();
        await unhidePlaylist(unhideUnauthReq, unhideUnauthRes);
        expect(unhideUnauthRes.statusCode).toBe(401);
        expect(unhideUnauthRes.body).toEqual({ error: "Unauthorized" });

        prisma.hiddenPlaylist.deleteMany.mockRejectedValueOnce(
            new Error("unhide failed"),
        );
        const unhideErrReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
        } as any;
        const unhideErrRes = createRes();
        await unhidePlaylist(unhideErrReq, unhideErrRes);
        expect(unhideErrRes.statusCode).toBe(500);
        expect(unhideErrRes.body).toEqual({
            error: "Failed to unhide playlist",
        });
    });

    it("deletes playlists with ownership checks", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
        } as any;
        const missingRes = createRes();
        await deletePlaylist(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
        });
        const deniedReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const deniedRes = createRes();
        await deletePlaylist(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        const okReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const okRes = createRes();
        await deletePlaylist(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(prisma.playlist.delete).toHaveBeenCalled();
    });

    it("handles unauthenticated and server-error delete playlist branches", async () => {
        const unauthReq = { params: { id: "pl-1" } } as any;
        const unauthRes = createRes();
        await deletePlaylist(unauthReq, unauthRes);
        expect(unauthRes.statusCode).toBe(401);
        expect(unauthRes.body).toEqual({ error: "Unauthorized" });

        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("delete failed"),
        );
        const errReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const errRes = createRes();
        await deletePlaylist(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to delete playlist" });
    });

    it("adds tracks with validation, duplicate checks, and create flow", async () => {
        const invalidReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {},
        } as any;
        const invalidRes = createRes();
        await addItem(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingPlaylistReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-1" },
        } as any;
        const missingPlaylistRes = createRes();
        await addItem(missingPlaylistReq, missingPlaylistRes);
        expect(missingPlaylistRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            items: [],
        });
        const deniedReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-1" },
        } as any;
        const deniedRes = createRes();
        await addItem(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            items: [{ sort: 5 }],
        });
        prisma.track.findUnique.mockResolvedValueOnce(null);
        const missingTrackReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-missing" },
        } as any;
        const missingTrackRes = createRes();
        await addItem(missingTrackReq, missingTrackRes);
        expect(missingTrackRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            items: [{ sort: 5 }],
        });
        prisma.track.findUnique.mockResolvedValueOnce({ id: "t-1" });
        prisma.playlistItem.findFirst.mockResolvedValueOnce({
            id: "pli-existing",
            playlistId: "pl-1",
            trackId: "t-1",
            trackTidalId: null,
            trackYtMusicId: null,
            sort: 2,
            track: {
                id: "t-1",
                title: "Track 1",
                duration: 210,
                album: {
                    title: "Album 1",
                    coverUrl: "native:albums/a1.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist 1",
                        mbid: null,
                    },
                },
            },
            trackTidal: null,
            trackYtMusic: null,
        });
        const duplicateReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-1" },
        } as any;
        const duplicateRes = createRes();
        await addItem(duplicateReq, duplicateRes);
        expect(duplicateRes.statusCode).toBe(200);
        expect(duplicateRes.body.duplicated).toBe(true);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            items: [{ sort: 5 }],
        });
        prisma.track.findUnique.mockResolvedValueOnce({ id: "t-1" });
        prisma.playlistItem.findFirst.mockResolvedValueOnce(null);
        prisma.playlistItem.create.mockResolvedValueOnce({
            id: "pli-1",
            playlistId: "pl-1",
            trackId: "t-1",
            trackTidalId: null,
            trackYtMusicId: null,
            sort: 6,
            track: {
                id: "t-1",
                title: "Track 1",
                duration: 210,
                album: {
                    title: "Album 1",
                    coverUrl: "native:albums/a1.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist 1",
                        mbid: null,
                    },
                },
            },
            trackTidal: null,
            trackYtMusic: null,
        });
        const createReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-1" },
        } as any;
        const createResValue = createRes();
        await addItem(createReq, createResValue);
        expect(createResValue.statusCode).toBe(200);
        expect(prisma.playlistItem.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    playlistId: "pl-1",
                    trackId: "t-1",
                    sort: 6,
                }),
            }),
        );
        expect(createResValue.body.provider.source).toBe("local");
        expect(createResValue.body.playback.isPlayable).toBe(true);
        expect(createResValue.body.track.album.coverArt).toBe(
            "native:albums/a1.jpg",
        );
    });

    it("handles add-track zod and generic error catches", async () => {
        prisma.playlist.findUnique.mockRejectedValueOnce(new z.ZodError([]));
        const zodReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-1" },
        } as any;
        const zodRes = createRes();
        await addItem(zodReq, zodRes);
        expect(zodRes.statusCode).toBe(400);
        expect(zodRes.body.error).toBe("Invalid request");

        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("add failed"),
        );
        const errReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-1" },
        } as any;
        const errRes = createRes();
        await addItem(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({
            error: "Failed to add track to playlist",
        });
    });

    it("requires exactly one item reference key in add-item payloads", async () => {
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                trackId: "t-1",
                tidalTrackId: 991,
                title: "Tidal Song",
                artist: "Tidal Artist",
                album: "Tidal Album",
                duration: 245,
            },
        } as any;
        const res = createRes();

        await addItem(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe("Invalid request");
    });

    it("materializes remote tidal items, handles duplicate detection, and normalizes responses", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            items: [{ sort: 5 }],
        });
        trackMappingService.ensureRemoteTrack.mockResolvedValueOnce({
            provider: "tidal",
            id: "tt-remote-dup",
            created: false,
        });
        prisma.playlistItem.findFirst.mockResolvedValueOnce({
            id: "pli-remote-dup",
            playlistId: "pl-1",
            trackId: null,
            trackTidalId: "tt-remote-dup",
            trackYtMusicId: null,
            sort: 3,
            track: null,
            trackTidal: {
                id: "tt-remote-dup",
                tidalId: 991,
                title: "Tidal Song",
                artist: "Tidal Artist",
                album: "Tidal Album",
                duration: 245,
            },
            trackYtMusic: null,
        });

        const duplicateReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                tidalTrackId: 991,
                title: "Tidal Song",
                artist: "Tidal Artist",
                album: "Tidal Album",
                duration: 245,
            },
        } as any;
        const duplicateRes = createRes();
        await addItem(duplicateReq, duplicateRes);

        expect(trackMappingService.ensureRemoteTrack).toHaveBeenCalledWith({
            provider: "tidal",
            tidalId: 991,
            videoId: undefined,
            title: "Tidal Song",
            artist: "Tidal Artist",
            album: "Tidal Album",
            duration: 245,
            isrc: undefined,
            quality: undefined,
            explicit: undefined,
            thumbnailUrl: undefined,
        });
        expect(duplicateRes.statusCode).toBe(200);
        expect(duplicateRes.body.duplicated).toBe(true);
        expect(duplicateRes.body.item.provider.source).toBe("tidal");
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            items: [{ sort: 5 }],
        });
        trackMappingService.ensureRemoteTrack.mockResolvedValueOnce({
            provider: "tidal",
            id: "tt-remote-new",
            created: true,
        });
        prisma.playlistItem.findFirst.mockResolvedValueOnce(null);
        prisma.playlistItem.create.mockResolvedValueOnce({
            id: "pli-remote-new",
            playlistId: "pl-1",
            trackId: null,
            trackTidalId: "tt-remote-new",
            trackYtMusicId: null,
            sort: 6,
            track: null,
            trackTidal: {
                id: "tt-remote-new",
                tidalId: 992,
                title: "Tidal Song 2",
                artist: "Tidal Artist",
                album: "Tidal Album",
                duration: 244,
            },
            trackYtMusic: null,
        });

        const createReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                tidalTrackId: 992,
                title: "Tidal Song 2",
                artist: "Tidal Artist",
                album: "Tidal Album",
                duration: 244,
            },
        } as any;
        const createResValue = createRes();
        await addItem(createReq, createResValue);

        expect(createResValue.statusCode).toBe(200);
        expect(createResValue.body.provider.source).toBe("tidal");
        expect(createResValue.body.track.streamSource).toBe("tidal");
        expect(prisma.playlistItem.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: "tt-remote-new",
                    trackYtMusicId: null,
                    sort: 6,
                }),
            }),
        );
    });

    it("materializes remote youtube items and normalizes add responses", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            items: [{ sort: 2 }],
        });
        trackMappingService.ensureRemoteTrack.mockResolvedValueOnce({
            provider: "youtube",
            id: "yt-row-1",
            created: true,
        });
        prisma.playlistItem.findFirst.mockResolvedValueOnce(null);
        prisma.playlistItem.aggregate.mockResolvedValueOnce({
            _max: { sort: 2 },
        });
        prisma.playlistItem.create.mockResolvedValueOnce({
            id: "pli-yt-1",
            playlistId: "pl-1",
            trackId: null,
            trackTidalId: null,
            trackYtMusicId: "yt-row-1",
            sort: 3,
            track: null,
            trackTidal: null,
            trackYtMusic: {
                id: "yt-row-1",
                videoId: "yt-video-7",
                title: "YT Song",
                artist: "YT Artist",
                album: "YT Album",
                duration: 199,
                thumbnailUrl: "https://yt/thumb.jpg",
            },
        });

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                youtubeVideoId: "yt-video-7",
                title: "YT Song",
                artist: "YT Artist",
                album: "YT Album",
                duration: 199,
                thumbnailUrl: "https://yt/thumb.jpg",
            },
        } as any;
        const res = createRes();
        await addItem(req, res);

        expect(trackMappingService.ensureRemoteTrack).toHaveBeenCalledWith({
            provider: "youtube",
            tidalId: undefined,
            videoId: "yt-video-7",
            title: "YT Song",
            artist: "YT Artist",
            album: "YT Album",
            duration: 199,
            isrc: undefined,
            quality: undefined,
            explicit: undefined,
            thumbnailUrl: "https://yt/thumb.jpg",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.provider.source).toBe("youtube");
        expect(res.body.track.youtubeVideoId).toBe("yt-video-7");
        expect(prisma.playlistItem.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    playlistId: "pl-1",
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-row-1",
                    sort: 3,
                }),
            }),
        );
    });

    it("removes and reorders playlist items", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const removeMissingReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "t-1" },
        } as any;
        const removeMissingRes = createRes();
        await removeItem(removeMissingReq, removeMissingRes);
        expect(removeMissingRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
        });
        const removeDeniedReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "t-1" },
        } as any;
        const removeDeniedRes = createRes();
        await removeItem(removeDeniedReq, removeDeniedRes);
        expect(removeDeniedRes.statusCode).toBe(403);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "pli-local-remove",
                playlistId: "pl-1",
                trackId: "t-1",
            });
        const removeOkReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "t-1" },
        } as any;
        const removeOkRes = createRes();
        await removeItem(removeOkReq, removeOkRes);
        expect(removeOkRes.statusCode).toBe(200);
        expect(prisma.playlistItem.delete).toHaveBeenCalled();

        const reorderInvalidReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: "not-array" },
        } as any;
        const reorderInvalidRes = createRes();
        await reorderItems(reorderInvalidReq, reorderInvalidRes);
        expect(reorderInvalidRes.statusCode).toBe(400);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce([
            { trackId: "t-2" },
            { trackId: "t-1" },
        ]);
        const reorderReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: ["t-2", "t-1"] },
        } as any;
        const reorderRes = createRes();
        await reorderItems(reorderReq, reorderRes);
        expect(reorderRes.statusCode).toBe(200);
        expect(prisma.playlistItem.update).toHaveBeenCalledTimes(2);
        expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("locks the owned playlist before add duplicate, sort, and item writes", async () => {
        const res = createRes();

        await addItem(
            {
                user: { id: "u1" },
                params: { id: "pl-1" },
                body: { trackId: "t-1" },
            } as any,
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(typeof prisma.$transaction.mock.calls[0][0]).toBe("function");
        expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.playlistItem.findFirst.mock.invocationCallOrder[0],
        );
        expect(
            prisma.playlistItem.findFirst.mock.invocationCallOrder[0],
        ).toBeLessThan(
            prisma.playlistItem.aggregate.mock.invocationCallOrder[0],
        );
        expect(
            prisma.playlistItem.aggregate.mock.invocationCallOrder[0],
        ).toBeLessThan(prisma.playlistItem.create.mock.invocationCallOrder[0]);
    });

    it("locks the owned playlist before ordinary remove and reorder writes", async () => {
        prisma.playlistItem.findFirst.mockResolvedValueOnce({
            id: "pli-1",
        });
        const removeRes = createRes();

        await removeItem(
            {
                user: { id: "u1" },
                params: { id: "pl-1", trackId: "pli-1" },
            } as any,
            removeRes,
        );

        expect(removeRes.statusCode).toBe(200);
        expect(prisma.$queryRaw).toHaveBeenCalled();
        expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.playlistItem.delete.mock.invocationCallOrder[0],
        );

        jest.clearAllMocks();
        prisma.playlist.findUnique.mockResolvedValue({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValue([
            { id: "pli-2", trackId: "t-2" },
            { id: "pli-1", trackId: "t-1" },
        ]);
        prisma.playlistItem.update.mockResolvedValue({});
        prisma.playlist.update.mockResolvedValue({});
        prisma.$queryRaw.mockResolvedValue([
            { id: "pl-1", userId: "u1", mixId: null },
        ]);
        prisma.$transaction.mockImplementation(async (operation: unknown) => {
            if (typeof operation !== "function") {
                throw new Error("Expected an interactive transaction");
            }
            return operation(prisma);
        });
        const reorderRes = createRes();

        await reorderItems(
            {
                user: { id: "u1" },
                params: { id: "pl-1" },
                body: { itemIds: ["pli-2", "pli-1"] },
            } as any,
            reorderRes,
        );

        expect(reorderRes.statusCode).toBe(200);
        expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.playlistItem.update.mock.invocationCallOrder[0],
        );
    });

    it("removes by playlist-item id first, then falls back to local track id, and returns 404 when missing", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findFirst.mockResolvedValueOnce({
            id: "pli-remote-1",
            playlistId: "pl-1",
            trackId: null,
        });

        const byItemIdReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pli-remote-1" },
        } as any;
        const byItemIdRes = createRes();
        await removeItem(byItemIdReq, byItemIdRes);

        expect(byItemIdRes.statusCode).toBe(200);
        expect(prisma.playlistItem.delete).toHaveBeenNthCalledWith(1, {
            where: { id: "pli-remote-1" },
        });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "pli-local-2",
                playlistId: "pl-1",
                trackId: "t-1",
            });

        const byTrackIdReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "t-1" },
        } as any;
        const byTrackIdRes = createRes();
        await removeItem(byTrackIdReq, byTrackIdRes);

        expect(byTrackIdRes.statusCode).toBe(200);
        expect(prisma.playlistItem.delete).toHaveBeenNthCalledWith(2, {
            where: { id: "pli-local-2" },
        });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        const missingReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "missing" },
        } as any;
        const missingRes = createRes();
        await removeItem(missingReq, missingRes);

        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Playlist item not found" });
    });

    it("prefers itemIds over trackIds for reorder payloads", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce([
            { id: "pli-2" },
            { id: "pli-1" },
        ]);

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                itemIds: ["pli-2", "pli-1"],
                trackIds: ["t-99", "t-98"],
            },
        } as any;
        const res = createRes();
        await reorderItems(req, res);

        expect(res.statusCode).toBe(200);
        expect(prisma.playlistItem.update).toHaveBeenNthCalledWith(1, {
            where: { id: "pli-2" },
            data: { sort: 0 },
        });
        expect(prisma.playlistItem.update).toHaveBeenNthCalledWith(2, {
            where: { id: "pli-1" },
            data: { sort: 1 },
        });
    });

    it("returns 404 when reorder itemIds are outside the playlist scope", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce([{ id: "pli-1" }]);

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                itemIds: ["pli-2", "pli-1"],
            },
        } as any;
        const res = createRes();
        await reorderItems(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "One or more playlist items were not found in this playlist",
        });
        expect(prisma.playlistItem.update).not.toHaveBeenCalled();
    });

    it("returns 404 when reorder trackIds include entries not found in the playlist", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce([
            { trackId: "t-1" },
        ]);

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                trackIds: ["t-1", "tidal:991"],
            },
        } as any;
        const res = createRes();
        await reorderItems(req, res);

        expect(prisma.playlistItem.findMany).toHaveBeenCalledWith({
            where: { playlistId: "pl-1" },
            select: { id: true, trackId: true },
            take: 1001,
        });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "One or more tracks were not found in this playlist",
        });
        expect(prisma.playlistItem.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects duplicate reorder identifiers before database work", async () => {
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: ["t-1", "t-1"] },
        } as any;
        const res = createRes();

        await reorderItems(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Reorder identifiers must not contain duplicates",
        });
        expect(prisma.playlist.findUnique).not.toHaveBeenCalled();
        expect(prisma.playlistItem.findMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects oversized reorder payloads before database work", async () => {
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: {
                itemIds: Array.from(
                    { length: 1001 },
                    (_, index) => `pli-${index}`,
                ),
            },
        } as any;
        const res = createRes();

        await reorderItems(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "A playlist reorder cannot exceed 1000 items",
        });
        expect(prisma.playlist.findUnique).not.toHaveBeenCalled();
        expect(prisma.playlistItem.findMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects invalid reorder identifiers before database work", async () => {
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { itemIds: ["pli-1", 42] },
        } as any;
        const res = createRes();

        await reorderItems(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Reorder identifiers must be non-empty strings",
        });
        expect(prisma.playlist.findUnique).not.toHaveBeenCalled();
        expect(prisma.playlistItem.findMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("requires reorder identifiers to be an exact playlist permutation", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce([
            { id: "pli-1", trackId: "t-1" },
            { id: "pli-2", trackId: "t-2" },
        ]);
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { itemIds: ["pli-1"] },
        } as any;
        const res = createRes();

        await reorderItems(req, res);

        expect(prisma.playlistItem.findMany).toHaveBeenCalledWith({
            where: { playlistId: "pl-1" },
            select: { id: true, trackId: true },
            take: 1001,
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Reorder identifiers must include every playlist item exactly once",
        });
        expect(prisma.playlistItem.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects reordering playlists larger than the bounded transaction limit", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce(
            Array.from({ length: 1001 }, (_, index) => ({
                id: `pli-${index}`,
                trackId: `t-${index}`,
            })),
        );
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { itemIds: [] },
        } as any;
        const res = createRes();

        await reorderItems(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Playlist exceeds the maximum reorder size of 1000 items",
        });
        expect(prisma.playlistItem.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects legacy trackIds when they omit remote playlist items", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce([
            { id: "pli-local", trackId: "t-1" },
            { id: "pli-remote", trackId: null },
        ]);
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: ["t-1"] },
        } as any;
        const res = createRes();

        await reorderItems(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Reorder identifiers must include every playlist item exactly once",
        });
        expect(prisma.playlistItem.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("handles remove and reorder server-error/missing/denied branches", async () => {
        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("remove failed"),
        );
        const removeErrReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "t-1" },
        } as any;
        const removeErrRes = createRes();
        await removeItem(removeErrReq, removeErrRes);
        expect(removeErrRes.statusCode).toBe(500);
        expect(removeErrRes.body).toEqual({
            error: "Failed to remove track from playlist",
        });

        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const reorderMissingReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: ["t-1"] },
        } as any;
        const reorderMissingRes = createRes();
        await reorderItems(reorderMissingReq, reorderMissingRes);
        expect(reorderMissingRes.statusCode).toBe(404);
        expect(reorderMissingRes.body).toEqual({ error: "Playlist not found" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
        });
        const reorderDeniedReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: ["t-1"] },
        } as any;
        const reorderDeniedRes = createRes();
        await reorderItems(reorderDeniedReq, reorderDeniedRes);
        expect(reorderDeniedRes.statusCode).toBe(403);
        expect(reorderDeniedRes.body).toEqual({ error: "Access denied" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistItem.findMany.mockResolvedValueOnce([
            { trackId: "t-2" },
            { trackId: "t-1" },
        ]);
        prisma.$transaction.mockRejectedValueOnce(new Error("reorder failed"));
        const reorderErrReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: ["t-2", "t-1"] },
        } as any;
        const reorderErrRes = createRes();
        await reorderItems(reorderErrReq, reorderErrRes);
        expect(reorderErrRes.statusCode).toBe(500);
        expect(reorderErrRes.body).toEqual({
            error: "Failed to reorder playlist",
        });
    });

    it("reads pending tracks with ownership checks and mapped payload", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
        } as any;
        const missingRes = createRes();
        await getPending(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
            spotifyPlaylistId: "sp-1",
        });
        const deniedReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const deniedRes = createRes();
        await getPending(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
            spotifyPlaylistId: "sp-1",
        });
        prisma.playlistPendingTrack.findMany.mockResolvedValueOnce([
            {
                id: "pt-1",
                spotifyArtist: "A",
                spotifyTitle: "T",
                spotifyAlbum: "Album",
                sort: 4,
                deezerPreviewUrl: "https://preview",
            },
        ]);
        const okReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const okRes = createRes();
        await getPending(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            count: 1,
            tracks: [
                {
                    id: "pt-1",
                    artist: "A",
                    title: "T",
                    album: "Album",
                    position: 4,
                    previewUrl: "https://preview",
                },
            ],
            spotifyPlaylistId: "sp-1",
        });
    });

    it("handles pending-track listing server errors", async () => {
        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("pending failed"),
        );
        const req = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const res = createRes();
        await getPending(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get pending tracks" });
    });

    it("deletes pending tracks and maps P2025 to 404", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.delete.mockRejectedValueOnce({
            code: "P2025",
        });

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const res = createRes();
        await deletePending(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Pending track not found" });
    });

    it("does not delete a pending track belonging to another playlist", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-owned",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.delete.mockRejectedValueOnce({
            code: "P2025",
        });
        const req = {
            user: { id: "u1" },
            params: { id: "pl-owned", trackId: "pt-victim" },
        } as any;
        const res = createRes();

        await deletePending(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Pending track not found" });
        expect(prisma.playlistPendingTrack.delete).toHaveBeenCalledWith({
            where: { id: "pt-victim", playlistId: "pl-owned" },
        });
    });

    it("handles pending-track delete missing/denied/success/generic-error branches", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const missingRes = createRes();
        await deletePending(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Playlist not found" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
        });
        const deniedReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const deniedRes = createRes();
        await deletePending(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);
        expect(deniedRes.body).toEqual({ error: "Access denied" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        const okReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const okRes = createRes();
        await deletePending(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({ message: "Pending track removed" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.delete.mockRejectedValueOnce(
            new Error("delete failed"),
        );
        const errReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const errRes = createRes();
        await deletePending(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({
            error: "Failed to delete pending track",
        });
    });

    it("refreshes pending preview URLs with no-preview and success branches", async () => {
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const missingRes = createRes();
        await previewPending(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-1",
            spotifyArtist: "A",
            spotifyTitle: "T",
        });
        deezerService.getTrackPreview.mockResolvedValueOnce(null);
        const noneReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const noneRes = createRes();
        await previewPending(noneReq, noneRes);
        expect(noneRes.statusCode).toBe(404);
        expect(noneRes.body.error).toBe("No preview available on Deezer");

        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-1",
            spotifyArtist: "A",
            spotifyTitle: "T",
        });
        deezerService.getTrackPreview.mockResolvedValueOnce(
            "https://preview/new.mp3",
        );
        const okReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const okRes = createRes();
        await previewPending(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({ previewUrl: "https://preview/new.mp3" });
        expect(prisma.playlistPendingTrack.update).toHaveBeenCalledWith({
            where: { id: "pt-1", playlistId: "pl-1" },
            data: { deezerPreviewUrl: "https://preview/new.mp3" },
        });
    });

    it("does not preview a pending track through a different owned playlist", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-owned",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce(null);
        const req = {
            user: { id: "u1" },
            params: { id: "pl-owned", trackId: "pt-victim" },
        } as any;
        const res = createRes();

        await previewPending(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Pending track not found" });
        expect(prisma.playlistPendingTrack.findUnique).toHaveBeenCalledWith({
            where: { id: "pt-victim", playlistId: "pl-owned" },
        });
        expect(deezerService.getTrackPreview).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.update).not.toHaveBeenCalled();
    });

    it("returns 404 when a pending preview disappears before its scoped update", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-1",
            spotifyArtist: "A",
            spotifyTitle: "T",
        });
        deezerService.getTrackPreview.mockResolvedValueOnce(
            "https://preview/new.mp3",
        );
        prisma.playlistPendingTrack.update.mockRejectedValueOnce({
            code: "P2025",
        });
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const res = createRes();

        await previewPending(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Pending track not found" });
        expect(prisma.playlistPendingTrack.update).toHaveBeenCalledWith({
            where: { id: "pt-1", playlistId: "pl-1" },
            data: { deezerPreviewUrl: "https://preview/new.mp3" },
        });
    });

    it("denies pending previews for another user's private playlist", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-private",
            userId: "u2",
            isPublic: false,
        });
        const req = {
            user: { id: "u1" },
            params: { id: "pl-private", trackId: "pt-victim" },
        } as any;
        const res = createRes();

        await previewPending(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Access denied" });
        expect(prisma.playlistPendingTrack.findUnique).not.toHaveBeenCalled();
        expect(deezerService.getTrackPreview).not.toHaveBeenCalled();
    });

    it("handles pending preview server errors", async () => {
        prisma.playlistPendingTrack.findUnique.mockRejectedValueOnce(
            new Error("preview failed"),
        );
        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const res = createRes();
        await previewPending(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get preview URL" });
    });

    it("handles retry preconditions and soulseek no-result response", async () => {
        prisma.playlist.findUnique.mockResolvedValue({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValue({
            id: "pt-1",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Unknown Album",
            albumMbid: null,
            artistMbid: null,
        });

        getSystemSettings.mockResolvedValueOnce({
            musicPath: null,
        });
        const noPathReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const noPathRes = createRes();
        await retryPending(noPathReq, noPathRes);
        expect(noPathRes.statusCode).toBe(400);
        expect(noPathRes.body.error).toBe("Music path not configured");

        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: null,
            soulseekPassword: null,
        });
        const noCredsReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const noCredsRes = createRes();
        await retryPending(noCredsReq, noCredsRes);
        expect(noCredsRes.statusCode).toBe(400);
        expect(noCredsRes.body.error).toBe(
            "Soulseek credentials not configured",
        );

        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: false,
            allMatches: [],
        });
        const noResultsReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const noResultsRes = createRes();
        await retryPending(noResultsReq, noResultsRes);
        expect(noResultsRes.statusCode).toBe(200);
        expect(noResultsRes.body).toEqual({
            success: false,
            message: "Track not found on Soulseek",
            error: "No matching files found",
        });
    });

    it("handles retry missing/denied/missing-pending precondition branches", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingPlaylistReq = {
            user: { id: "u1" },
            params: { id: "missing", trackId: "pt-1" },
        } as any;
        const missingPlaylistRes = createRes();
        await retryPending(missingPlaylistReq, missingPlaylistRes);
        expect(missingPlaylistRes.statusCode).toBe(404);
        expect(missingPlaylistRes.body).toEqual({
            error: "Playlist not found",
        });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
        });
        const deniedReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const deniedRes = createRes();
        await retryPending(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);
        expect(deniedRes.body).toEqual({ error: "Access denied" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce(null);
        const missingPendingReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-missing" },
        } as any;
        const missingPendingRes = createRes();
        await retryPending(missingPendingReq, missingPendingRes);
        expect(missingPendingRes.statusCode).toBe(404);
        expect(missingPendingRes.body).toEqual({
            error: "Pending track not found",
        });
    });

    it("does not retry a pending track belonging to another owned playlist", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-owned",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce(null);
        const req = {
            user: { id: "u1" },
            params: { id: "pl-owned", trackId: "pt-victim" },
        } as any;
        const res = createRes();

        await retryPending(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Pending track not found" });
        expect(prisma.playlistPendingTrack.findUnique).toHaveBeenCalledWith({
            where: { id: "pt-victim", playlistId: "pl-owned" },
        });
        expect(prisma.downloadJob.create).not.toHaveBeenCalled();
        expect(soulseekService.searchTrack).not.toHaveBeenCalled();
    });

    it("reconciles pending tracks for playlist owners", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        spotifyImportService.reconcilePendingTracks.mockResolvedValueOnce({
            tracksAdded: 3,
            playlistsUpdated: 2,
        });

        const req = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const res = createRes();
        await reconcilePending(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Reconciliation complete",
            tracksAdded: 3,
            playlistsUpdated: 2,
        });
    });

    it("starts retry downloads in background and marks jobs completed on success", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-2",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Album",
            albumMbid: "rg-1",
            artistMbid: "ar-1",
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-success",
            metadata: {},
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "match-1" }],
        });
        soulseekService.downloadBestMatch.mockResolvedValueOnce({
            success: true,
            filePath: "/music/Artist/Album/track.flac",
        });
        scanQueue.add.mockResolvedValueOnce({ id: "scan-success" });

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-2" },
        } as any;
        const res = createRes();
        await retryPending(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                success: true,
                message: "Download started",
                downloadJobId: "job-success",
            }),
        );
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-success" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        filePath: "/music/Artist/Album/track.flac",
                    }),
                }),
            }),
        );
        expect(scanQueue.add).toHaveBeenCalledWith(
            "scan",
            expect.objectContaining({
                userId: "u1",
                source: "retry-pending-track",
                albumMbid: "rg-1",
                artistMbid: "ar-1",
            }),
            expect.objectContaining({
                priority: 1,
                removeOnComplete: true,
            }),
        );
    });

    it("continues retry success flow when scan queue enqueue fails", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-queue-fail",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Album",
            albumMbid: "rg-1",
            artistMbid: "ar-1",
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-queue-fail",
            metadata: {},
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "match-1" }],
        });
        soulseekService.downloadBestMatch.mockResolvedValueOnce({
            success: true,
            filePath: "/music/Artist/Album/track.flac",
        });
        scanQueue.add.mockRejectedValueOnce(new Error("scan enqueue failed"));

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-queue-fail" },
        } as any;
        const res = createRes();
        await retryPending(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-queue-fail" },
                data: expect.objectContaining({ status: "completed" }),
            }),
        );
    });

    it("sanitizes scan-queue enqueue errors out of the client-visible session log", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-scan-error",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Album",
            albumMbid: "rg-1",
            artistMbid: "ar-1",
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-scan-error",
            metadata: {},
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "match-1" }],
        });
        soulseekService.downloadBestMatch.mockResolvedValueOnce({
            success: true,
            filePath: "/music/Artist/Album/track.flac",
        });
        scanQueue.add.mockRejectedValueOnce(new Error("scan blew up"));

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-scan-error" },
        } as any;
        const res = createRes();
        await retryPending(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-scan-error" },
                data: expect.objectContaining({ status: "completed" }),
            }),
        );
        const sessionLogMock = jest.requireMock("../../utils/playlistLogger")
            .sessionLog as jest.Mock;
        expect(JSON.stringify(sessionLogMock.mock.calls)).not.toContain(
            "scan blew up",
        );
        expect(sessionLogMock).toHaveBeenCalledWith(
            "PENDING-RETRY",
            "Failed to queue scan (raw detail in server log)",
            "ERROR",
        );
    });

    it("marks retry download jobs failed when Soulseek returns an unsuccessful result", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-3",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Album",
            albumMbid: null,
            artistMbid: null,
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-failed-result",
            metadata: {},
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "match-1" }],
        });
        soulseekService.downloadBestMatch.mockResolvedValueOnce({
            success: false,
            error: "peer xyz123 connection reset",
        });

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-3" },
        } as any;
        const res = createRes();
        await retryPending(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-failed-result" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "peer xyz123 connection reset",
                }),
            }),
        );
        const sessionLogMock = jest.requireMock("../../utils/playlistLogger")
            .sessionLog as jest.Mock;
        expect(JSON.stringify(sessionLogMock.mock.calls)).not.toContain(
            "peer xyz123",
        );
        expect(sessionLogMock).toHaveBeenCalledWith(
            "PENDING-RETRY",
            "Download failed (raw detail in server log)",
            "WARN",
        );
    });

    it("marks retry download jobs failed when Soulseek download throws", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-4",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Album",
            albumMbid: null,
            artistMbid: null,
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-failed-throw",
            metadata: {},
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "match-1" }],
        });
        soulseekService.downloadBestMatch.mockRejectedValueOnce(
            new Error("socket closed"),
        );

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-4" },
        } as any;
        const res = createRes();
        await retryPending(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-failed-throw" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "Download exception",
                }),
            }),
        );
        const sessionLogMock = jest.requireMock("../../utils/playlistLogger")
            .sessionLog as jest.Mock;
        expect(JSON.stringify(sessionLogMock.mock.calls)).not.toContain(
            "socket closed",
        );
    });

    it("swallows download-job update failures in retry catch fallback", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-5",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Album",
            albumMbid: null,
            artistMbid: null,
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-failed-update-write",
            metadata: {},
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "match-1" }],
        });
        soulseekService.downloadBestMatch.mockRejectedValueOnce(
            new Error("socket closed"),
        );
        prisma.downloadJob.update.mockRejectedValueOnce(
            new Error("write failed"),
        );

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-5" },
        } as any;
        const res = createRes();
        await retryPending(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                success: true,
                message: "Download started",
            }),
        );
    });

    it("returns 500 when retry handler throws unexpectedly", async () => {
        prisma.playlist.findUnique.mockRejectedValueOnce(
            new Error("db exploded"),
        );

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const res = createRes();
        await retryPending(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to retry download",
        });
        const sessionLogMock = jest.requireMock("../../utils/playlistLogger")
            .sessionLog as jest.Mock;
        expect(JSON.stringify(sessionLogMock.mock.calls)).not.toContain(
            "db exploded",
        );
    });

    it("handles reconcile preconditions and unexpected reconcile errors", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = {
            user: { id: "u1" },
            params: { id: "missing" },
        } as any;
        const missingRes = createRes();
        await reconcilePending(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Playlist not found" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u2",
            isPublic: false,
        });
        const deniedReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const deniedRes = createRes();
        await reconcilePending(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);
        expect(deniedRes.body).toEqual({ error: "Access denied" });

        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
        });
        spotifyImportService.reconcilePendingTracks.mockRejectedValueOnce(
            new Error("reconcile failed"),
        );
        const errReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const errRes = createRes();
        await reconcilePending(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({
            error: "Failed to reconcile pending tracks",
        });
    });
});
