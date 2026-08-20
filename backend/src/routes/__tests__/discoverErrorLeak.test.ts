import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
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
        child: jest.fn().mockReturnThis(),
    },
}));

jest.mock("../../config", () => ({
    config: {
        discover: { mode: "recommendation" },
        music: { musicPath: "/music" },
    },
}));

const prisma = {
    userDiscoverConfig: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
    },
    discoverExclusion: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({ prisma }));

jest.mock("../../services/lastfm", () => ({
    lastFmService: { getTopChartArtists: jest.fn() },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/lidarr", () => ({ lidarrService: {} }));

const discoverQueue = {
    getJobs: jest.fn(),
    getJob: jest.fn(),
    add: jest.fn(),
};
const scanQueue = { add: jest.fn() };

jest.mock("../../workers/queues", () => ({ discoverQueue, scanQueue }));

const mockClearCurrentPlaylist = jest.fn();
jest.mock("../../services/discovery", () => ({
    discoveryRecommendationsService: {
        getCurrentPlaylist: jest.fn(),
        clearCurrentPlaylist: mockClearCurrentPlaylist,
    },
}));

import router from "../discover";
import { prisma as dbPrisma } from "../../utils/db";

const mockDiscoverExclusionFindMany = dbPrisma.discoverExclusion
    .findMany as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "delete" | "patch",
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
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

const SECRET_ERROR = new Error("postgres://user:pw@db SECRET_LEAK_MARKER");
const req = {
    user: { id: "user-1" },
    params: {},
    query: {},
    body: {},
};

describe("discover route errors do not disclose caught values", () => {
    it("returns a curated exclusions error", async () => {
        mockDiscoverExclusionFindMany.mockRejectedValueOnce(SECRET_ERROR);
        const res = createRes();

        await getRouteHandler("/exclusions", "get")(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe("Failed to get exclusions");
        expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_MARKER");
        expect(res.body).not.toHaveProperty("details");
    });

    it("returns a curated clear-playlist error", async () => {
        mockClearCurrentPlaylist.mockRejectedValueOnce(SECRET_ERROR);
        const res = createRes();

        await getRouteHandler("/clear", "delete")(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe("Failed to clear discovery playlist");
        expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_MARKER");
        expect(res.body).not.toHaveProperty("details");
    });
});
