import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        scanIterator: jest.fn(),
        mGet: jest.fn(),
        set: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        $queryRaw: jest.fn(),
        user: {
            findMany: jest.fn(),
        },
        syncGroupMember: {
            findMany: jest.fn(),
        },
    },
}));

import router from "../social";
import { redisClient } from "../../utils/redis";
import { prisma } from "../../utils/db";

const mockScanIterator = redisClient.scanIterator as jest.Mock;
const mockMGet = redisClient.mGet as jest.Mock;
const mockSet = redisClient.set as jest.Mock;
const mockPrismaQueryRaw = prisma.$queryRaw as jest.Mock;
const mockUserFindMany = prisma.user.findMany as jest.Mock;
const mockSyncGroupMemberFindMany = prisma.syncGroupMember.findMany as jest.Mock;

function asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const item of items) {
                yield item;
            }
        },
    };
}

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) throw new Error(`GET route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getPostHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.post
    );
    if (!layer) throw new Error(`POST route not found: ${path}`);
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

describe("social presence compatibility", () => {
    const onlineHandler = getGetHandler("/online");
    const connectedHandler = getGetHandler("/connected");
    const heartbeatHandler = getPostHandler("/presence/heartbeat");

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaQueryRaw.mockResolvedValue([]);
    });

    it("returns online roster with privacy filtering and listen-together indicator", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable([
                "social:presence:user:user-1",
                "social:presence:user:user-2",
                "social:presence:user:user-3",
            ])
        );
        mockMGet.mockResolvedValue([
            String(now),
            String(now - 1000),
            String(now - 2000),
        ]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: "Alice D",
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        isPlaying: true,
                        updatedAt: new Date(now),
                        queue: [
                            {
                                id: "track-1",
                                title: "Song One",
                                duration: 181,
                                artist: { id: "artist-1", name: "Artist One" },
                                album: {
                                    id: "album-1",
                                    title: "Album One",
                                    coverArt: "cover-1",
                                },
                            },
                        ],
                        currentIndex: 0,
                    },
                ],
            },
            {
                id: "user-2",
                username: "bob",
                displayName: "Bob",
                settings: {
                    shareOnlinePresence: false,
                    shareListeningStatus: true,
                },
                playbackStates: [],
            },
            {
                id: "user-3",
                username: "carol",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: false,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        isPlaying: true,
                        updatedAt: new Date(now),
                        queue: [
                            {
                                id: "track-3",
                                title: "Hidden Song",
                                duration: 200,
                                artist: { name: "Artist Three" },
                                album: { title: "Album Three", coverArt: null },
                            },
                        ],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([
            { userId: "user-1" },
        ]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            users: [
                {
                    id: "user-1",
                    username: "alice",
                    displayName: "Alice D",
                    hasProfilePicture: false,
                    isInListenTogetherGroup: true,
                    listeningStatus: "playing",
                    listeningTrack: {
                        id: "track-1",
                        title: "Song One",
                        duration: 181,
                        artistName: "Artist One",
                        artistId: "artist-1",
                        albumTitle: "Album One",
                        albumId: "album-1",
                        coverArt: "cover-1",
                    },
                    lastHeartbeatAt: expect.any(String),
                },
                {
                    id: "user-3",
                    username: "carol",
                    displayName: "carol",
                    hasProfilePicture: false,
                    isInListenTogetherGroup: false,
                    listeningStatus: "idle",
                    listeningTrack: null,
                    lastHeartbeatAt: expect.any(String),
                },
            ],
        });
    });

    it("returns an empty roster when nobody is online", async () => {
        mockScanIterator.mockReturnValue(asAsyncIterable([]));

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ users: [] });
        expect(mockUserFindMany).not.toHaveBeenCalled();
        expect(mockSyncGroupMemberFindMany).not.toHaveBeenCalled();
    });

    it("returns null listening track when playback queue payload is invalid", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        queue: [
                            {
                                id: "broken-track",
                                title: "Broken",
                                duration: 123,
                                artist: { value: "missing name" },
                                album: { title: "Broken Album" },
                            },
                        ],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            users: [
                expect.objectContaining({
                    id: "user-1",
                    listeningStatus: "idle",
                    listeningTrack: null,
                }),
            ],
        });
    });

    it("falls back to an empty roster when presence scan fails", async () => {
        mockScanIterator.mockImplementation(() => {
            throw new Error("scan failed");
        });

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ users: [] });
    });

    it("ignores malformed presence timestamps", async () => {
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue(["not-a-number"]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ users: [] });
    });

    it("ignores non-string presence keys during scan iteration", async () => {
        mockScanIterator.mockReturnValue(
            asAsyncIterable([123 as unknown as string])
        );

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ users: [] });
    });

    it("returns null listening track when queue is not an array", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        queue: null,
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.users[0].listeningStatus).toBe("idle");
        expect(res.body.users[0].listeningTrack).toBeNull();
    });

    it("returns null listening track when queue entry is not an object", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        queue: [null],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.users[0].listeningStatus).toBe("idle");
        expect(res.body.users[0].listeningTrack).toBeNull();
    });

    it("returns null listening track when artist payload is not an object", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        queue: [
                            {
                                id: "t-1",
                                title: "Song",
                                duration: 120,
                                artist: "bad-payload",
                                album: { title: "Album", coverArt: "cover" },
                            },
                        ],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.users[0].listeningStatus).toBe("idle");
        expect(res.body.users[0].listeningTrack).toBeNull();
    });

    it("returns null listening track when album payload is not an object", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        queue: [
                            {
                                id: "t-1",
                                title: "Song",
                                duration: 120,
                                artist: { name: "Artist" },
                                album: "bad-payload",
                            },
                        ],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.users[0].listeningStatus).toBe("idle");
        expect(res.body.users[0].listeningTrack).toBeNull();
    });

    it("projects valid tracks with paused status and missing heartbeat fallback", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-ghost",
                username: "ghost",
                displayName: "Ghost",
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        isPlaying: false,
                        updatedAt: new Date(now - 2 * 60 * 1000),
                        queue: [
                            {
                                id: "t-ghost",
                                title: "Ghost Song",
                                duration: 140,
                                artist: {
                                    id: "artist-ghost",
                                    name: "Ghost Artist",
                                },
                                album: {
                                    id: "album-ghost",
                                    title: "Ghost Album",
                                    coverArt: null,
                                },
                            },
                        ],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            users: [
                {
                    id: "user-ghost",
                    username: "ghost",
                    displayName: "Ghost",
                    hasProfilePicture: false,
                    isInListenTogetherGroup: false,
                    listeningStatus: "paused",
                    listeningTrack: {
                        id: "t-ghost",
                        title: "Ghost Song",
                        duration: 140,
                        artistName: "Ghost Artist",
                        artistId: "artist-ghost",
                        albumTitle: "Ghost Album",
                        albumId: "album-ghost",
                        coverArt: null,
                    },
                    lastHeartbeatAt: expect.any(String),
                },
            ],
        });
    });

    it("reports idle status when pause age exceeds five minutes", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        isPlaying: false,
                        updatedAt: new Date(now - 6 * 60 * 1000),
                        queue: [
                            {
                                id: "track-1",
                                title: "Song One",
                                duration: 181,
                                artist: { id: "artist-1", name: "Artist One" },
                                album: {
                                    id: "album-1",
                                    title: "Album One",
                                    coverArt: "cover-1",
                                },
                            },
                        ],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.users[0].listeningStatus).toBe("idle");
        expect(res.body.users[0].listeningTrack).toEqual(
            expect.objectContaining({
                id: "track-1",
            })
        );
    });

    it("reports idle status when the playback queue is empty", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
                playbackStates: [
                    {
                        playbackType: "track",
                        isPlaying: true,
                        updatedAt: new Date(now),
                        queue: [],
                        currentIndex: 0,
                    },
                ],
            },
        ]);
        mockSyncGroupMemberFindMany.mockResolvedValue([]);

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.users[0].listeningStatus).toBe("idle");
        expect(res.body.users[0].listeningTrack).toBeNull();
    });

    it("returns all connected users for admins regardless of sharing settings", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable([
                "social:presence:user:user-1",
                "social:presence:user:user-2",
            ])
        );
        mockMGet.mockResolvedValue([String(now), String(now - 1000)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                role: "user",
                settings: {
                    shareOnlinePresence: false,
                    shareListeningStatus: false,
                },
            },
            {
                id: "user-2",
                username: "admin-user",
                displayName: "Admin User",
                role: "admin",
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
            },
        ]);

        const req = {
            user: { id: "admin-1", role: "admin" },
        } as any;
        const res = createRes();

        await connectedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            users: [
                {
                    id: "user-2",
                    username: "admin-user",
                    displayName: "Admin User",
                    hasProfilePicture: false,
                    role: "admin",
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                    lastHeartbeatAt: expect.any(String),
                },
                {
                    id: "user-1",
                    username: "alice",
                    displayName: "alice",
                    hasProfilePicture: false,
                    role: "user",
                    shareOnlinePresence: false,
                    shareListeningStatus: false,
                    lastHeartbeatAt: expect.any(String),
                },
            ],
        });
    });

    it("returns an empty connected list for admins when no users are online", async () => {
        mockScanIterator.mockReturnValue(asAsyncIterable([]));

        const req = {
            user: { id: "admin-1", role: "admin" },
        } as any;
        const res = createRes();

        await connectedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ users: [] });
        expect(mockUserFindMany).not.toHaveBeenCalled();
    });

    it("defaults connected sharing flags to false when settings are missing", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-1",
                username: "alice",
                displayName: null,
                role: "user",
                settings: null,
            },
        ]);

        const req = {
            user: { id: "admin-1", role: "admin" },
        } as any;
        const res = createRes();

        await connectedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            users: [
                {
                    id: "user-1",
                    username: "alice",
                    displayName: "alice",
                    hasProfilePicture: false,
                    role: "user",
                    shareOnlinePresence: false,
                    shareListeningStatus: false,
                    lastHeartbeatAt: expect.any(String),
                },
            ],
        });
    });

    it("uses connected heartbeat timestamp fallback when map entry is missing", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockResolvedValue([
            {
                id: "user-ghost",
                username: "ghost",
                displayName: "Ghost",
                role: "user",
                settings: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
            },
        ]);

        const req = {
            user: { id: "admin-1", role: "admin" },
        } as any;
        const res = createRes();

        await connectedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            users: [
                {
                    id: "user-ghost",
                    username: "ghost",
                    displayName: "Ghost",
                    hasProfilePicture: false,
                    role: "user",
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                    lastHeartbeatAt: expect.any(String),
                },
            ],
        });
    });

    it("rejects connected endpoint for non-admin users", async () => {
        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await connectedHandler(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Forbidden" });
    });

    it("writes presence heartbeat with TTL", async () => {
        mockSet.mockResolvedValue("OK");

        const req = {
            user: { id: "user-1", role: "user" },
        } as any;
        const res = createRes();

        await heartbeatHandler(req, res);

        expect(mockSet).toHaveBeenCalledWith(
            "social:presence:user:user-1",
            expect.any(String),
            { EX: 75 }
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            ttlSeconds: 75,
        });
    });

    it("returns 503 when presence heartbeat storage fails", async () => {
        mockSet.mockRejectedValue(new Error("redis unavailable"));

        const req = {
            user: { id: "user-1", role: "user" },
        } as any;
        const res = createRes();

        await heartbeatHandler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ error: "Presence unavailable" });
    });

    it("returns 500 when online roster query fails", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockRejectedValue(new Error("db down"));

        const req = {
            user: { id: "viewer-1", role: "user" },
        } as any;
        const res = createRes();

        await onlineHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get online users" });
    });

    it("returns 500 when connected users query fails", async () => {
        const now = Date.now();
        mockScanIterator.mockReturnValue(
            asAsyncIterable(["social:presence:user:user-1"])
        );
        mockMGet.mockResolvedValue([String(now)]);
        mockUserFindMany.mockRejectedValue(new Error("db down"));

        const req = {
            user: { id: "admin-1", role: "admin" },
        } as any;
        const res = createRes();

        await connectedHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get connected users" });
    });
});
