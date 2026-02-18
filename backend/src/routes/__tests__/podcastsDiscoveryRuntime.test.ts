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
    podcast: {
        findFirst: jest.fn(async () => null),
    },
    podcastSubscription: {
        findUnique: jest.fn(async () => null),
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

const mockParseFeed = jest.fn(async () => ({
    podcast: {},
    episodes: [] as any[],
}));
jest.mock("../../services/rss-parser", () => ({
    rssParserService: {
        parseFeed: mockParseFeed as any,
    },
}));

jest.mock("../../services/podcastCache", () => ({
    podcastCacheService: {
        syncAllCovers: jest.fn(async () => ({ synced: 0 })),
        syncEpisodeCovers: jest.fn(async () => ({ synced: 0 })),
    },
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

import router from "../podcasts";

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) throw new Error(`GET route not found: ${path}`);
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

describe("podcasts discovery runtime behavior", () => {
    const discoverGenresHandler = getGetHandler("/discover/genres");
    const discoverGenrePaginatedHandler = getGetHandler(
        "/discover/genre/:genreId"
    );
    const previewHandler = getGetHandler("/preview/:itunesId");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("validates genres query param for discover/genres", async () => {
        const req = { query: {}, user: { id: "user-1" } } as any;
        const res = createRes();

        await discoverGenresHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "genres parameter required (comma-separated genre IDs)",
        });
    });

    it("returns per-genre podcast buckets and tolerates per-genre iTunes failures", async () => {
        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    results: [
                        {
                            collectionId: 101,
                            collectionName: "Comedy Show",
                            artistName: "Host 1",
                            artworkUrl600: "https://img/600-a.jpg",
                            artworkUrl100: "https://img/100-a.jpg",
                            feedUrl: "https://feed/a.xml",
                            genres: ["Comedy"],
                            trackCount: 12,
                        },
                    ],
                },
            })
            .mockRejectedValueOnce({ code: "ETIMEDOUT", message: "timeout" });
        mockAxiosIsAxiosError.mockReturnValue(true);

        const req = {
            query: { genres: "1303,1489" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverGenresHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body[1303]).toEqual([
            expect.objectContaining({
                id: "101",
                title: "Comedy Show",
                isExternal: true,
            }),
        ]);
        expect(res.body[1489]).toEqual([]);
    });

    it("falls back to default search term for unknown discover genre ids", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: { results: [] },
        });

        const req = {
            query: { genres: "9999" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverGenresHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/search",
            expect.objectContaining({
                params: expect.objectContaining({
                    term: "podcast",
                    media: "podcast",
                    entity: "podcast",
                    limit: 10,
                }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ 9999: [] });
    });

    it("returns an empty object when discover genre preprocessing throws", async () => {
        const splitSpy = jest
            .spyOn(String.prototype, "split")
            .mockImplementationOnce(() => {
                throw new Error("split exploded");
            });

        const req = {
            query: { genres: "1303,1489" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverGenresHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({});
        splitSpy.mockRestore();
    });

    it("supports paginated genre discovery by slicing iTunes results with offset", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 1,
                        collectionName: "Show 1",
                        artistName: "Host 1",
                        artworkUrl100: "https://img/1.jpg",
                        feedUrl: "https://feed/1.xml",
                        genres: [],
                        trackCount: 10,
                    },
                    {
                        collectionId: 2,
                        collectionName: "Show 2",
                        artistName: "Host 2",
                        artworkUrl100: "https://img/2.jpg",
                        feedUrl: "https://feed/2.xml",
                        genres: [],
                        trackCount: 20,
                    },
                    {
                        collectionId: 3,
                        collectionName: "Show 3",
                        artistName: "Host 3",
                        artworkUrl100: "https://img/3.jpg",
                        feedUrl: "https://feed/3.xml",
                        genres: [],
                        trackCount: 30,
                    },
                ],
            },
        });

        const req = {
            params: { genreId: "1303" },
            query: { limit: "2", offset: "1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverGenrePaginatedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.map((p: { id: string }) => p.id)).toEqual(["2", "3"]);
    });

    it("caps paginated genre discovery iTunes request and slices empty when offset exceeds result depth", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 101,
                        collectionName: "Show 101",
                        artistName: "Host 101",
                        artworkUrl100: "https://img/101.jpg",
                        feedUrl: "https://feed/101.xml",
                        genres: [],
                        trackCount: 11,
                    },
                ],
            },
        });

        const req = {
            params: { genreId: "1303" },
            query: { limit: "120", offset: "500" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverGenrePaginatedHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/search",
            expect.objectContaining({
                params: expect.objectContaining({
                    term: "comedy podcast",
                    media: "podcast",
                    entity: "podcast",
                    limit: 200,
                }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("returns empty result when genre pagination query params are non-numeric", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 11,
                        collectionName: "Show 11",
                        artistName: "Host 11",
                        artworkUrl100: "https://img/11.jpg",
                        feedUrl: "https://feed/11.xml",
                        genres: [],
                        trackCount: 22,
                    },
                ],
            },
        });

        const req = {
            params: { genreId: "1303" },
            query: { limit: "not-a-number", offset: "still-nope" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverGenrePaginatedHandler(req, res);

        const requestParams = (mockAxiosGet as jest.Mock).mock.calls[0][1]
            .params as Record<string, unknown>;
        expect(requestParams.limit).toBeNaN();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("returns empty list when paginated genre discovery iTunes call fails", async () => {
        mockAxiosGet.mockRejectedValueOnce({ code: "ECONNRESET", message: "boom" });
        mockAxiosIsAxiosError.mockReturnValue(true);

        const req = {
            params: { genreId: "1303" },
            query: { limit: "10", offset: "0" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverGenrePaginatedHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("returns 404 when preview lookup does not find podcast", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: { results: [] },
        });

        const req = {
            params: { itunesId: "777" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await previewHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Podcast not found" });
    });

    it("returns preview metadata with subscription status and RSS-derived details", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 222,
                        collectionName: "Preview Show",
                        artistName: "Preview Host",
                        artworkUrl600: "https://img/600-preview.jpg",
                        artworkUrl100: "https://img/100-preview.jpg",
                        feedUrl: "https://feed/preview.xml",
                        genres: ["News"],
                        trackCount: 77,
                    },
                ],
            },
        });
        (prisma.podcast.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "podcast-222",
            feedUrl: "https://feed/preview.xml",
        });
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-1",
            podcastId: "podcast-222",
        });
        mockParseFeed.mockResolvedValueOnce({
            podcast: { description: "A preview description" },
            episodes: [
                { title: "Ep1", publishedAt: "2026-01-01", duration: 1200 },
                { title: "Ep2", publishedAt: "2026-01-02", duration: 1500 },
                { title: "Ep3", publishedAt: "2026-01-03", duration: 1800 },
                { title: "Ep4", publishedAt: "2026-01-04", duration: 2100 },
            ],
        });

        const req = {
            params: { itunesId: "222" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await previewHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                itunesId: "222",
                title: "Preview Show",
                isSubscribed: true,
                subscribedPodcastId: "podcast-222",
                description: "A preview description",
            })
        );
        expect(res.body.previewEpisodes).toHaveLength(3);
    });

    it("falls back to empty description/episodes when preview RSS fetch fails", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 333,
                        collectionName: "RSS Fallback Show",
                        artistName: "Fallback Host",
                        artworkUrl100: "https://img/333.jpg",
                        feedUrl: "https://feed/fallback.xml",
                        genres: ["Tech"],
                        trackCount: 5,
                    },
                ],
            },
        });
        (prisma.podcast.findFirst as jest.Mock).mockResolvedValueOnce(null);
        mockParseFeed.mockRejectedValueOnce(new Error("rss unavailable"));

        const req = {
            params: { itunesId: "333" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await previewHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                itunesId: "333",
                description: "",
                previewEpisodes: [],
                isSubscribed: false,
                subscribedPodcastId: null,
            })
        );
    });

    it("returns 500 when preview iTunes lookup throws", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("itunes unavailable"));

        const req = {
            params: { itunesId: "999" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await previewHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to preview podcast",
            message: "itunes unavailable",
        });
    });
});
