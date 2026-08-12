import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
    requireAdmin: (req: any, res: any, next: () => void) => {
        if (!req.user || req.user.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
        next();
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../config", () => ({
    config: {
        discover: { mode: "legacy" },
        music: { musicPath: "/music" },
    },
}));

const prisma = {
    ownedAlbum: {
        findFirst: jest.fn(async () => null),
        deleteMany: jest.fn(),
    },
    discoveryAlbum: {
        findFirst: jest.fn(async () => null),
        deleteMany: jest.fn(),
    },
    downloadJob: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({ prisma }));

jest.mock("../../services/lastfm", () => ({ lastFmService: {} }));

const getSystemSettings = jest.fn(async () => ({
    lidarrEnabled: true,
    lidarrUrl: "http://lidarr.internal:8686",
    lidarrApiKey: "SECRET_KEY",
}));
jest.mock("../../utils/systemSettings", () => ({ getSystemSettings }));

const axiosGet = jest.fn();
const axiosDelete = jest.fn();
jest.mock("axios", () => ({
    __esModule: true,
    default: { get: axiosGet, delete: axiosDelete, put: jest.fn() },
}));

jest.mock("../../services/lidarr", () => ({ lidarrService: {} }));

jest.mock("../../workers/queues", () => ({
    discoverQueue: { add: jest.fn(), getJobs: jest.fn(), getJob: jest.fn() },
    scanQueue: { add: jest.fn() },
}));

jest.mock("../../services/discovery", () => ({
    discoveryRecommendationsService: {
        getCurrentPlaylist: jest.fn(),
        clearCurrentPlaylist: jest.fn(),
    },
}));

import router from "../discover";

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

const MAX_ROUTE_HANDLERS = 3;

async function invokeRouteStack(req: any, res: any) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === "/cleanup-lidarr" &&
            entry.route?.methods?.post,
    );
    if (!layer) throw new Error("Route not found: POST /cleanup-lidarr");
    const stack = layer.route.stack;
    if (stack.length > MAX_ROUTE_HANDLERS) {
        throw new Error(`Too many route handlers: ${stack.length}`);
    }
    for (let index = 0; index < MAX_ROUTE_HANDLERS; index += 1) {
        const entry = stack[index];
        if (!entry) return;
        let nextCalled = false;
        await entry.handle(req, res, () => {
            nextCalled = true;
        });
        if (!nextCalled) return;
    }
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

const LEAK_MARKER =
    "connect ECONNREFUSED lidarr.internal:8686 X-Api-Key=SECRET_KEY";

describe("POST /cleanup-lidarr does not disclose caught error text", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("rejects a non-admin before Lidarr or database effects", async () => {
        const res = createRes();

        await invokeRouteStack(
            {
                user: {
                    id: "user-1",
                    username: "user-1",
                    role: "user",
                },
                params: {},
                query: {},
                body: {},
            },
            res,
        );

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Admin access required" });
        expect(getSystemSettings).not.toHaveBeenCalled();
        expect(axiosGet).not.toHaveBeenCalled();
        expect(axiosDelete).not.toHaveBeenCalled();
        expect(prisma.ownedAlbum.findFirst).not.toHaveBeenCalled();
        expect(prisma.discoveryAlbum.findFirst).not.toHaveBeenCalled();
        expect(prisma.ownedAlbum.deleteMany).not.toHaveBeenCalled();
        expect(prisma.discoveryAlbum.deleteMany).not.toHaveBeenCalled();
        expect(prisma.downloadJob.deleteMany).not.toHaveBeenCalled();
    });

    it("returns a static per-artist message, not the raw axios error", async () => {
        axiosGet.mockResolvedValueOnce({
            data: [
                {
                    id: 42,
                    foreignArtistId: "mbid-1",
                    artistName: "Nine Inch Nails",
                },
            ],
        });
        axiosDelete.mockRejectedValueOnce(new Error(LEAK_MARKER));
        const res = createRes();

        await getRouteHandler("/cleanup-lidarr", "post")(
            { user: { id: "user-1" }, params: {}, query: {}, body: {} },
            res,
        );

        expect(res.body.success).toBe(true);
        expect(res.body.errors).toEqual(["Failed to process Nine Inch Nails"]);
        expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
        expect(JSON.stringify(res.body)).not.toContain("SECRET_KEY");
    });

    it("survives a non-Error throw without leaking or crashing", async () => {
        axiosGet.mockResolvedValueOnce({
            data: [
                { id: 7, foreignArtistId: "mbid-2", artistName: "Aphex Twin" },
            ],
        });
        axiosDelete.mockRejectedValueOnce("boom-string-throw");
        const res = createRes();

        await getRouteHandler("/cleanup-lidarr", "post")(
            { user: { id: "user-1" }, params: {}, query: {}, body: {} },
            res,
        );

        expect(res.body.errors).toEqual(["Failed to process Aphex Twin"]);
        expect(JSON.stringify(res.body)).not.toContain("boom-string-throw");
    });
});
