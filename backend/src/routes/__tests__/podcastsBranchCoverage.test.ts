import type { Request, Response } from "express";

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
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: "pod-new", title: "New Podcast" })),
        update: jest.fn(async () => ({})),
    },
    podcastEpisode: {
        createMany: jest.fn(async () => ({ count: 0 })),
        findUnique: jest.fn(async () => null),
    },
    podcastProgress: {
        upsert: jest.fn(async () => ({ currentTime: 0, duration: 0, isFinished: false })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    podcastRecommendation: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 0 })),
    },
    podcastDownload: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
};

class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code = "P2037") {
        super(message);
        this.code = code;
    }
}

jest.mock("../../utils/db", () => ({
    prisma,
    Prisma: {
        PrismaClientKnownRequestError,
        PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
        PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
    },
}));

class MockRSSFeedNotModifiedError extends Error {
    etag?: string;
    lastModified?: string;
    constructor(message: string, metadata: { etag?: string; lastModified?: string } = {}) {
        super(message);
        this.etag = metadata.etag;
        this.lastModified = metadata.lastModified;
    }
}

const rssParserService = {
    parseFeed: jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>(async () => ({
        podcast: {
            title: "Parsed Podcast",
            author: "Parsed Host",
            description: "Parsed Description",
            imageUrl: "https://img/parsed.jpg",
            itunesId: "itunes-parsed",
            language: "en",
            explicit: false,
        },
        episodes: [],
        feedMetadata: {},
    })),
};

jest.mock("../../services/rss-parser", () => ({
    rssParserService,
    RSSFeedNotModifiedError: MockRSSFeedNotModifiedError,
}));

jest.mock("../../services/podcastCache", () => ({
    podcastCacheService: {
        syncAllCovers: jest.fn(async () => ({ synced: 0 })),
        syncEpisodeCovers: jest.fn(async () => ({ synced: 0 })),
    },
}));

const notificationService = {
    notifySystem: jest.fn(async () => undefined),
};
jest.mock("../../services/notificationService", () => ({
    notificationService,
}));

const getCachedFilePath = jest.fn<Promise<string | null>, [string]>(
    async () => null
);
const isDownloading = jest.fn<boolean, [string]>(() => false);
const getDownloadProgress = jest.fn<
    { progress: number } | null,
    [string]
>(() => null);
const downloadInBackground = jest.fn<void, [string, string, string]>();
jest.mock("../../services/podcastDownload", () => ({
    getCachedFilePath: (episodeId: string) => getCachedFilePath(episodeId),
    isDownloading: (episodeId: string) => isDownloading(episodeId),
    getDownloadProgress: (episodeId: string) => getDownloadProgress(episodeId),
    downloadInBackground: (episodeId: string, audioUrl: string, userId: string) =>
        downloadInBackground(episodeId, audioUrl, userId),
}));

const getSimilarPodcasts = jest.fn<
    Promise<unknown[]>,
    [string, string | undefined, string | undefined]
>(async () => []);
jest.mock("../../services/itunes", () => ({
    itunesService: {
        getSimilarPodcasts: (title: string, description?: string, author?: string) =>
            getSimilarPodcasts(title, description, author),
    },
}));

const normalizeSafeOutboundUrl = jest.fn((url?: string) => url ?? null);
jest.mock("../../services/outboundUrlSafety", () => ({
    normalizeSafeOutboundUrl: (url?: string) => normalizeSafeOutboundUrl(url),
}));

jest.mock("../../utils/rangeParser", () => ({
    parseRangeHeader: jest.fn(),
}));

const mockAxiosGet = jest.fn();
const mockAxiosHead = jest.fn();
const mockAxiosIsAxiosError = jest.fn();
const mockAxiosIsCancel = jest.fn();

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: (...args: unknown[]) => mockAxiosGet(...args),
        head: (...args: unknown[]) => mockAxiosHead(...args),
        isAxiosError: (...args: unknown[]) => mockAxiosIsAxiosError(...args),
        isCancel: (...args: unknown[]) => mockAxiosIsCancel(...args),
    },
}));

import router, { refreshPodcastFeed } from "../podcasts";

type RouteMethod = "get" | "post" | "delete";
type RouteLayer = {
    route?: {
        path?: string;
        methods?: Partial<Record<RouteMethod, boolean>>;
        stack: Array<{ handle: (req: unknown, res: MockRes) => Promise<void> }>;
    };
};

type MockRes = {
    statusCode: number;
    body: unknown;
    headers: Record<string, unknown>;
    status: jest.Mock;
    json: jest.Mock;
    set: jest.Mock;
    end: jest.Mock;
};

function getHandler(path: string, method: RouteMethod) {
    const stack = (router as unknown as { stack: RouteLayer[] }).stack;
    const layer = stack.find(
        (entry) => entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    const route = layer.route as NonNullable<RouteLayer["route"]>;
    return route.stack[route.stack.length - 1].handle;
}

function createRes(): MockRes {
    const headers: Record<string, unknown> = {};
    const res = {} as MockRes;
    res.statusCode = 200;
    res.body = undefined;
    res.headers = headers;
    res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((payload: unknown) => {
        res.body = payload;
        return res;
    });
    res.set = jest.fn((obj: Record<string, unknown>) => {
        Object.assign(headers, obj);
        return res;
    });
    res.end = jest.fn(() => res);
    return res;
}

describe("podcasts branch coverage additions", () => {
    const syncCoversHandler = getHandler("/sync-covers", "post");
    const listHandler = getHandler("/", "get");
    const discoverTopHandler = getHandler("/discover/top", "get");
    const discoverGenrePaginatedHandler = getHandler("/discover/genre/:genreId", "get");
    const previewHandler = getHandler("/preview/:itunesId", "get");
    const subscribeHandler = getHandler("/subscribe", "post");
    const byIdHandler = getHandler("/:id", "get");
    const cacheStatusHandler = getHandler("/:podcastId/episodes/:episodeId/cache-status", "get");
    const progressHandler = getHandler("/:podcastId/episodes/:episodeId/progress", "post");
    const similarHandler = getHandler("/:id/similar", "get");
    const refreshAllHandler = getHandler("/refresh-all", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.$connect as jest.Mock).mockResolvedValue(undefined);
        normalizeSafeOutboundUrl.mockImplementation((url?: string) => url ?? null);
        mockAxiosIsAxiosError.mockReturnValue(false);
        mockAxiosIsCancel.mockReturnValue(false);
        getCachedFilePath.mockResolvedValue(null);
        isDownloading.mockReturnValue(false);
        getDownloadProgress.mockReturnValue(null);
        getSimilarPodcasts.mockResolvedValue([]);
        (prisma.podcastRecommendation.findMany as jest.Mock).mockResolvedValue([]);
    });

    it("sync-covers notification uses zero defaults when sync counts are missing", async () => {
        const req = { user: { id: "u1" } } as unknown;
        const res = createRes();
        await syncCoversHandler(req, res);

        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "u1",
            "Podcast Covers Synced",
            "Synced 0 podcast covers and 0 episode covers"
        );
        expect(res.statusCode).toBe(200);
    });

    it("list route maps local episode cover and zero-duration progress branch", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([
            {
                podcast: {
                    id: "pod-l1",
                    title: "List Show",
                    author: "Host",
                    description: "Desc",
                    localCoverPath: null,
                    imageUrl: "https://img/pod.jpg",
                    episodeCount: 1,
                    episodes: [
                        {
                            id: "ep-l1",
                            title: "Episode",
                            description: "Episode desc",
                            duration: 0,
                            publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                            localCoverPath: "/cache/ep-l1.jpg",
                            imageUrl: "https://img/ep.jpg",
                            progress: [
                                {
                                    currentTime: 42,
                                    duration: 0,
                                    isFinished: false,
                                    lastPlayedAt: new Date("2026-01-02T00:00:00.000Z"),
                                },
                            ],
                        },
                    ],
                },
            },
        ]);

        const req = { user: { id: "u1" } } as unknown;
        const res = createRes();
        await listHandler(req, res);

        const body = res.body as Array<{ episodes: Array<{ coverUrl: string; progress: { progress: number } }> }>;
        expect(res.statusCode).toBe(200);
        expect(body[0].episodes[0].coverUrl).toBe("/podcasts/episodes/ep-l1/cover");
        expect(body[0].episodes[0].progress.progress).toBe(0);
    });

    it("returns [] when discover/top receives axios error with HTTP status", async () => {
        mockAxiosGet.mockRejectedValueOnce({
            code: "ECONNABORTED",
            message: "timeout",
            response: { status: 503 },
        });
        mockAxiosIsAxiosError.mockReturnValue(true);

        const req = { query: { limit: "25" }, user: { id: "u1" } } as unknown;
        const res = createRes();
        await discoverTopHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("uses fallback search term for unknown paginated genre ids", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: { results: [] },
        });

        const req = {
            params: { genreId: "9999" },
            query: { limit: "2", offset: "0" },
            user: { id: "u1" },
        } as unknown;
        const res = createRes();
        await discoverGenrePaginatedHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/search",
            expect.objectContaining({
                params: expect.objectContaining({ term: "podcast" }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("preview skips RSS parsing when feedUrl is missing", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 1234,
                        collectionName: "No Feed Show",
                        artistName: "No Feed Host",
                        artworkUrl100: "https://img/no-feed.jpg",
                        feedUrl: "",
                        genres: [],
                        trackCount: 1,
                    },
                ],
            },
        });

        const req = { params: { itunesId: "1234" }, user: { id: "u1" } } as unknown;
        const res = createRes();
        await previewHandler(req, res);

        expect(rssParserService.parseFeed).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                description: "",
                previewEpisodes: [],
                isSubscribed: false,
                subscribedPodcastId: null,
            })
        );
    });

    it("preview maps missing track count and episode duration defaults", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 1001,
                        collectionName: "Defaults Show",
                        artistName: "Host",
                        artworkUrl100: "https://img/defaults.jpg",
                        feedUrl: "https://feed/defaults.xml",
                        genres: [],
                    },
                ],
            },
        });
        rssParserService.parseFeed.mockResolvedValueOnce({
            podcast: { description: "Defaults desc" },
            episodes: [{ title: "No duration", publishedAt: "2026-02-01" }],
        });

        const req = { params: { itunesId: "1001" }, user: { id: "u1" } } as unknown;
        const res = createRes();
        await previewHandler(req, res);

        const body = res.body as {
            episodeCount: number;
            previewEpisodes: Array<{ duration: number }>;
        };
        expect(body.episodeCount).toBe(0);
        expect(body.previewEpisodes[0].duration).toBe(0);
    });

    it("preview reports unsubscribed when podcast exists but user has no subscription", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 7788,
                        collectionName: "Existing Podcast",
                        artistName: "Host",
                        artworkUrl100: "https://img/p.jpg",
                        feedUrl: "https://feed/existing.xml",
                        genres: ["Tech"],
                        trackCount: 20,
                    },
                ],
            },
        });
        (prisma.podcast.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "pod-7788",
            feedUrl: "https://feed/existing.xml",
        });
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce(null);
        rssParserService.parseFeed.mockResolvedValueOnce({
            podcast: { description: "Preview description" },
            episodes: [{ title: "One", duration: 12, publishedAt: "2026-01-01" }],
        });

        const req = { params: { itunesId: "7788" }, user: { id: "u1" } } as unknown;
        const res = createRes();
        await previewHandler(req, res);

        const body = res.body as { isSubscribed: boolean; subscribedPodcastId: string | null };
        expect(res.statusCode).toBe(200);
        expect(body.isSubscribed).toBe(false);
        expect(body.subscribedPodcastId).toBeNull();
    });

    it("subscribe persists nested feed metadata and parser-derived iTunes id", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce(null);
        rssParserService.parseFeed.mockResolvedValueOnce({
            podcast: {
                title: "Nested Meta Show",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/nested.jpg",
                itunesId: "itunes-from-parser",
                language: "en",
                explicit: true,
            },
            episodes: [],
            feedMetadata: {
                etag: '"nested-etag"',
                lastModified: "Wed, 04 Mar 2026 00:00:00 GMT",
            },
        });
        (prisma.podcast.create as jest.Mock).mockResolvedValueOnce({
            id: "pod-nested",
            title: "Nested Meta Show",
            itunesId: "itunes-from-parser",
        });

        const req = {
            body: { feedUrl: "https://feed/nested.xml" },
            user: { id: "u1", username: "alice" },
        } as unknown;
        const res = createRes();
        await subscribeHandler(req, res);

        expect(prisma.podcast.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    itunesId: "itunes-from-parser",
                    explicit: true,
                    feedEtag: '"nested-etag"',
                    feedLastModified: "Wed, 04 Mar 2026 00:00:00 GMT",
                }),
            })
        );
        expect(res.statusCode).toBe(200);
    });

    it("podcast detail maps progress percentage to 0 when duration is zero", async () => {
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "u1",
            podcastId: "pod-zero",
        });
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-zero",
            title: "Zero Duration Podcast",
            author: "Host",
            description: "Desc",
            imageUrl: "https://img/pod.jpg",
            feedUrl: "https://feed/pod.xml",
            episodes: [
                {
                    id: "ep-zero",
                    title: "Zero",
                    description: "Desc",
                    duration: 0,
                    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
                    episodeNumber: 1,
                    season: 1,
                    imageUrl: "https://img/ep.jpg",
                    downloads: [],
                    progress: [
                        {
                            currentTime: 33,
                            duration: 0,
                            isFinished: false,
                            lastPlayedAt: new Date("2026-01-01T00:00:00.000Z"),
                        },
                    ],
                },
            ],
        });

        const req = { params: { id: "pod-zero" }, user: { id: "u1" } } as unknown;
        const res = createRes();
        await byIdHandler(req, res);

        const body = res.body as { episodes: Array<{ progress: { progress: number } }> };
        expect(res.statusCode).toBe(200);
        expect(body.episodes[0].progress).toEqual(
            expect.objectContaining({ progress: 0 })
        );
    });

    it("cache-status returns null progress and false path when uncached", async () => {
        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-1" },
            user: { id: "u1" },
        } as unknown;
        const res = createRes();

        await cacheStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            episodeId: "ep-1",
            cached: false,
            downloading: false,
            downloadProgress: null,
            path: false,
        });
    });

    it("similar route passes undefined description and author when missing", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-sim",
            title: "Similar Show",
            description: null,
            author: null,
        });
        getSimilarPodcasts.mockResolvedValueOnce([]);

        const req = { params: { id: "pod-sim" } } as unknown;
        const res = createRes();
        await similarHandler(req, res);

        expect(getSimilarPodcasts).toHaveBeenCalledWith(
            "Similar Show",
            undefined,
            undefined
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("progress update defaults isFinished to false and progress to 0 when duration is zero", async () => {
        (prisma.podcastProgress.upsert as jest.Mock).mockResolvedValueOnce({
            currentTime: 10,
            duration: 0,
            isFinished: false,
        });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-1" },
            body: { currentTime: 10, duration: 0 },
            user: { id: "u1", username: "alice" },
        } as unknown;
        const res = createRes();
        await progressHandler(req, res);

        const body = res.body as { progress: { progress: number } };
        expect(prisma.podcastProgress.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ isFinished: false }),
                update: expect.objectContaining({ isFinished: false }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(body.progress.progress).toBe(0);
    });

    it("progress update returns finished state when isFinished is true", async () => {
        (prisma.podcastProgress.upsert as jest.Mock).mockResolvedValueOnce({
            currentTime: 100,
            duration: 100,
            isFinished: true,
        });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-2" },
            body: { currentTime: 100, duration: 100, isFinished: true },
            user: { id: "u1", username: "alice" },
        } as unknown;
        const res = createRes();
        await progressHandler(req, res);

        const body = res.body as {
            progress: { currentTime: number; progress: number; isFinished: boolean };
        };
        expect(res.statusCode).toBe(200);
        expect(body.progress).toEqual({
            currentTime: 100,
            progress: 100,
            isFinished: true,
        });
    });

    it("refreshPodcastFeed handles RSSFeedNotModifiedError and updates metadata", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-not-modified",
            feedUrl: "https://feed/not-modified.xml",
            feedEtag: '"stored-etag"',
            feedLastModified: "Mon, 01 Mar 2026 00:00:00 GMT",
            episodeCount: 12,
        });
        rssParserService.parseFeed.mockRejectedValueOnce(
            new MockRSSFeedNotModifiedError("not modified", {
                etag: '"updated-etag"',
                lastModified: "Tue, 02 Mar 2026 00:00:00 GMT",
            })
        );

        await expect(refreshPodcastFeed("pod-not-modified")).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 12,
        });

        expect(prisma.podcast.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "pod-not-modified" },
                data: expect.objectContaining({
                    feedEtag: '"updated-etag"',
                    feedLastModified: "Tue, 02 Mar 2026 00:00:00 GMT",
                    lastRefreshed: expect.any(Date),
                }),
            })
        );
    });

    it("refreshPodcastFeed keeps stored etag/last-modified when not-modified error omits metadata", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-not-modified-fallback",
            feedUrl: "https://feed/not-modified-fallback.xml",
            feedEtag: '"stored-only"',
            feedLastModified: "Sun, 28 Feb 2026 00:00:00 GMT",
            episodeCount: 8,
        });
        rssParserService.parseFeed.mockRejectedValueOnce(
            new MockRSSFeedNotModifiedError("not modified")
        );

        await expect(
            refreshPodcastFeed("pod-not-modified-fallback")
        ).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 8,
        });

        expect(prisma.podcast.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    feedEtag: '"stored-only"',
                    feedLastModified: "Sun, 28 Feb 2026 00:00:00 GMT",
                }),
            })
        );
    });

    it("refreshPodcastFeed sends empty options object when no conditional headers exist", async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-no-headers",
            feedUrl: "https://feed/no-headers.xml",
            feedEtag: null,
            feedLastModified: null,
            episodeCount: 3,
        });
        rssParserService.parseFeed.mockResolvedValueOnce({
            notModified: true,
            podcast: {
                title: "No Header Show",
                author: "Host",
                description: "Desc",
                imageUrl: "https://img/no-header.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
        });

        await expect(refreshPodcastFeed("pod-no-headers")).resolves.toEqual({
            newEpisodesCount: 0,
            totalEpisodes: 3,
        });

        expect(rssParserService.parseFeed).toHaveBeenCalledWith(
            "https://feed/no-headers.xml",
            {}
        );
    });

    it("refresh-all route aggregates successful and failed refresh results", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([
            { podcastId: "pod-ok" },
            { podcastId: "pod-fail" },
        ]);

        (prisma.podcast.findUnique as jest.Mock)
            .mockResolvedValueOnce({
                id: "pod-ok",
                feedUrl: "https://feed/ok.xml",
                feedEtag: null,
                feedLastModified: null,
                episodeCount: 0,
            })
            .mockResolvedValueOnce({
                id: "pod-fail",
                feedUrl: "https://feed/fail.xml",
                feedEtag: null,
                feedLastModified: null,
                episodeCount: 0,
            });

        rssParserService.parseFeed
            .mockResolvedValueOnce({
                podcast: {
                    title: "OK Show",
                    author: "OK Host",
                    description: "Desc",
                    imageUrl: "https://img/ok.jpg",
                    language: "en",
                    explicit: false,
                },
                episodes: [{ guid: "ep-1", title: "One", audioUrl: "https://a/1.mp3" }],
            })
            .mockRejectedValueOnce(new Error("feed parse failed"));

        (prisma.podcastEpisode.createMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

        const req = { user: { id: "u1" } } as unknown;
        const res = createRes();
        await refreshAllHandler(req, res);

        const body = res.body as { results: unknown[] };
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                success: true,
                total: 2,
                totalNewEpisodes: 1,
                failed: 1,
            })
        );
        expect(body.results).toHaveLength(2);
    });

    it("refresh-all route returns 500 when refresh-all pipeline throws", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockRejectedValueOnce(
            new Error("subscription lookup failed")
        );

        const req = { user: { id: "u1" } } as unknown;
        const res = createRes();
        await refreshAllHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to refresh podcasts" });
    });

    it("refresh-all reports 'Unknown error' for non-Error feed failures", async () => {
        (prisma.podcastSubscription.findMany as jest.Mock).mockResolvedValueOnce([
            { podcastId: "pod-unknown-error" },
        ]);
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "pod-unknown-error",
            feedUrl: "https://feed/unknown-error.xml",
            feedEtag: null,
            feedLastModified: null,
            episodeCount: 0,
        });
        rssParserService.parseFeed.mockRejectedValueOnce({});

        const req = { user: { id: "u1" } } as unknown;
        const res = createRes();
        await refreshAllHandler(req, res);

        const body = res.body as {
            failed: number;
            results: Array<{ error?: string }>;
        };
        expect(res.statusCode).toBe(200);
        expect(body.failed).toBe(1);
        expect(body.results[0].error).toBe("Unknown error");
    });
});
