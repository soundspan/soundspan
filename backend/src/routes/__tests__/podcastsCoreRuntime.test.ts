import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const prisma = {
    $connect: jest.fn(),
    podcastSubscription: {
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    podcast: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: "podcast-new", title: "Podcast New" })),
        update: jest.fn(async () => ({})),
    },
    podcastEpisode: {
        createMany: jest.fn(async () => ({ count: 0 })),
    },
    podcastProgress: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    podcastDownload: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
    Prisma: {
        PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
            code: string;
            constructor(message: string, code = "P2037") {
                super(message);
                this.code = code;
            }
        },
        PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
        PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
    },
}));

const rssParserService = {
    parseFeed: jest.fn(async () => ({
        podcast: {
            title: "Parsed Podcast",
            author: "Parsed Author",
            description: "Parsed Description",
            imageUrl: "https://img/parsed.jpg",
            itunesId: "itunes-parsed",
            language: "en",
            explicit: false,
        },
        episodes: [] as Record<string, unknown>[],
        feedMetadata: {} as { etag?: string; lastModified?: string },
    })),
};
jest.mock("../../services/rss-parser", () => ({
    rssParserService,
}));

const podcastCacheService = {
    syncAllCovers: jest.fn(async () => ({ synced: 0 })),
    syncEpisodeCovers: jest.fn(async () => ({ synced: 0 })),
};
jest.mock("../../services/podcastCache", () => ({
    podcastCacheService,
}));

const notificationService = {
    notifySystem: jest.fn(async () => undefined),
};
jest.mock("../../services/notificationService", () => ({
    notificationService,
}));

jest.mock("../../utils/rangeParser", () => ({
    parseRangeHeader: jest.fn(),
}));

const mockAxiosGet = jest.fn();
const mockAxiosIsAxiosError = jest.fn();

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: (...args: unknown[]) => mockAxiosGet(...args),
        isAxiosError: (...args: unknown[]) => mockAxiosIsAxiosError(...args),
    },
}));

import router, { refreshPodcastFeed, refreshAllPodcastFeeds } from "../podcasts";

function getHandler(path: string, method: "get" | "post" | "delete") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) throw new Error(`${method.toUpperCase()} route not found: ${path}`);
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

describe("podcasts core runtime behavior", () => {
    const syncCoversHandler = getHandler("/sync-covers", "post");
    const listHandler = getHandler("/", "get");
    const byIdHandler = getHandler("/:id", "get");
    const subscribeHandler = getHandler("/subscribe", "post");
    const unsubscribeHandler = getHandler("/:id/unsubscribe", "delete");
    const refreshHandler = getHandler("/:id/refresh", "get");

    beforeEach(() => {
        jest.clearAllMocks();
        mockAxiosIsAxiosError.mockReturnValue(false);
        (prisma.$connect as jest.Mock).mockResolvedValue(undefined);
        rssParserService.parseFeed.mockResolvedValue({
            podcast: {
                title: "Parsed Podcast",
                author: "Parsed Author",
                description: "Parsed Description",
                imageUrl: "https://img/parsed.jpg",
                itunesId: "itunes-parsed",
                language: "en",
                explicit: false,
            },
            episodes: [],
            feedMetadata: {},
        });
    });

    function mockImmediateTimers() {
        return jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((handler: (...args: any[]) => void) => {
                if (typeof handler === "function") {
                    handler();
                }
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout);
    }

    it("syncs podcast covers and emits a system notification", async () => {
        podcastCacheService.syncAllCovers.mockResolvedValueOnce({ synced: 4 });
        podcastCacheService.syncEpisodeCovers.mockResolvedValueOnce({ synced: 9 });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await syncCoversHandler(req, res);

        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "user-1",
            "Podcast Covers Synced",
            "Synced 4 podcast covers and 9 episode covers"
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            podcasts: { synced: 4 },
            episodes: { synced: 9 },
        });
    });

    it("returns 500 when sync-covers fails", async () => {
        podcastCacheService.syncAllCovers.mockRejectedValueOnce(
            new Error("cache service unavailable")
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await syncCoversHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Sync failed",
        });
    });

    it("maps subscribed podcasts list with episode progress and cover fallbacks", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([
            {
                subscribedAt: new Date("2026-01-01T00:00:00.000Z"),
                podcast: {
                    id: "pod-1",
                    title: "Core Show",
                    author: "Host One",
                    description: "Desc",
                    localCoverPath: "/cache/pod-1.jpg",
                    imageUrl: "https://remote/pod-1.jpg",
                    episodeCount: 2,
                    episodes: [
                        {
                            id: "ep-1",
                            title: "Episode One",
                            description: "Episode Desc",
                            duration: 1000,
                            publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                            localCoverPath: null,
                            imageUrl: "https://remote/ep-1.jpg",
                            progress: [
                                {
                                    currentTime: 250,
                                    duration: 1000,
                                    isFinished: false,
                                    lastPlayedAt: new Date("2026-01-02T00:00:00.000Z"),
                                },
                            ],
                        },
                    ],
                },
            },
        ]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await listHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                id: "pod-1",
                title: "Core Show",
                author: "Host One",
                description: "Desc",
                coverUrl: "/podcasts/pod-1/cover",
                episodeCount: 2,
                autoDownloadEpisodes: false,
                episodes: [
                    {
                        id: "ep-1",
                        title: "Episode One",
                        description: "Episode Desc",
                        duration: 1000,
                        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                        coverUrl: "https://remote/ep-1.jpg",
                        progress: expect.objectContaining({
                            currentTime: 250,
                            progress: 25,
                            isFinished: false,
                        }),
                    },
                ],
            },
        ]);
    });

    it("maps subscribed podcasts list when episodes have no progress and no local covers", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([
            {
                subscribedAt: new Date("2026-01-02T00:00:00.000Z"),
                podcast: {
                    id: "pod-2",
                    title: "Library Show",
                    author: "Library Host",
                    description: "No local media",
                    localCoverPath: null,
                    imageUrl: "https://remote/pod-2.jpg",
                    episodeCount: 1,
                    episodes: [
                        {
                            id: "ep-2",
                            title: "Silent Episode",
                            description: "No playback data",
                            duration: 0,
                            publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                            localCoverPath: null,
                            imageUrl: "https://remote/ep-2.jpg",
                            progress: [],
                        },
                    ],
                },
            },
        ]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await listHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                id: "pod-2",
                title: "Library Show",
                author: "Library Host",
                description: "No local media",
                coverUrl: "https://remote/pod-2.jpg",
                episodeCount: 1,
                autoDownloadEpisodes: false,
                episodes: [
                    {
                        id: "ep-2",
                        title: "Silent Episode",
                        description: "No playback data",
                        duration: 0,
                        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                        coverUrl: "https://remote/ep-2.jpg",
                        progress: null,
                    },
                ],
            },
        ]);
    });

    it("returns 500 when subscribed podcast listing fails", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockRejectedValueOnce(
            new Error("db read failed")
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await listHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch podcasts",
        });
    });

    it("returns 404 for podcast detail requests when user is not subscribed", async () => {
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce(
            null
        );

        const req = { params: { id: "pod-missing" }, user: { id: "user-1" } } as any;
        const res = createRes();
        await byIdHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Podcast not found or not subscribed",
        });
    });

    it("returns full podcast details for subscribed users", async () => {
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-1",
            podcastId: "pod-2",
        });
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-2",
            title: "Deep Dive",
            author: "Host Two",
            description: "Long form",
            imageUrl: "https://remote/pod-2.jpg",
            feedUrl: "https://feed/pod-2.xml",
            episodes: [
                {
                    id: "ep-a",
                    title: "Episode A",
                    description: "A",
                    duration: 1800,
                    publishedAt: new Date("2026-02-01T00:00:00.000Z"),
                    episodeNumber: 1,
                    season: 1,
                    imageUrl: "https://remote/ep-a.jpg",
                    downloads: [{ id: "download-1" }],
                    progress: [
                        {
                            currentTime: 900,
                            duration: 1800,
                            isFinished: false,
                            lastPlayedAt: new Date("2026-02-02T00:00:00.000Z"),
                        },
                    ],
                },
            ],
        });

        const req = { params: { id: "pod-2" }, user: { id: "user-1" } } as any;
        const res = createRes();
        await byIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "pod-2",
                title: "Deep Dive",
                isSubscribed: true,
                episodes: [
                    expect.objectContaining({
                        id: "ep-a",
                        isDownloaded: true,
                        progress: expect.objectContaining({ progress: 50 }),
                    }),
                ],
            })
        );
    });

    it("returns no-progress and not-downloaded flags for episodes without playback/download state", async () => {
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-1",
            podcastId: "pod-3",
        });
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-3",
            title: "Quiet Show",
            author: "Quiet Host",
            description: "No activity yet",
            imageUrl: "https://remote/pod-3.jpg",
            feedUrl: "https://feed/pod-3.xml",
            episodes: [
                {
                    id: "ep-empty",
                    title: "Episode Empty",
                    description: "No state",
                    duration: 1200,
                    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                    episodeNumber: 1,
                    season: null,
                    imageUrl: "https://remote/ep-empty.jpg",
                    downloads: [],
                    progress: [],
                },
            ],
        });

        const req = { params: { id: "pod-3" }, user: { id: "user-1" } } as any;
        const res = createRes();
        await byIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            id: "pod-3",
            title: "Quiet Show",
            author: "Quiet Host",
            description: "No activity yet",
            coverUrl: "https://remote/pod-3.jpg",
            feedUrl: "https://feed/pod-3.xml",
            genres: [],
            autoDownloadEpisodes: false,
            isSubscribed: true,
            episodes: [
                {
                    id: "ep-empty",
                    title: "Episode Empty",
                    description: "No state",
                    duration: 1200,
                    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                    episodeNumber: 1,
                    season: null,
                    imageUrl: "https://remote/ep-empty.jpg",
                    isDownloaded: false,
                    progress: null,
                },
            ],
        });
    });

    it("returns 404 when subscription exists but podcast details are missing", async () => {
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-1",
            podcastId: "pod-ghost",
        });
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce(null);

        const req = {
            params: { id: "pod-ghost" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await byIdHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Podcast not found" });
    });

    it("returns 500 when podcast detail lookup fails unexpectedly", async () => {
        (prisma.podcastSubscription.findUnique as jest.Mock).mockRejectedValueOnce(
            new Error("db error")
        );

        const req = { params: { id: "pod-err" }, user: { id: "user-1" } } as any;
        const res = createRes();
        await byIdHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch podcast",
        });
    });

    it("validates subscribe payload requires feedUrl or itunesId", async () => {
        const req = { body: {}, user: { id: "user-1", username: "alice" } } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "feedUrl or itunesId is required" });
    });

    it("returns already subscribed when podcast exists and subscription is present", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-1",
            title: "Known Podcast",
            feedUrl: "https://feed/known.xml",
        });
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-1",
            podcastId: "pod-1",
        });

        const req = {
            body: { feedUrl: "https://feed/known.xml" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(prisma.podcastSubscription.create).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            podcast: {
                id: "pod-1",
                title: "Known Podcast",
            },
            message: "Already subscribed",
        });
    });

    it("subscribes user to existing podcast when not yet subscribed", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-2",
            title: "Existing Podcast",
            feedUrl: "https://feed/existing.xml",
        });
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce(
            null
        );

        const req = {
            body: { feedUrl: "https://feed/existing.xml" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(prisma.podcastSubscription.create).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                podcastId: "pod-2",
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            podcast: {
                id: "pod-2",
                title: "Existing Podcast",
            },
            message: "Subscribed successfully",
        });
    });

    it("returns 500 when direct feed parsing fails during subscribe", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce(null);
        rssParserService.parseFeed.mockRejectedValueOnce(
            new Error("invalid rss")
        );

        const req = {
            body: { feedUrl: "https://feed/invalid-rss.xml" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(prisma.podcast.create).not.toHaveBeenCalled();
        expect(prisma.podcastEpisode.createMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to subscribe to podcast",
        });
    });

    it("rejects unsafe feed urls during subscribe before parsing or persistence", async () => {
        const req = {
            body: { feedUrl: "http://127.0.0.1/private-feed.xml" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(prisma.podcast.findUnique).not.toHaveBeenCalled();
        expect(rssParserService.parseFeed).not.toHaveBeenCalled();
        expect(prisma.podcast.create).not.toHaveBeenCalled();
        expect(prisma.podcastEpisode.createMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid or private feed URL",
        });
    });

    it("subscribes via iTunes lookup when feedUrl is not provided", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                resultCount: 1,
                results: [{ feedUrl: "https://feed/from-itunes.xml" }],
            },
        });
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce(null);
        (rssParserService.parseFeed as jest.Mock).mockResolvedValueOnce({
            podcast: {
                title: "Parsed Podcast",
                author: "Parsed Host",
                description: "Parsed Desc",
                imageUrl: "https://img/parsed.jpg",
                itunesId: "itunes-from-feed",
                language: "en",
                explicit: false,
            },
            episodes: [
                {
                    guid: "ep-1",
                    title: "Episode One",
                    description: "Desc",
                    audioUrl: "https://audio/ep-1.mp3",
                    duration: 100,
                    publishedAt: new Date("2026-02-01T00:00:00.000Z"),
                    episodeNumber: 1,
                    season: 1,
                    imageUrl: "https://img/ep-1.jpg",
                    fileSize: 1024,
                    mimeType: "audio/mpeg",
                },
            ],
        });
        (prisma.podcast.create as jest.Mock).mockResolvedValueOnce({
            id: "pod-new-1",
            title: "Parsed Podcast",
            itunesId: "itunes-4455",
        });

        const req = {
            body: { itunesId: "4455" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/lookup",
            expect.objectContaining({
                params: { id: "4455", entity: "podcast" },
            })
        );
        expect(prisma.podcast.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    feedUrl: "https://feed/from-itunes.xml",
                    title: "Parsed Podcast",
                    episodeCount: 1,
                }),
            })
        );
        expect(prisma.podcastEpisode.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [expect.objectContaining({ guid: "ep-1" })],
                skipDuplicates: true,
            })
        );
        expect(prisma.podcastSubscription.create).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                podcastId: "pod-new-1",
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            podcast: {
                id: "pod-new-1",
                title: "Parsed Podcast",
            },
            message: "Subscribed successfully",
        });
    });

    it("persists parser feed metadata on subscribe", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce(null);
        (rssParserService.parseFeed as jest.Mock).mockResolvedValueOnce({
            podcast: {
                title: "Metadata Podcast",
                author: "Metadata Host",
                description: "Metadata Desc",
                imageUrl: "https://img/meta.jpg",
                itunesId: "itunes-meta",
                language: "en",
                explicit: false,
            },
            episodes: [],
            etag: '"feed-etag-1"',
            lastModified: "Mon, 02 Feb 2026 00:00:00 GMT",
        });
        (prisma.podcast.create as jest.Mock).mockResolvedValueOnce({
            id: "pod-meta-1",
            title: "Metadata Podcast",
        });

        const req = {
            body: { feedUrl: "https://feed/metadata.xml" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(prisma.podcast.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    feedUrl: "https://feed/metadata.xml",
                    feedEtag: '"feed-etag-1"',
                    feedLastModified: "Mon, 02 Feb 2026 00:00:00 GMT",
                }),
            })
        );
        expect(res.statusCode).toBe(200);
    });

    it("rejects private feed urls returned from iTunes lookup during subscribe", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                resultCount: 1,
                results: [{ feedUrl: "http://127.0.0.1/private-feed.xml" }],
            },
        });

        const req = {
            body: { itunesId: "6677" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/lookup",
            expect.objectContaining({
                params: { id: "6677", entity: "podcast" },
            })
        );
        expect(prisma.podcast.findUnique).not.toHaveBeenCalled();
        expect(rssParserService.parseFeed).not.toHaveBeenCalled();
        expect(prisma.podcast.create).not.toHaveBeenCalled();
        expect(prisma.podcastEpisode.createMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid or private feed URL",
        });
    });

    it("returns 404 when iTunes lookup cannot resolve a feed url for subscribe", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                resultCount: 0,
                results: [],
            },
        });

        const req = {
            body: { itunesId: "9988" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Podcast not found in iTunes" });
    });

    it("returns 500 when subscribe iTunes lookup fails", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("itunes lookup failed"));

        const req = {
            body: { itunesId: "4455" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await subscribeHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to subscribe to podcast",
        });
    });

    it("returns 404 when unsubscribe is requested without an active subscription", async () => {
        (prisma.podcastSubscription.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 0,
        });

        const req = {
            params: { id: "pod-404" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await unsubscribeHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Not subscribed to this podcast" });
    });

    it("removes subscription, progress, and downloads on successful unsubscribe", async () => {
        (prisma.podcastSubscription.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 1,
        });

        const req = {
            params: { id: "pod-9" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await unsubscribeHandler(req, res);

        expect(prisma.podcastProgress.deleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                episode: {
                    podcastId: "pod-9",
                },
            },
        });
        expect(prisma.podcastDownload.deleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                episode: {
                    podcastId: "pod-9",
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Unsubscribed successfully",
        });
    });

    it("returns 500 when unsubscribe cleanup fails", async () => {
        (prisma.podcastSubscription.deleteMany as jest.Mock).mockRejectedValueOnce(
            new Error("unsubscribe failed")
        );

        const req = {
            params: { id: "pod-err" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const res = createRes();

        await unsubscribeHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to unsubscribe",
        });
    });

    it("returns 404 from refresh route when podcast does not exist", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce(null);

        const req = {
            params: { id: "pod-missing" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await refreshHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Podcast not found" });
    });

    it("refreshes a podcast and reports new episode count", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-refresh-1",
            feedUrl: "https://feed/refresh.xml",
        });
        (rssParserService.parseFeed as jest.Mock).mockResolvedValueOnce({
            podcast: {
                title: "Refresh Show",
                author: "Refresh Host",
                description: "Updated Desc",
                imageUrl: "https://img/refresh.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [
                {
                    guid: "refresh-ep-1",
                    title: "Refresh Episode",
                    description: "Desc",
                    audioUrl: "https://audio/refresh-1.mp3",
                    duration: 200,
                    publishedAt: new Date("2026-02-01T00:00:00.000Z"),
                    episodeNumber: 2,
                    season: 1,
                    imageUrl: "https://img/re-1.jpg",
                    fileSize: 2048,
                    mimeType: "audio/mpeg",
                },
            ],
        });
        (prisma.podcastEpisode.createMany as jest.Mock).mockResolvedValueOnce({
            count: 1,
        });

        const req = {
            params: { id: "pod-refresh-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await refreshHandler(req, res);

        expect(prisma.podcast.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "pod-refresh-1" },
                data: expect.objectContaining({
                    title: "Refresh Show",
                    episodeCount: 1,
                }),
            })
        );
        expect(prisma.podcastEpisode.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [expect.objectContaining({ guid: "refresh-ep-1" })],
                skipDuplicates: true,
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            newEpisodesCount: 1,
            totalEpisodes: 1,
            message: "Found 1 new episodes",
        });
    });

    it("returns 500 from refresh route when refresh processing fails unexpectedly", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockReset().mockResolvedValueOnce({
            id: "pod-refresh-fail",
            feedUrl: "https://feed/refresh-fail.xml",
        });
        (rssParserService.parseFeed as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(new Error("refresh parse failed"));

        const req = {
            params: { id: "pod-refresh-fail" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await refreshHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to refresh podcast",
        });
    });

    it("refreshes successfully with empty feed episodes and skips createMany", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockReset().mockResolvedValueOnce({
            id: "pod-refresh-empty",
            feedUrl: "https://feed/refresh-empty.xml",
        });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            podcast: {
                title: "Refresh Empty",
                author: "Refresh Host",
                description: "Updated Desc",
                imageUrl: "https://img/refresh-empty.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
        });

        const req = {
            params: { id: "pod-refresh-empty" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await refreshHandler(req, res);

        expect(prisma.podcastEpisode.createMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            newEpisodesCount: 0,
            totalEpisodes: 0,
            message: "Found 0 new episodes",
        });
    });

    it("sends conditional refresh metadata and updates stored metadata on success", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockReset().mockResolvedValueOnce({
            id: "pod-refresh-conditional",
            feedUrl: "https://feed/conditional.xml",
            feedEtag: '"stored-etag"',
            feedLastModified: "Mon, 02 Feb 2026 00:00:00 GMT",
        });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            podcast: {
                title: "Conditional Show",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/conditional.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
            etag: '"new-etag"',
            lastModified: "Tue, 03 Feb 2026 00:00:00 GMT",
        });

        await refreshPodcastFeed("pod-refresh-conditional");

        expect(rssParserService.parseFeed).toHaveBeenCalledWith(
            "https://feed/conditional.xml",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "if-none-match": '"stored-etag"',
                    "if-modified-since": "Mon, 02 Feb 2026 00:00:00 GMT",
                }),
            })
        );
        expect(prisma.podcast.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "pod-refresh-conditional" },
                data: expect.objectContaining({
                    feedEtag: '"new-etag"',
                    feedLastModified: "Tue, 03 Feb 2026 00:00:00 GMT",
                }),
            })
        );
    });

    it("handles not-modified refreshes without creating episodes and still updates lastRefreshed", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockReset().mockResolvedValueOnce({
            id: "pod-refresh-not-modified",
            feedUrl: "https://feed/not-modified.xml",
            feedEtag: '"stored-etag"',
            feedLastModified: "Mon, 02 Feb 2026 00:00:00 GMT",
        });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            notModified: true,
            podcast: {
                title: "Not Modified Show",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/not-modified.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [
                {
                    guid: "not-modified-ep-1",
                    title: "Should Not Be Inserted",
                    description: "Desc",
                    audioUrl: "https://audio/not-modified-1.mp3",
                    duration: 210,
                    publishedAt: new Date("2026-02-04T00:00:00.000Z"),
                    episodeNumber: 1,
                    season: 1,
                    imageUrl: "https://img/not-modified-1.jpg",
                    fileSize: 512,
                    mimeType: "audio/mpeg",
                },
            ],
        });

        await refreshPodcastFeed("pod-refresh-not-modified");

        expect(prisma.podcastEpisode.createMany).not.toHaveBeenCalled();
        expect(prisma.podcast.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "pod-refresh-not-modified" },
                data: expect.objectContaining({
                    lastRefreshed: expect.any(Date),
                }),
            })
        );
    });

    it("keeps refresh route success payload stable for metadata-aware refreshes", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockReset().mockResolvedValueOnce({
            id: "pod-refresh-stable-payload",
            feedUrl: "https://feed/stable.xml",
            feedEtag: '"stored-etag"',
            feedLastModified: "Mon, 02 Feb 2026 00:00:00 GMT",
        });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            podcast: {
                title: "Stable Payload Show",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/stable.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
            etag: '"new-etag"',
            lastModified: "Tue, 03 Feb 2026 00:00:00 GMT",
        });

        const req = {
            params: { id: "pod-refresh-stable-payload" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await refreshHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            newEpisodesCount: 0,
            totalEpisodes: 0,
            message: "Found 0 new episodes",
        });
    });

    it("retries refresh lookup on Prisma rust panic errors", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        const rustPanic = new Prisma.PrismaClientRustPanicError("panic");

        (prisma.podcast.findUnique as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(rustPanic)
            .mockResolvedValueOnce({
                id: "pod-refresh-rust",
                feedUrl: "https://feed/refresh-rust.xml",
            });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            podcast: {
                title: "Refresh Rust",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/refresh-rust.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
        });

        await expect(refreshPodcastFeed("pod-refresh-rust")).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 0,
        });
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("retries refresh lookup on unknown Prisma request errors", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        const unknownTransient = new Prisma.PrismaClientUnknownRequestError(
            "Engine has already exited"
        );

        (prisma.podcast.findUnique as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(unknownTransient)
            .mockResolvedValueOnce({
                id: "pod-refresh-unknown",
                feedUrl: "https://feed/refresh-unknown.xml",
            });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            podcast: {
                title: "Refresh Unknown",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/refresh-unknown.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
        });

        await expect(refreshPodcastFeed("pod-refresh-unknown")).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 0,
        });
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("retries refresh lookup on retryable Prisma known request errors", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        const transientKnownError = new Prisma.PrismaClientKnownRequestError(
            "database temporarily unavailable",
            "P1001"
        );

        (prisma.podcast.findUnique as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(transientKnownError)
            .mockResolvedValueOnce({
                id: "pod-refresh-known",
                feedUrl: "https://feed/refresh-known.xml",
            });

        await expect(refreshPodcastFeed("pod-refresh-known")).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 0,
        });
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("gives up after max retry attempts for persistent retryable Prisma errors", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        const transientKnownError = new Prisma.PrismaClientKnownRequestError(
            "database still unavailable",
            "P1002"
        );

        (prisma.podcast.findUnique as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(transientKnownError)
            .mockRejectedValueOnce(transientKnownError)
            .mockRejectedValueOnce(transientKnownError);

        await expect(
            refreshPodcastFeed("pod-refresh-giveup")
        ).rejects.toThrow("database still unavailable");
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
        expect(prisma.podcast.findUnique).toHaveBeenCalledTimes(3);
        setTimeoutSpy.mockRestore();
    });

    it("retries refresh lookup on generic connection-reset errors", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        (prisma.podcast.findUnique as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(new Error("Connection reset"))
            .mockResolvedValueOnce({
                id: "pod-refresh-generic",
                feedUrl: "https://feed/refresh-generic.xml",
            });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            podcast: {
                title: "Refresh Generic",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/refresh-generic.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
        });

        await expect(refreshPodcastFeed("pod-refresh-generic")).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 0,
        });
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("retries refresh lookup on database connectivity message errors", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        (prisma.podcast.findUnique as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(new Error("Can't reach database server"))
            .mockResolvedValueOnce({
                id: "pod-refresh-db",
                feedUrl: "https://feed/refresh-db.xml",
            });
        (rssParserService.parseFeed as jest.Mock).mockReset().mockResolvedValueOnce({
            podcast: {
                title: "Refresh DB",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/refresh-db.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
        });

        await expect(refreshPodcastFeed("pod-refresh-db")).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 0,
        });
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("does not retry non-retryable Prisma known errors in refresh lookup", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        const nonRetryable = new Prisma.PrismaClientKnownRequestError(
            "constraint",
            "P2002"
        );
        (prisma.podcast.findUnique as jest.Mock)
            .mockReset()
            .mockRejectedValueOnce(nonRetryable);

        await expect(refreshPodcastFeed("pod-refresh-nonretry")).rejects.toThrow(
            "constraint"
        );
        expect(prisma.$connect).not.toHaveBeenCalled();
    });

    it("refreshes all subscribed podcasts and reports per-feed results", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([
            { podcastId: "pod-a" },
            { podcastId: "pod-b" },
        ]);

        // pod-a: successful refresh with 2 new episodes
        (prisma.podcast.findUnique as jest.Mock)
            .mockResolvedValueOnce({
                id: "pod-a",
                feedUrl: "https://feed/a.xml",
                feedEtag: null,
                feedLastModified: null,
                episodeCount: 5,
                title: "Podcast A",
            })
            // pod-b: successful refresh with 0 new
            .mockResolvedValueOnce({
                id: "pod-b",
                feedUrl: "https://feed/b.xml",
                feedEtag: '"etag-b"',
                feedLastModified: null,
                episodeCount: 3,
                title: "Podcast B",
            });

        rssParserService.parseFeed
            .mockResolvedValueOnce({
                podcast: {
                    title: "Podcast A",
                    author: "Author A",
                    description: "Desc A",
                    imageUrl: "https://img/a.jpg",
                    itunesId: "itunes-a",
                    language: "en",
                    explicit: false,
                },
                episodes: [
                    { guid: "ep-a1", title: "A-1", audioUrl: "https://audio/a1.mp3" },
                    { guid: "ep-a2", title: "A-2", audioUrl: "https://audio/a2.mp3" },
                ],
                feedMetadata: {},
            })
            .mockResolvedValueOnce({
                podcast: {
                    title: "Podcast B",
                    author: "Author B",
                    description: "Desc B",
                    imageUrl: "https://img/b.jpg",
                    itunesId: "itunes-b",
                    language: "en",
                    explicit: false,
                },
                episodes: [],
                feedMetadata: { etag: '"etag-b-new"' },
            });

        (prisma.podcastEpisode.createMany as jest.Mock)
            .mockResolvedValueOnce({ count: 2 })
            .mockResolvedValueOnce({ count: 0 });

        const result = await refreshAllPodcastFeeds("user-1");

        expect(result.total).toBe(2);
        expect(result.results).toHaveLength(2);
        expect(result.results[0]).toEqual(
            expect.objectContaining({ podcastId: "pod-a", success: true, newEpisodesCount: 2 })
        );
        expect(result.results[1]).toEqual(
            expect.objectContaining({ podcastId: "pod-b", success: true, newEpisodesCount: 0 })
        );
    });

    it("reports per-feed failures without aborting other refreshes", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([
            { podcastId: "pod-ok" },
            { podcastId: "pod-broken" },
        ]);

        // pod-ok refreshes successfully
        (prisma.podcast.findUnique as jest.Mock)
            .mockResolvedValueOnce({
                id: "pod-ok",
                feedUrl: "https://feed/ok.xml",
                feedEtag: null,
                feedLastModified: null,
                episodeCount: 0,
                title: "Good Show",
            })
            // pod-broken: findUnique returns null -> will throw "not found"
            .mockResolvedValueOnce(null);

        rssParserService.parseFeed.mockResolvedValueOnce({
            podcast: {
                title: "Good Show",
                author: "GS",
                description: "D",
                imageUrl: "",
                itunesId: "itunes-gs",
                language: "en",
                explicit: false,
            },
            episodes: [],
            feedMetadata: {},
        });

        const result = await refreshAllPodcastFeeds("user-1");

        expect(result.total).toBe(2);
        expect(result.results[0]).toEqual(
            expect.objectContaining({ podcastId: "pod-ok", success: true })
        );
        expect(result.results[1]).toEqual(
            expect.objectContaining({
                podcastId: "pod-broken",
                success: false,
                error: expect.stringMatching(/not found/),
            })
        );
    });

    it("returns empty results when user has no subscriptions", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([]);

        const result = await refreshAllPodcastFeeds("user-1");

        expect(result.total).toBe(0);
        expect(result.results).toEqual([]);
    });
});
