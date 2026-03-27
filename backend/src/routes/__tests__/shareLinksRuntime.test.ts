import crypto from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "../../utils/db";
import router from "../shareLinks";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("node:crypto", () => ({
    __esModule: true,
    default: {
        randomBytes: jest.fn(() => ({
            toString: jest.fn(() => "f".repeat(64)),
        })),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        shareLink: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        playlist: {
            findUnique: jest.fn(),
        },
        album: {
            findUnique: jest.fn(),
        },
        track: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
        playlistItem: {
            findFirst: jest.fn(),
        },
    },
}));

const mockStreamFileWithRangeSupport = jest.fn().mockResolvedValue(undefined);
const mockGetStreamFilePath = jest.fn().mockResolvedValue({
    filePath: "/music/artist/album/track.flac",
    mimeType: "audio/flac",
});
const mockDestroy = jest.fn();
const mockArchiveFile = jest.fn();
const mockArchivePipe = jest.fn();
const mockArchiveFinalize = jest.fn().mockResolvedValue(undefined);
const mockArchiveOn = jest.fn();

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn().mockImplementation(() => ({
        getStreamFilePath: mockGetStreamFilePath,
        streamFileWithRangeSupport: mockStreamFileWithRangeSupport,
        destroy: mockDestroy,
    })),
}));

jest.mock("archiver", () => ({
    __esModule: true,
    default: jest.fn(() => ({
        file: mockArchiveFile,
        pipe: mockArchivePipe,
        finalize: mockArchiveFinalize,
        on: mockArchiveOn,
    })),
}));

const mockFetchExternalImage = jest.fn().mockResolvedValue({
    ok: true,
    url: "https://example.com/cover.jpg",
    buffer: Buffer.from("fake-image"),
    contentType: "image/jpeg",
    etag: "abc123",
});

jest.mock("../../services/imageProxy", () => ({
    fetchExternalImage: (...args: unknown[]) => mockFetchExternalImage(...args),
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/transcode",
            transcodeCacheMaxGb: 10,
        },
    },
}));

const mockRandomBytes = crypto.randomBytes as jest.Mock;

const mockShareLinkCreate = prisma.shareLink.create as jest.Mock;
const mockShareLinkFindMany = prisma.shareLink.findMany as jest.Mock;
const mockShareLinkFindFirst = prisma.shareLink.findFirst as jest.Mock;
const mockShareLinkFindUnique = prisma.shareLink.findUnique as jest.Mock;
const mockShareLinkUpdate = prisma.shareLink.update as jest.Mock;
const mockShareLinkUpdateMany = prisma.shareLink.updateMany as jest.Mock;
const mockPlaylistFindUnique = prisma.playlist.findUnique as jest.Mock;
const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
const mockPlaylistItemFindFirst = prisma.playlistItem.findFirst as jest.Mock;

type RouteHandler = (req: Request, res: MockResponse) => Promise<void> | void;

type RouterLayer = {
    route?: {
        path?: string;
        methods?: Partial<Record<"get" | "post" | "delete", boolean>>;
        stack: Array<{ handle: RouteHandler }>;
    };
};

type MockRequestInput = {
    user?: {
        id: string;
        username?: string;
        role?: string;
    };
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
};

type MockResponse = {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
    status: jest.MockedFunction<(code: number) => MockResponse>;
    json: jest.MockedFunction<(payload: unknown) => MockResponse>;
    setHeader: jest.MockedFunction<(key: string, value: string) => MockResponse>;
    send: jest.MockedFunction<(data: unknown) => MockResponse>;
    destroy: jest.MockedFunction<(error?: Error) => MockResponse>;
};

function getHandler(path: string, method: "get" | "post" | "delete") {
    const stack = (router as unknown as { stack: RouterLayer[] }).stack;
    const layer = stack.find(
        (entry) => entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    const route = layer.route;
    if (!route) {
        throw new Error(`Route missing handler: ${method.toUpperCase()} ${path}`);
    }
    return route.stack[route.stack.length - 1].handle;
}

function createRes() {
    const res = {} as MockResponse;
    res.statusCode = 200;
    res.body = undefined;
    res.headers = {};
    res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((payload: unknown) => {
        res.body = payload;
        return res;
    });
    res.setHeader = jest.fn((key: string, value: string) => {
        res.headers[key] = value;
        return res;
    });
    res.send = jest.fn((data: unknown) => {
        res.body = data;
        return res;
    });
    res.destroy = jest.fn(() => res);

    return res;
}

function createReq(overrides: MockRequestInput): Request {
    return overrides as unknown as Request;
}

describe("shareLinks routes runtime", () => {
    const postShareLinks = getHandler("/", "post");
    const getShareLinks = getHandler("/", "get");
    const deleteShareLink = getHandler("/:id", "delete");
    const getSharedResource = getHandler("/access/:token", "get");
    const getSharedStream = getHandler("/access/:token/stream/:trackId", "get");
    const getSharedZip = getHandler("/access/:token/zip", "get");
    const getSharedCover = getHandler("/access/:token/cover", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        mockRandomBytes.mockReturnValue({
            toString: jest.fn(() => "a".repeat(64)),
        });

        mockPlaylistFindUnique.mockResolvedValue({ id: "playlist-1", userId: "u1" });
        mockAlbumFindUnique.mockResolvedValue({ id: "album-1" });
        mockTrackFindUnique.mockResolvedValue({ id: "track-1", title: "Track One", filePath: "artist/album/track.flac", fileModified: new Date() });
        mockTrackFindFirst.mockResolvedValue({ id: "track-1", title: "Track One", filePath: "artist/album/track.flac", fileModified: new Date() });
        mockPlaylistItemFindFirst.mockResolvedValue({ id: "item-1", trackId: "track-1" });

        mockShareLinkCreate.mockResolvedValue({
            id: "share-1",
            token: "a".repeat(64),
            userId: "u1",
            resourceType: "playlist",
            resourceId: "playlist-1",
            expiresAt: null,
            maxPlays: null,
            playCount: 0,
            revoked: false,
            createdAt: new Date("2026-03-25T00:00:00.000Z"),
        });

        mockShareLinkFindMany.mockResolvedValue([
            {
                id: "share-1",
                token: "a".repeat(64),
                userId: "u1",
                resourceType: "playlist",
                resourceId: "playlist-1",
                expiresAt: null,
                maxPlays: 10,
                playCount: 1,
                revoked: false,
                createdAt: new Date("2026-03-25T00:00:00.000Z"),
            },
        ]);

        mockShareLinkFindFirst.mockResolvedValue({ id: "share-1" });
        mockShareLinkFindUnique.mockResolvedValue({
            id: "share-1",
            token: "a".repeat(64),
            userId: "u1",
            resourceType: "playlist",
            resourceId: "playlist-1",
            expiresAt: null,
            maxPlays: 5,
            playCount: 0,
            revoked: false,
            createdAt: new Date("2026-03-25T00:00:00.000Z"),
        });
        mockShareLinkUpdate.mockResolvedValue({ id: "share-1" });
        mockShareLinkUpdateMany.mockResolvedValue({ count: 1 });
    });

    it("POST creates a share link with generated token", async () => {
        const req = createReq({
            user: { id: "u1", role: "user" },
            body: { resourceType: "playlist", resourceId: "playlist-1", maxPlays: 10 },
        });
        const res = createRes();

        await postShareLinks(req, res);

        expect(mockRandomBytes).toHaveBeenCalledWith(32);
        expect(mockShareLinkCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "u1",
                resourceType: "playlist",
                resourceId: "playlist-1",
                token: "a".repeat(64),
                maxPlays: 10,
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "share-1",
                token: "a".repeat(64),
                accessPath: `/api/share-links/access/${"a".repeat(64)}`,
            })
        );
    });

    it("GET lists current user's non-revoked share links", async () => {
        const req = createReq({ user: { id: "u1" } });
        const res = createRes();

        await getShareLinks(req, res);

        expect(mockShareLinkFindMany).toHaveBeenCalledWith({
            where: { userId: "u1", revoked: false },
            orderBy: { createdAt: "desc" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "share-1",
                accessPath: `/api/share-links/access/${"a".repeat(64)}`,
            }),
        ]);
    });

    it("DELETE revokes an owned share link", async () => {
        const req = createReq({ user: { id: "u1" }, params: { id: "share-1" } });
        const res = createRes();

        await deleteShareLink(req, res);

        expect(mockShareLinkFindFirst).toHaveBeenCalledWith({
            where: { id: "share-1", userId: "u1" },
            select: { id: true },
        });
        expect(mockShareLinkUpdate).toHaveBeenCalledWith({
            where: { id: "share-1" },
            data: { revoked: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
    });

    it("access endpoint returns resource for valid token", async () => {
        mockPlaylistFindUnique.mockResolvedValueOnce({
            id: "playlist-1",
            name: "Shared Playlist",
            user: { username: "alice" },
            items: [],
            pendingTracks: [],
        });

        const req = createReq({ params: { token: "a".repeat(64) } });
        const res = createRes();

        await getSharedResource(req, res);

        expect(mockShareLinkFindUnique).toHaveBeenCalledWith({
            where: { token: "a".repeat(64) },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            resourceType: "playlist",
            resource: expect.objectContaining({
                id: "playlist-1",
                name: "Shared Playlist",
            }),
        });
    });

    it("access endpoint returns 404 for expired token", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce({
            id: "share-expired",
            token: "expired",
            userId: "u1",
            resourceType: "playlist",
            resourceId: "playlist-1",
            expiresAt: new Date("2020-01-01T00:00:00.000Z"),
            maxPlays: null,
            playCount: 0,
            revoked: false,
            createdAt: new Date("2026-03-25T00:00:00.000Z"),
        });

        const req = createReq({ params: { token: "expired" } });
        const res = createRes();

        await getSharedResource(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Share link not found" });
        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
    });

    it("access endpoint returns 404 for revoked token", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce({
            id: "share-revoked",
            token: "revoked",
            userId: "u1",
            resourceType: "playlist",
            resourceId: "playlist-1",
            expiresAt: null,
            maxPlays: null,
            playCount: 0,
            revoked: true,
            createdAt: new Date("2026-03-25T00:00:00.000Z"),
        });

        const req = createReq({ params: { token: "revoked" } });
        const res = createRes();

        await getSharedResource(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Share link not found" });
        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
    });

    it("access endpoint increments playCount on page load for a new session", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce({
            id: "share-2",
            token: "t2",
            userId: "u1",
            resourceType: "track",
            resourceId: "track-1",
            expiresAt: null,
            maxPlays: 2,
            playCount: 1,
            lastStreamedAt: null,
            revoked: false,
            createdAt: new Date("2026-03-25T00:00:00.000Z"),
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-1",
            title: "Track One",
            album: { id: "album-1", title: "Album One", artist: { id: "artist-1", name: "Artist" } },
        });

        const req = createReq({ params: { token: "t2" } });
        const res = createRes();

        await getSharedResource(req, res);

        expect(mockShareLinkUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    playCount: { increment: 1 },
                    lastStreamedAt: expect.any(Date),
                }),
            })
        );
        expect(mockShareLinkUpdate).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
    });

    it("access endpoint only updates lastStreamedAt within the session window", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce({
            id: "share-3",
            token: "t3",
            userId: "u1",
            resourceType: "track",
            resourceId: "track-1",
            expiresAt: null,
            maxPlays: 3,
            playCount: 1,
            lastStreamedAt: new Date(Date.now() - 5 * 60 * 1000),
            revoked: false,
            createdAt: new Date("2026-03-25T00:00:00.000Z"),
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-1",
            title: "Track One",
            album: { id: "album-1", title: "Album One", artist: { id: "artist-1", name: "Artist" } },
        });

        const req = createReq({ params: { token: "t3" } });
        const res = createRes();

        await getSharedResource(req, res);

        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        expect(mockShareLinkUpdate).toHaveBeenCalledWith({
            where: { id: "share-3" },
            data: { lastStreamedAt: expect.any(Date) },
        });
        expect(res.statusCode).toBe(200);
    });

    describe("GET /access/:token/stream/:trackId", () => {
        it("streams track for valid share link (track type)", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "track",
                resourceId: "track-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1", title: "Track", filePath: "a/b/track.flac", fileModified: new Date(),
            });

            const req = createReq({ params: { token: "valid-token", trackId: "track-1" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(mockStreamFileWithRangeSupport).toHaveBeenCalled();
            expect(mockDestroy).toHaveBeenCalled();
        });

        it("streams track belonging to shared album", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });

            const req = createReq({ params: { token: "valid-token", trackId: "track-1" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(mockTrackFindFirst).toHaveBeenCalledWith({
                where: { id: "track-1", albumId: "album-1" },
                select: expect.any(Object),
            });
            expect(mockStreamFileWithRangeSupport).toHaveBeenCalled();
        });

        it("streams track belonging to shared playlist", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "playlist",
                resourceId: "playlist-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });

            const req = createReq({ params: { token: "valid-token", trackId: "track-1" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(mockPlaylistItemFindFirst).toHaveBeenCalledWith({
                where: { playlistId: "playlist-1", trackId: "track-1" },
            });
            expect(mockStreamFileWithRangeSupport).toHaveBeenCalled();
        });

        it("returns 404 for track not in shared album", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockTrackFindFirst.mockResolvedValueOnce(null);

            const req = createReq({ params: { token: "valid-token", trackId: "wrong-track" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Track not found" });
        });

        it("returns 404 for expired share link", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "expired-token", resourceType: "track",
                resourceId: "track-1", revoked: false,
                expiresAt: new Date("2020-01-01T00:00:00.000Z"),
                maxPlays: null, playCount: 0,
            });

            const req = createReq({ params: { token: "expired-token", trackId: "track-1" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Share link not found" });
        });

        it("returns 404 for track without filePath", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "track",
                resourceId: "track-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1", title: "Track", filePath: null, fileModified: null,
            });

            const req = createReq({ params: { token: "valid-token", trackId: "track-1" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Track not available for streaming" });
        });

        it("sets Content-Disposition for download=true", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "track",
                resourceId: "track-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1", title: "Track", filePath: "a/b/track.flac", fileModified: new Date(),
            });

            const req = createReq({ params: { token: "valid-token", trackId: "track-1" }, query: { download: "true" }, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", expect.stringContaining("attachment"));
        });

        it("only updates lastStreamedAt for a new stream session", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "track",
                resourceId: "track-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0, lastStreamedAt: null,
            });
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1", title: "Track", filePath: "a/b/track.flac", fileModified: new Date(),
            });

            const req = createReq({ params: { token: "valid-token", trackId: "track-1" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
            expect(mockShareLinkUpdate).toHaveBeenCalledWith({
                where: { id: "share-1" },
                data: { lastStreamedAt: expect.any(Date) },
            });
        });

        it("only updates lastStreamedAt for an existing stream session", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "track",
                resourceId: "track-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0, lastStreamedAt: new Date(Date.now() - 5 * 60 * 1000),
            });
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1", title: "Track", filePath: "a/b/track.flac", fileModified: new Date(),
            });

            const req = createReq({ params: { token: "valid-token", trackId: "track-1" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedStream(req, res);

            expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
            expect(mockShareLinkUpdate).toHaveBeenCalledWith({
                where: { id: "share-1" },
                data: { lastStreamedAt: expect.any(Date) },
            });
        });
    });

    describe("GET /access/:token/zip", () => {
        it("returns 404 for invalid token", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce(null);

            const req = { params: { token: "invalid-token" } } as unknown as Request;
            const res = createRes();

            await getSharedZip(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Share link not found" });
        });

        it("streams a zip for a valid album share", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-zip", token: "zip-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockAlbumFindUnique.mockResolvedValueOnce({
                artist: { name: "Artist One" },
                tracks: [
                    { id: "track-1", title: "Track One", filePath: "artist/album/01.flac", fileModified: new Date() },
                    { id: "track-2", title: "Track Two", filePath: "artist/album/02.flac", fileModified: new Date() },
                ],
            });

            const req = { params: { token: "zip-token" } } as unknown as Request;
            const res = createRes();

            await getSharedZip(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.headers["Content-Type"]).toBe("application/zip");
            expect(res.headers["Content-Disposition"]).toContain("attachment");
            expect(mockArchivePipe).toHaveBeenCalledWith(res);
            expect(mockArchiveFile).toHaveBeenCalledTimes(2);
            expect(mockArchiveFinalize).toHaveBeenCalledTimes(1);
        });

        it("returns 404 when no streamable tracks exist", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-zip", token: "zip-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockAlbumFindUnique.mockResolvedValueOnce({
                artist: { name: "Artist One" },
                tracks: [
                    { id: "track-1", title: "Track One", filePath: null, fileModified: null },
                    { id: "track-2", title: "Track Two", filePath: null, fileModified: null },
                ],
            });

            const req = { params: { token: "zip-token" } } as unknown as Request;
            const res = createRes();

            await getSharedZip(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "No streamable tracks found" });
            expect(mockArchiveFinalize).not.toHaveBeenCalled();
        });

        it("does not mutate play counts during zip download", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-zip", token: "zip-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockAlbumFindUnique.mockResolvedValueOnce({
                artist: { name: "Artist One" },
                tracks: [
                    { id: "track-1", title: "Track One", filePath: "artist/album/01.flac", fileModified: new Date() },
                    { id: "track-2", title: "Track Two", filePath: "artist/album/02.flac", fileModified: new Date() },
                ],
            });

            const req = { params: { token: "zip-token" } } as unknown as Request;
            const res = createRes();

            await getSharedZip(req, res);

            expect(mockShareLinkUpdate).not.toHaveBeenCalled();
            expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        });
    });

    describe("GET /access/:token/cover", () => {
        it("proxies cover image for valid share link", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });

            const req = createReq({ params: { token: "valid-token" }, query: { url: "https://example.com/cover.jpg" }, headers: {} });
            const res = createRes();
            await getSharedCover(req, res);

            expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/jpeg");
            expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=3600");
            expect(res.send).toHaveBeenCalled();
        });

        it("returns 404 for invalid share token", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce(null);

            const req = createReq({ params: { token: "invalid" }, query: { url: "https://example.com/cover.jpg" }, headers: {} });
            const res = createRes();
            await getSharedCover(req, res);

            expect(res.statusCode).toBe(404);
        });

        it("returns 400 when url param is missing", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });

            const req = createReq({ params: { token: "valid-token" }, query: {}, headers: {} });
            const res = createRes();
            await getSharedCover(req, res);

            expect(res.statusCode).toBe(400);
        });

        it("returns 404 when image fetch fails", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce({
                id: "share-1", token: "valid-token", resourceType: "album",
                resourceId: "album-1", revoked: false, expiresAt: null,
                maxPlays: null, playCount: 0,
            });
            mockFetchExternalImage.mockResolvedValueOnce({ ok: false, url: "https://example.com/cover.jpg", status: "not_found" });

            const req = createReq({ params: { token: "valid-token" }, query: { url: "https://example.com/cover.jpg" }, headers: {} });
            const res = createRes();
            await getSharedCover(req, res);

            expect(res.statusCode).toBe(404);
        });
    });
});
