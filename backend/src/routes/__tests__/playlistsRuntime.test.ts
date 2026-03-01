jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
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
        create: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
    },
    track: {
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
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma,
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

function getHandler(
    path: string,
    method: "get" | "post" | "put" | "delete"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
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
        prisma.playlistItem.create.mockResolvedValue({
            id: "pli-1",
            sort: 6,
            track: {
                id: "t-1",
                title: "Track 1",
                album: { title: "Album 1", artist: { name: "Artist 1" } },
            },
        });
        prisma.playlistItem.delete.mockResolvedValue({});
        prisma.playlistItem.update.mockResolvedValue({});

        prisma.track.findUnique.mockResolvedValue({ id: "t-1" });

        prisma.playlistPendingTrack.findMany.mockResolvedValue([]);
        prisma.playlistPendingTrack.findUnique.mockResolvedValue(null);
        prisma.playlistPendingTrack.update.mockResolvedValue({});
        prisma.playlistPendingTrack.delete.mockResolvedValue({});

        prisma.downloadJob.create.mockResolvedValue({
            id: "job-1",
            metadata: {},
        });
        prisma.downloadJob.update.mockResolvedValue({});
        prisma.$transaction.mockResolvedValue([]);

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
        getSystemSettings.mockResolvedValue({
            musicPath: null,
            soulseekUsername: null,
            soulseekPassword: null,
        });
        scanQueue.add.mockResolvedValue({ id: "scan-1" });
    });

    it("rejects unauthenticated listing", async () => {
        const req = {} as any;
        const res = createRes();

        await listPlaylists(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("lists owned and shared playlists with visibility metadata", async () => {
        prisma.hiddenPlaylist.findMany.mockResolvedValue([{ playlistId: "pl-2" }]);
        prisma.playlist.findMany.mockResolvedValue([
            {
                id: "pl-1",
                userId: "u1",
                name: "Mine",
                user: { username: "owner" },
                items: [{ id: "i-1" }],
            },
            {
                id: "pl-2",
                userId: "u2",
                name: "Shared",
                user: { username: "friend" },
                items: [],
            },
        ]);

        const req = { user: { id: "u1" } } as any;
        const res = createRes();
        await listPlaylists(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "pl-1",
                isOwner: true,
                isHidden: false,
                trackCount: 1,
            }),
            expect.objectContaining({
                id: "pl-2",
                isOwner: false,
                isHidden: true,
                trackCount: 0,
            }),
        ]);
    });

    it("returns 500 when playlist listing throws", async () => {
        prisma.hiddenPlaylist.findMany.mockRejectedValueOnce(
            new Error("hidden lookup failed")
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

        prisma.playlist.create.mockRejectedValueOnce(new Error("create failed"));
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
        const missingReq = { user: { id: "u1" }, params: { id: "missing" } } as any;
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
        const deniedReq = { user: { id: "u1" }, params: { id: "pl-private" } } as any;
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

        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("lookup failed"));
        const errReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const errRes = createRes();
        await getPlaylist(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to get playlist" });
    });

    it("formats playlist detail with provider/playability metadata and merged items", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
            isPublic: false,
            user: { username: "owner" },
            hiddenByUsers: [{ id: "hidden-1" }],
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
                            artist: { id: "a-1", name: "Artist", mbid: "mbid-a1" },
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
        expect(res.body.isOwner).toBe(true);
        expect(res.body.isHidden).toBe(true);
        expect(res.body.items[0].track.album.coverArt).toBe("native:albums/a1.jpg");
        expect(res.body.items[0].provider.source).toBe("local");
        expect(res.body.items[0].playback.isPlayable).toBe(true);

        const tidalItem = res.body.items.find(
            (entry: any) => entry.provider?.source === "tidal"
        );
        expect(tidalItem).toBeDefined();
        expect(tidalItem.playback.isPlayable).toBe(true);
        expect(tidalItem.track.streamSource).toBe("tidal");
        expect(tidalItem.track.tidalTrackId).toBe(991);

        const ytItem = res.body.items.find(
            (entry: any) => entry.provider?.source === "youtube"
        );
        expect(ytItem).toBeDefined();
        expect(ytItem.playback.isPlayable).toBe(true);
        expect(ytItem.track.streamSource).toBe("youtube");
        expect(ytItem.track.youtubeVideoId).toBe("yt-video-7");

        const unknownItem = res.body.items.find(
            (entry: any) => entry.provider?.source === "unknown"
        );
        expect(unknownItem).toBeDefined();
        expect(unknownItem.playback.isPlayable).toBe(false);
        expect(unknownItem.playback.message).toContain(
            "no longer has an attached track source"
        );

        expect(res.body.pendingTracks[0].playback.isPlayable).toBe(false);
        expect(res.body.pendingTracks[0].provider.source).toBe("pending");
        expect(res.body.mergedItems[0].type).toBe("pending");
        expect(res.body.mergedItems[1].type).toBe("track");
    });

    it("validates and updates playlists with ownership checks", async () => {
        const invalidReq = { user: { id: "u1" }, body: { name: "" }, params: { id: "pl-1" } } as any;
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

        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("update failed"));
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
        const missingReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
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

        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("hide failed"));
        const hideErrReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
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
            new Error("unhide failed")
        );
        const unhideErrReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
        const unhideErrRes = createRes();
        await unhidePlaylist(unhideErrReq, unhideErrRes);
        expect(unhideErrRes.statusCode).toBe(500);
        expect(unhideErrRes.body).toEqual({ error: "Failed to unhide playlist" });
    });

    it("deletes playlists with ownership checks", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
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

        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("delete failed"));
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
        prisma.playlistItem.findUnique.mockResolvedValueOnce({
            id: "pli-existing",
            playlistId: "pl-1",
            trackId: "t-1",
            sort: 2,
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
        prisma.playlistItem.findUnique.mockResolvedValueOnce(null);
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
            })
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

        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("add failed"));
        const errReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackId: "t-1" },
        } as any;
        const errRes = createRes();
        await addItem(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to add track to playlist" });
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

    it("handles remove and reorder server-error/missing/denied branches", async () => {
        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("remove failed"));
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
        prisma.$transaction.mockRejectedValueOnce(new Error("reorder failed"));
        const reorderErrReq = {
            user: { id: "u1" },
            params: { id: "pl-1" },
            body: { trackIds: ["t-2", "t-1"] },
        } as any;
        const reorderErrRes = createRes();
        await reorderItems(reorderErrReq, reorderErrRes);
        expect(reorderErrRes.statusCode).toBe(500);
        expect(reorderErrRes.body).toEqual({ error: "Failed to reorder playlist" });
    });

    it("reads pending tracks with ownership checks and mapped payload", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = { user: { id: "u1" }, params: { id: "pl-1" } } as any;
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
        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("pending failed"));
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
            new Error("delete failed")
        );
        const errReq = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const errRes = createRes();
        await deletePending(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to delete pending track" });
    });

    it("refreshes pending preview URLs with no-preview and success branches", async () => {
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce(null);
        const missingReq = { params: { id: "pl-1", trackId: "pt-1" } } as any;
        const missingRes = createRes();
        await previewPending(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce({
            id: "pt-1",
            spotifyArtist: "A",
            spotifyTitle: "T",
        });
        deezerService.getTrackPreview.mockResolvedValueOnce(null);
        const noneReq = { params: { id: "pl-1", trackId: "pt-1" } } as any;
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
            "https://preview/new.mp3"
        );
        const okReq = { params: { id: "pl-1", trackId: "pt-1" } } as any;
        const okRes = createRes();
        await previewPending(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({ previewUrl: "https://preview/new.mp3" });
        expect(prisma.playlistPendingTrack.update).toHaveBeenCalledWith({
            where: { id: "pt-1" },
            data: { deezerPreviewUrl: "https://preview/new.mp3" },
        });
    });

    it("handles pending preview server errors", async () => {
        prisma.playlistPendingTrack.findUnique.mockRejectedValueOnce(
            new Error("preview failed")
        );
        const req = { params: { id: "pl-1", trackId: "pt-1" } } as any;
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
            "Soulseek credentials not configured"
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
        expect(missingPlaylistRes.body).toEqual({ error: "Playlist not found" });

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
        expect(missingPendingRes.body).toEqual({ error: "Pending track not found" });
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
            error: "download failed",
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
                    error: "download failed",
                }),
            }),
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
                    error: "socket closed",
                }),
            }),
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
        prisma.downloadJob.update.mockRejectedValueOnce(new Error("write failed"));

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
        prisma.playlist.findUnique.mockRejectedValueOnce(new Error("db exploded"));

        const req = {
            user: { id: "u1" },
            params: { id: "pl-1", trackId: "pt-1" },
        } as any;
        const res = createRes();
        await retryPending(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to retry download",
            details: "db exploded",
        });
    });

    it("handles reconcile preconditions and unexpected reconcile errors", async () => {
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingReq = { user: { id: "u1" }, params: { id: "missing" } } as any;
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
