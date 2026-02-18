import { Request, Response } from "express";

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

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getArtistCorrection: jest.fn(),
        searchArtists: jest.fn(),
        searchTracks: jest.fn(),
    },
}));

jest.mock("../../services/search", () => ({
    searchService: {
        searchAll: jest.fn(),
        searchByType: jest.fn(),
    },
    normalizeCacheQuery: (query: string) => query.trim().toLowerCase(),
}));

import router from "../search";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { lastFmService } from "../../services/lastfm";

const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockGetArtistCorrection = lastFmService.getArtistCorrection as jest.Mock;
const mockSearchArtists = lastFmService.searchArtists as jest.Mock;
const mockSearchTracks = lastFmService.searchTracks as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
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

describe("search discover compatibility", () => {
    const discoverHandler = getGetHandler("/discover");

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockGetArtistCorrection.mockResolvedValue(null);
        mockSearchTracks.mockResolvedValue([]);
        mockArtistFindMany.mockResolvedValue([]);
    });

    it("filters artist discover results already in local library", async () => {
        mockSearchArtists.mockResolvedValue([
            {
                type: "music",
                id: "artist-radiohead",
                name: "Radiohead",
                mbid: "mbid-radiohead",
            },
            {
                type: "music",
                id: "artist-boc",
                name: "Boards of Canada",
                mbid: "mbid-boc",
            },
        ]);
        mockArtistFindMany.mockResolvedValue([{ name: "radiohead" }]);

        const req = {
            query: { q: "radiohead", type: "music", limit: "20" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                aliasInfo: null,
                results: [
                    expect.objectContaining({
                        name: "Boards of Canada",
                    }),
                ],
            })
        );
        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    OR: expect.arrayContaining([
                        {
                            name: {
                                equals: "Radiohead",
                                mode: "insensitive",
                            },
                        },
                        {
                            name: {
                                equals: "Boards of Canada",
                                mode: "insensitive",
                            },
                        },
                    ]),
                },
            })
        );
    });

    it("skips library artist lookup when discover artist list is empty", async () => {
        mockSearchArtists.mockResolvedValue([]);
        mockSearchTracks.mockResolvedValue([
            {
                type: "track",
                id: "track-1",
                name: "Paranoid Android",
                artist: "Radiohead",
            },
        ]);

        const req = {
            query: { q: "radiohead", type: "music", limit: "20" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([
            expect.objectContaining({
                type: "track",
                name: "Paranoid Android",
            }),
        ]);
        expect(mockArtistFindMany).not.toHaveBeenCalled();
    });
});
