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

jest.mock("../../utils/db", () => ({
    prisma: {
        $connect: jest.fn(),
    },
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

jest.mock("../../services/rss-parser", () => ({
    rssParserService: {},
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

describe("podcasts discover/top compatibility", () => {
    const discoverTopHandler = getGetHandler("/discover/top");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("maps iTunes search results to external podcast payload", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 123,
                        collectionName: "Example Show",
                        artistName: "Example Host",
                        artworkUrl600: "https://img/600.jpg",
                        artworkUrl100: "https://img/100.jpg",
                        feedUrl: "https://feeds.example/podcast.xml",
                        genres: ["Technology"],
                        trackCount: 42,
                    },
                ],
            },
        });

        const req = {
            query: { limit: "10" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverTopHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/search",
            expect.objectContaining({
                timeout: 10000,
                params: expect.objectContaining({
                    term: "podcast",
                    media: "podcast",
                    entity: "podcast",
                    limit: 10,
                }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                id: "123",
                title: "Example Show",
                author: "Example Host",
                coverUrl: "https://img/600.jpg",
                feedUrl: "https://feeds.example/podcast.xml",
                genres: ["Technology"],
                episodeCount: 42,
                itunesId: 123,
                isExternal: true,
            },
        ]);
    });

    it("returns an empty list when iTunes request fails", async () => {
        const axiosError = {
            code: "ETIMEDOUT",
            message: "timeout",
            response: undefined,
        };
        mockAxiosGet.mockRejectedValueOnce(axiosError);
        mockAxiosIsAxiosError.mockReturnValue(true);

        const req = {
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverTopHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("returns an empty list when iTunes fails with a non-Axios Error instance", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("plain failure"));
        mockAxiosIsAxiosError.mockReturnValue(false);

        const req = {
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverTopHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("returns an empty list when iTunes fails with a non-Error throwable", async () => {
        mockAxiosGet.mockRejectedValueOnce({ reason: "non-error throw" });
        mockAxiosIsAxiosError.mockReturnValue(false);

        const req = {
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverTopHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("caps discover/top limit at 50 even when client requests more", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: { results: [] },
        });

        const req = {
            query: { limit: "999" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await discoverTopHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/search",
            expect.objectContaining({
                params: expect.objectContaining({
                    limit: 50,
                }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });
});
