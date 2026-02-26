jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
}));

const mockLoggerDebug = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        info: jest.fn(),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

const prisma = {
    album: {
        findMany: jest.fn(),
    },
    podcast: {
        findMany: jest.fn(),
    },
};

const Prisma = {
    JsonNull: Symbol("JsonNull"),
};

jest.mock("../../utils/db", () => ({
    prisma,
    Prisma,
}));

const redisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};

jest.mock("../../utils/redis", () => ({
    redisClient,
}));

import router from "../homepage";
import { prisma as prismaClient } from "../../utils/db";
import { redisClient as redis } from "../../utils/redis";
import { createMockJsonResponse } from "./helpers/mockJsonResponse";

const mockAlbumFindMany = prismaClient.album.findMany as jest.Mock;
const mockPodcastFindMany = prismaClient.podcast.findMany as jest.Mock;
const mockRedisGet = redis.get as jest.Mock;
const mockRedisSetEx = redis.setEx as jest.Mock;

function getHandler(path: string, method: "get") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

const createRes = createMockJsonResponse;

describe("homepage routes runtime", () => {
    const getGenres = getHandler("/genres", "get");
    const getTopPodcasts = getHandler("/top-podcasts", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");

        mockAlbumFindMany.mockResolvedValue([
            {
                id: "a1",
                title: "Alpha",
                year: 2024,
                coverUrl: "/covers/a1.jpg",
                genres: ["Rock", "Indie"],
                artist: { id: "ar1", name: "Artist One" },
            },
            {
                id: "a2",
                title: "Beta",
                year: 2025,
                coverUrl: "/covers/a2.jpg",
                genres: ["Rock"],
                artist: { id: "ar2", name: "Artist Two" },
            },
            {
                id: "a3",
                title: "Gamma",
                year: 2026,
                coverUrl: "/covers/a3.jpg",
                genres: ["Jazz"],
                artist: { id: "ar3", name: "Artist Three" },
            },
        ]);

        mockPodcastFindMany.mockResolvedValue([
            {
                id: "p1",
                title: "Podcast One",
                author: "Host One",
                description:
                    "An in-depth show about music production, interviews, and weekly recommendations.",
                imageUrl: "/podcasts/p1.jpg",
                _count: { episodes: 42 },
            },
        ]);
    });

    it("serves /genres from cache when redis returns cached payload", async () => {
        const cached = [{ genre: "Rock", albums: [], totalCount: 2 }];
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const req = { query: { limit: "2" } } as any;
        const res = createRes();

        await getGenres(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cached);
        expect(mockAlbumFindMany).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("builds /genres from DB on cache miss and tolerates redis write errors", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockRedisSetEx.mockRejectedValueOnce(new Error("redis write failed"));

        const req = { query: { limit: "2" } } as any;
        const res = createRes();

        await getGenres(req, res);

        expect(mockAlbumFindMany).toHaveBeenCalledWith({
            where: {
                genres: { not: Prisma.JsonNull },
                location: "LIBRARY",
            },
            select: {
                id: true,
                title: true,
                year: true,
                coverUrl: true,
                genres: true,
                artistId: true,
                artist: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                genre: "Rock",
                totalCount: 2,
                albums: expect.arrayContaining([
                    expect.objectContaining({ id: "a1" }),
                    expect.objectContaining({ id: "a2" }),
                ]),
            }),
            expect.objectContaining({
                genre: "Indie",
                totalCount: 1,
            }),
        ]);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "homepage:genres:2",
            86400,
            expect.any(String)
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[HOMEPAGE] Redis cache write error:",
            expect.any(Error)
        );
    });

    it("returns 500 for /genres when DB query fails", async () => {
        mockAlbumFindMany.mockRejectedValueOnce(new Error("db down"));
        const req = { query: {} } as any;
        const res = createRes();

        await getGenres(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to fetch genres" });
    });

    it("serves /top-podcasts from cache and bypasses DB", async () => {
        const cached = [{ id: "p-cached", title: "Cached Podcast" }];
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const req = { query: { limit: "3" } } as any;
        const res = createRes();

        await getTopPodcasts(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cached);
        expect(mockPodcastFindMany).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("builds /top-podcasts from DB on cache miss and caches result", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        const req = { query: { limit: "1" } } as any;
        const res = createRes();

        await getTopPodcasts(req, res);

        expect(mockPodcastFindMany).toHaveBeenCalledWith({
            take: 1,
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                title: true,
                author: true,
                description: true,
                imageUrl: true,
                _count: {
                    select: { episodes: true },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                id: "p1",
                title: "Podcast One",
                author: "Host One",
                description:
                    "An in-depth show about music production, interviews, and weekly recommendations....",
                coverArt: "/podcasts/p1.jpg",
                episodeCount: 42,
            },
        ]);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "homepage:top-podcasts:1",
            86400,
            expect.any(String)
        );
    });

    it("returns 500 for /top-podcasts when query fails", async () => {
        mockPodcastFindMany.mockRejectedValueOnce(new Error("db down"));
        const req = { query: {} } as any;
        const res = createRes();

        await getTopPodcasts(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to fetch top podcasts" });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Get top podcasts error:",
            expect.any(Error)
        );
    });
});
