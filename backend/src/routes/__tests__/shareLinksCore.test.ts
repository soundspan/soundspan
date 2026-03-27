import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";
const ROLE_HEADER = "x-test-role";
const TOKEN = "t".repeat(64);
const CREATED_AT = new Date("2026-03-26T10:00:00.000Z");
const FILE_MODIFIED = new Date("2026-03-26T09:00:00.000Z");

const mockRequireAuth = jest.fn(
    (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        req.user = {
            id: "user-1",
            username: "tester",
            role: req.header(ROLE_HEADER) === "admin" ? "admin" : "user",
        };

        return next();
    }
);

const mockLoggerError = jest.fn();
const mockRandomBytes = jest.fn();
const mockGetStreamFilePath = jest.fn();
const mockStreamFileWithRangeSupport = jest.fn();
const mockDestroy = jest.fn();
const mockFetchExternalImage = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
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

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/test-music",
            transcodeCachePath: "/test-cache",
            transcodeCacheMaxGb: 5,
        },
    },
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn().mockImplementation(() => ({
        getStreamFilePath: mockGetStreamFilePath,
        streamFileWithRangeSupport: mockStreamFileWithRangeSupport,
        destroy: mockDestroy,
    })),
}));

jest.mock("../../services/imageProxy", () => ({
    fetchExternalImage: (...args: unknown[]) => mockFetchExternalImage(...args),
}));

jest.mock("node:crypto", () => {
    const actual = jest.requireActual("node:crypto");
    const mockedModule = {
        ...actual,
        randomBytes: (...args: unknown[]) => mockRandomBytes(...args),
    };

    return {
        __esModule: true,
        ...mockedModule,
        default: mockedModule,
    };
});

import { AudioStreamingService } from "../../services/audioStreaming";
import { prisma } from "../../utils/db";
import router from "../shareLinks";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/share-links", router);

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
const mockAudioStreamingService = AudioStreamingService as unknown as jest.Mock;

function makeShareLink(overrides: Record<string, unknown> = {}) {
    return {
        id: "share-1",
        token: TOKEN,
        userId: "user-1",
        resourceType: "track",
        resourceId: "track-1",
        expiresAt: null,
        maxPlays: null,
        playCount: 0,
        revoked: false,
        createdAt: CREATED_AT,
        ...overrides,
    };
}

function makeStreamableTrack(overrides: Record<string, unknown> = {}) {
    return {
        id: "track-1",
        title: "Track One",
        filePath: "Artist\\Album\\track.flac",
        fileModified: FILE_MODIFIED,
        ...overrides,
    };
}

describe("share links routes integration", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockRandomBytes.mockReturnValue({
            toString: jest.fn(() => TOKEN),
        });

        mockShareLinkCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "share-created",
            revoked: false,
            playCount: 0,
            createdAt: CREATED_AT,
            ...data,
        }));
        mockShareLinkFindMany.mockResolvedValue([]);
        mockShareLinkFindFirst.mockResolvedValue({ id: "share-1" });
        mockShareLinkFindUnique.mockResolvedValue(makeShareLink());
        mockShareLinkUpdate.mockResolvedValue({ id: "share-1", revoked: true });
        mockShareLinkUpdateMany.mockResolvedValue({ count: 1 });

        mockPlaylistFindUnique.mockResolvedValue({ id: "playlist-1", userId: "user-1" });
        mockAlbumFindUnique.mockResolvedValue({ id: "album-1" });
        mockTrackFindUnique.mockResolvedValue(makeStreamableTrack());
        mockTrackFindFirst.mockResolvedValue(makeStreamableTrack());
        mockPlaylistItemFindFirst.mockResolvedValue({ id: "playlist-item-1", trackId: "track-1" });

        mockGetStreamFilePath.mockResolvedValue({
            filePath: "/test-music/Artist/Album/track.flac",
            mimeType: "audio/flac",
        });
        mockStreamFileWithRangeSupport.mockImplementation(
            async (_req: Request, res: Response) => {
                res.status(200);
                res.end();
            }
        );
        mockDestroy.mockReturnValue(undefined);

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            buffer: Buffer.from("cover-image"),
            contentType: "image/png",
            etag: "cover-etag",
        });
    });

    it.each([
        {
            resourceType: "playlist",
            resourceId: "playlist-1",
            prime: () => mockPlaylistFindUnique.mockResolvedValueOnce({ id: "playlist-1", userId: "user-1" }),
        },
        {
            resourceType: "album",
            resourceId: "album-1",
            prime: () => mockAlbumFindUnique.mockResolvedValueOnce({ id: "album-1" }),
        },
        {
            resourceType: "track",
            resourceId: "track-1",
            prime: () => mockTrackFindUnique.mockResolvedValueOnce({ id: "track-1" }),
        },
    ])(
        "POST /api/share-links creates a tokenized share link for $resourceType",
        async ({ resourceType, resourceId, prime }) => {
            prime();

            const expiresAt = "2026-04-01T00:00:00.000Z";
            const res = await request(app)
                .post("/api/share-links")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ resourceType, resourceId, expiresAt, maxPlays: 3 });

            expect(res.status).toBe(200);
            expect(mockRandomBytes).toHaveBeenCalledWith(32);
            expect(mockShareLinkCreate).toHaveBeenCalledWith({
                data: {
                    token: TOKEN,
                    userId: "user-1",
                    resourceType,
                    resourceId,
                    expiresAt: new Date(expiresAt),
                    maxPlays: 3,
                },
            });
            expect(res.body).toEqual(
                expect.objectContaining({
                    token: TOKEN,
                    resourceType,
                    resourceId,
                    accessPath: `/api/share-links/access/${TOKEN}`,
                })
            );
        }
    );

    it("POST /api/share-links returns 404 when the resource does not exist", async () => {
        mockPlaylistFindUnique.mockResolvedValueOnce(null);

        const res = await request(app)
            .post("/api/share-links")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ resourceType: "playlist", resourceId: "missing-playlist" });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Resource not found" });
        expect(mockShareLinkCreate).not.toHaveBeenCalled();
    });

    it.each([
        {
            resourceType: "album",
            resourceId: "missing-album",
            prime: () => mockAlbumFindUnique.mockResolvedValueOnce(null),
        },
        {
            resourceType: "track",
            resourceId: "missing-track",
            prime: () => mockTrackFindUnique.mockResolvedValueOnce(null),
        },
    ])("POST /api/share-links returns 404 for missing $resourceType resources", async ({ resourceType, resourceId, prime }) => {
        prime();

        const res = await request(app)
            .post("/api/share-links")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ resourceType, resourceId });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Resource not found" });
        expect(mockShareLinkCreate).not.toHaveBeenCalled();
    });

    it("POST /api/share-links rejects playlists the current user does not own", async () => {
        mockPlaylistFindUnique.mockResolvedValueOnce({ id: "playlist-1", userId: "user-2" });

        const res = await request(app)
            .post("/api/share-links")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ resourceType: "playlist", resourceId: "playlist-1" });

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Access denied" });
        expect(mockShareLinkCreate).not.toHaveBeenCalled();
    });

    it("POST /api/share-links validates the request body", async () => {
        const res = await request(app)
            .post("/api/share-links")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ resourceType: "track", resourceId: "track-1", maxPlays: 0 });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid request",
                details: expect.any(Array),
            })
        );
        expect(mockTrackFindUnique).not.toHaveBeenCalled();
    });

    it("GET /api/share-links returns non-revoked links for the current user", async () => {
        mockShareLinkFindMany.mockResolvedValueOnce([
            makeShareLink({ id: "share-2", resourceType: "playlist", resourceId: "playlist-1" }),
            makeShareLink({ id: "share-3", resourceType: "album", resourceId: "album-1" }),
        ]);

        const res = await request(app)
            .get("/api/share-links")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(mockShareLinkFindMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                revoked: false,
            },
            orderBy: { createdAt: "desc" },
        });
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "share-2",
                accessPath: `/api/share-links/access/${TOKEN}`,
            }),
            expect.objectContaining({
                id: "share-3",
                accessPath: `/api/share-links/access/${TOKEN}`,
            }),
        ]);
    });

    it("GET /api/share-links returns 500 when listing share links fails", async () => {
        const error = new Error("share-link list failed");
        mockShareLinkFindMany.mockRejectedValueOnce(error);

        const res = await request(app)
            .get("/api/share-links")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Failed to list share links" });
        expect(mockLoggerError).toHaveBeenCalledWith("List share links error:", error);
    });

    it.each([
        {
            label: "POST /api/share-links",
            run: () => request(app).post("/api/share-links").send({ resourceType: "track", resourceId: "track-1" }),
        },
        {
            label: "GET /api/share-links",
            run: () => request(app).get("/api/share-links"),
        },
        {
            label: "DELETE /api/share-links/:id",
            run: () => request(app).delete("/api/share-links/share-1"),
        },
    ])("%s requires authentication", async ({ run }) => {
        const res = await run();

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it("DELETE /api/share-links/:id revokes an owned share link", async () => {
        const res = await request(app)
            .delete("/api/share-links/share-1")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(mockShareLinkFindFirst).toHaveBeenCalledWith({
            where: {
                id: "share-1",
                userId: "user-1",
            },
            select: { id: true },
        });
        expect(mockShareLinkUpdate).toHaveBeenCalledWith({
            where: { id: "share-1" },
            data: { revoked: true },
        });
        expect(res.body).toEqual({ success: true });
    });

    it("DELETE /api/share-links/:id returns 404 for non-owned share links", async () => {
        mockShareLinkFindFirst.mockResolvedValueOnce(null);

        const res = await request(app)
            .delete("/api/share-links/share-missing")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Share link not found" });
        expect(mockShareLinkUpdate).not.toHaveBeenCalled();
    });

    it.each([
        {
            resourceType: "playlist",
            shareLink: makeShareLink({ resourceType: "playlist", resourceId: "playlist-1" }),
            resource: {
                id: "playlist-1",
                name: "Shared Playlist",
                user: { username: "owner" },
                items: [],
                pendingTracks: [],
            },
            prime: () => mockPlaylistFindUnique.mockResolvedValueOnce({
                id: "playlist-1",
                name: "Shared Playlist",
                user: { username: "owner" },
                items: [],
                pendingTracks: [],
            }),
        },
        {
            resourceType: "album",
            shareLink: makeShareLink({ resourceType: "album", resourceId: "album-1" }),
            resource: {
                id: "album-1",
                title: "Album One",
                artist: { id: "artist-1", name: "Artist One", mbid: null },
                tracks: [],
            },
            prime: () => mockAlbumFindUnique.mockResolvedValueOnce({
                id: "album-1",
                title: "Album One",
                artist: { id: "artist-1", name: "Artist One", mbid: null },
                tracks: [],
            }),
        },
        {
            resourceType: "track",
            shareLink: makeShareLink({ resourceType: "track", resourceId: "track-1", maxPlays: 2, playCount: 1 }),
            resource: {
                id: "track-1",
                title: "Track One",
                album: { id: "album-1", artist: { id: "artist-1", name: "Artist One" } },
            },
            prime: () => mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1",
                title: "Track One",
                album: { id: "album-1", artist: { id: "artist-1", name: "Artist One" } },
            }),
        },
    ])(
        "GET /api/share-links/access/:token returns the shared $resourceType resource without auth",
        async ({ resourceType, shareLink, resource, prime }) => {
            mockShareLinkFindUnique.mockResolvedValueOnce(shareLink);
            prime();

            const res = await request(app).get(`/api/share-links/access/${TOKEN}`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ resourceType, resource });
        }
    );

    describe("GET /api/share-links/access/:token — play count", () => {
        it("increments playCount for a new session on page load", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce(
                makeShareLink({
                    resourceType: "track",
                    resourceId: "track-1",
                    lastStreamedAt: null,
                })
            );
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1",
                title: "Track One",
                album: { id: "album-1", artist: { id: "artist-1", name: "Artist One" } },
            });

            const res = await request(app).get(`/api/share-links/access/${TOKEN}`);

            expect(res.status).toBe(200);
            expect(mockShareLinkUpdateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        playCount: { increment: 1 },
                        lastStreamedAt: expect.any(Date),
                    }),
                })
            );
            expect(mockShareLinkUpdate).not.toHaveBeenCalled();
        });

        it("does not increment playCount for an existing session within the window", async () => {
            const recentStream = new Date(Date.now() - 5 * 60 * 1000);
            mockShareLinkFindUnique.mockResolvedValueOnce(
                makeShareLink({
                    resourceType: "track",
                    resourceId: "track-1",
                    lastStreamedAt: recentStream,
                })
            );
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "track-1",
                title: "Track One",
                album: { id: "album-1", artist: { id: "artist-1", name: "Artist One" } },
            });

            const res = await request(app).get(`/api/share-links/access/${TOKEN}`);

            expect(res.status).toBe(200);
            expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
            expect(mockShareLinkUpdate).toHaveBeenCalledWith({
                where: { id: "share-1" },
                data: { lastStreamedAt: expect.any(Date) },
            });
        });

        it("returns 404 when maxPlays is exhausted before page load", async () => {
            mockShareLinkFindUnique.mockResolvedValueOnce(
                makeShareLink({
                    resourceType: "track",
                    resourceId: "track-1",
                    maxPlays: 3,
                    playCount: 3,
                })
            );

            const res = await request(app).get(`/api/share-links/access/${TOKEN}`);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: "Share link not found" });
            expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
            expect(mockShareLinkUpdate).not.toHaveBeenCalled();
        });
    });

    it("GET /api/share-links/access/:token returns 404 when the shared resource no longer exists", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({
                resourceType: "album",
                resourceId: "album-missing",
                lastStreamedAt: new Date(Date.now() - 5 * 60 * 1000),
            })
        );
        mockAlbumFindUnique.mockResolvedValueOnce(null);

        const res = await request(app).get(`/api/share-links/access/${TOKEN}`);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Share link not found" });
        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        expect(mockShareLinkUpdate).toHaveBeenCalledWith({
            where: { id: "share-1" },
            data: { lastStreamedAt: expect.any(Date) },
        });
    });

    it.each([
        makeShareLink({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
        makeShareLink({ maxPlays: 1, playCount: 1 }),
    ])(
        "GET /api/share-links/access/:token rejects expired or exhausted public links",
        async (shareLink) => {
            mockShareLinkFindUnique.mockResolvedValueOnce(shareLink);

            const res = await request(app).get(`/api/share-links/access/${TOKEN}`);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: "Share link not found" });
            expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        }
    );

    it.each([
        {
            label: "track share links",
            shareLink: makeShareLink({ resourceType: "track", resourceId: "track-1" }),
            prime: () => {
                mockTrackFindUnique.mockResolvedValueOnce(makeStreamableTrack());
            },
            assertOwnership: () => {
                expect(mockTrackFindUnique).toHaveBeenCalledWith({
                    where: { id: "track-1" },
                    select: { id: true, title: true, filePath: true, fileModified: true },
                });
            },
        },
        {
            label: "album share links",
            shareLink: makeShareLink({ resourceType: "album", resourceId: "album-1" }),
            prime: () => {
                mockTrackFindFirst.mockResolvedValueOnce(makeStreamableTrack());
            },
            assertOwnership: () => {
                expect(mockTrackFindFirst).toHaveBeenCalledWith({
                    where: { id: "track-1", albumId: "album-1" },
                    select: { id: true, title: true, filePath: true, fileModified: true },
                });
            },
        },
        {
            label: "playlist share links",
            shareLink: makeShareLink({ resourceType: "playlist", resourceId: "playlist-1" }),
            prime: () => {
                mockPlaylistItemFindFirst.mockResolvedValueOnce({ id: "playlist-item-1", trackId: "track-1" });
                mockTrackFindUnique.mockResolvedValueOnce(makeStreamableTrack());
            },
            assertOwnership: () => {
                expect(mockPlaylistItemFindFirst).toHaveBeenCalledWith({
                    where: { playlistId: "playlist-1", trackId: "track-1" },
                });
            },
        },
    ])(
        "GET /api/share-links/access/:token/stream/:trackId streams audio for $label without auth",
        async ({ shareLink, prime, assertOwnership }) => {
            mockShareLinkFindUnique.mockResolvedValueOnce(shareLink);
            prime();

            const res = await request(app)
                .get(`/api/share-links/access/${TOKEN}/stream/track-1`)
                .query({ download: "true" });

            expect(res.status).toBe(200);
            expect(mockAudioStreamingService).toHaveBeenCalledWith(
                "/test-music",
                "/test-cache",
                5
            );
            expect(mockGetStreamFilePath).toHaveBeenCalledWith(
                "track-1",
                "original",
                FILE_MODIFIED,
                "/test-music/Artist/Album/track.flac"
            );
            expect(mockStreamFileWithRangeSupport).toHaveBeenCalledWith(
                expect.objectContaining({ params: expect.any(Object) }),
                expect.any(Object),
                "/test-music/Artist/Album/track.flac",
                "audio/flac"
            );
            expect(mockDestroy).toHaveBeenCalledTimes(1);
            expect(res.headers["content-disposition"]).toContain("attachment;");
            assertOwnership();
        }
    );

    it("GET /api/share-links/access/:token/stream/:trackId on a new session only updates lastStreamedAt", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "track", resourceId: "track-1", lastStreamedAt: null })
        );
        mockTrackFindUnique.mockResolvedValueOnce(makeStreamableTrack());

        await request(app).get(`/api/share-links/access/${TOKEN}/stream/track-1`);

        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        expect(mockShareLinkUpdate).toHaveBeenCalledWith({
            where: { id: "share-1" },
            data: { lastStreamedAt: expect.any(Date) },
        });
    });

    it("GET /api/share-links/access/:token/stream/:trackId on an existing session only updates lastStreamedAt", async () => {
        const recentStream = new Date(Date.now() - 5 * 60 * 1000);
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "track", resourceId: "track-1", lastStreamedAt: recentStream })
        );
        mockTrackFindUnique.mockResolvedValueOnce(makeStreamableTrack());

        await request(app).get(`/api/share-links/access/${TOKEN}/stream/track-1`);

        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        expect(mockShareLinkUpdate).toHaveBeenCalledWith(
            {
                where: { id: "share-1" },
                data: { lastStreamedAt: expect.any(Date) },
            }
        );
    });

    it("GET /api/share-links/access/:token/stream/:trackId after the session window still only updates lastStreamedAt", async () => {
        const oldStream = new Date(Date.now() - 2 * 60 * 60 * 1000);
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "track", resourceId: "track-1", lastStreamedAt: oldStream })
        );
        mockTrackFindUnique.mockResolvedValueOnce(makeStreamableTrack());

        await request(app).get(`/api/share-links/access/${TOKEN}/stream/track-1`);

        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        expect(mockShareLinkUpdate).toHaveBeenCalledWith({
            where: { id: "share-1" },
            data: { lastStreamedAt: expect.any(Date) },
        });
    });

    it("GET /api/share-links/access/:token/stream/:trackId rejects when maxPlays is reached", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "track", resourceId: "track-1", maxPlays: 3, playCount: 3 })
        );

        const res = await request(app).get(`/api/share-links/access/${TOKEN}/stream/track-1`);

        expect(res.status).toBe(404);
        expect(mockShareLinkUpdateMany).not.toHaveBeenCalled();
        expect(mockShareLinkUpdate).not.toHaveBeenCalled();
    });

    it("GET /api/share-links/access/:token returns playlist items without trackTidal or trackYtMusic fields", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "playlist", resourceId: "playlist-1" })
        );
        mockPlaylistFindUnique.mockResolvedValueOnce({
            id: "playlist-1",
            name: "Shared Playlist",
            user: { username: "owner" },
            items: [
                {
                    id: "item-1",
                    sort: 1,
                    track: {
                        id: "track-1",
                        title: "Track One",
                        duration: 180,
                        album: {
                            title: "Album One",
                            coverArt: null,
                            coverUrl: null,
                            artist: { id: "artist-1", name: "Artist One" },
                        },
                    },
                },
            ],
            pendingTracks: [],
        });

        const res = await request(app).get(`/api/share-links/access/${TOKEN}`);

        expect(res.status).toBe(200);
        const item = res.body.resource.items[0];
        expect(item).not.toHaveProperty("trackTidal");
        expect(item).not.toHaveProperty("trackYtMusic");
    });

    it.each([
        "native:../../../etc/passwd",
        "native:../../covers-other/evil.jpg",
        "native:../covers/legitimate.jpg",
    ])(
        "GET /api/share-links/access/:token/cover rejects path traversal attempt: %s",
        async (maliciousUrl) => {
            mockShareLinkFindUnique.mockResolvedValueOnce(
                makeShareLink({ resourceType: "album", resourceId: "album-1" })
            );

            const res = await request(app)
                .get(`/api/share-links/access/${TOKEN}/cover`)
                .query({ url: maliciousUrl });

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: "Cover image not found" });
            expect(mockFetchExternalImage).not.toHaveBeenCalled();
        }
    );

    it("GET /api/share-links/access/:token/cover proxies external cover art without auth", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "album", resourceId: "album-1" })
        );

        const res = await request(app)
            .get(`/api/share-links/access/${TOKEN}/cover`)
            .query({ url: "https://images.example.test/cover.png" });

        expect(res.status).toBe(200);
        expect(mockFetchExternalImage).toHaveBeenCalledWith({
            url: "https://images.example.test/cover.png",
        });
        expect(res.headers["content-type"]).toContain("image/png");
        expect(res.headers["cache-control"]).toBe("public, max-age=3600");
        expect(res.headers.etag).toBe("cover-etag");
        expect(res.body).toEqual(Buffer.from("cover-image"));
    });

    it("GET /api/share-links/access/:token/cover validates the url parameter", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "album", resourceId: "album-1" })
        );

        const res = await request(app).get(`/api/share-links/access/${TOKEN}/cover`);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "Missing url parameter" });
        expect(mockFetchExternalImage).not.toHaveBeenCalled();
    });

    it("GET /api/share-links/access/:token/cover returns 404 when the proxied image is unavailable", async () => {
        mockShareLinkFindUnique.mockResolvedValueOnce(
            makeShareLink({ resourceType: "album", resourceId: "album-1" })
        );
        mockFetchExternalImage.mockResolvedValueOnce({ ok: false });

        const res = await request(app)
            .get(`/api/share-links/access/${TOKEN}/cover`)
            .query({ url: "https://images.example.test/missing.png" });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Cover image not found" });
    });
});
