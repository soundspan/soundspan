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
        child: jest.fn().mockReturnThis(),
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

describe("POST /cleanup-lidarr legacy-mode shim", () => {
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

    it("serves the retired modern handler without Lidarr or database effects", async () => {
        const res = createRes();

        await invokeRouteStack(
            {
                user: { id: "admin-1", role: "admin" },
                params: {},
                query: {},
                body: {},
            },
            res,
        );

        expect(res.statusCode).toBe(410);
        expect(res.body).toEqual({
            error: "Lidarr cleanup is only available in legacy discovery mode",
        });
        expect(getSystemSettings).not.toHaveBeenCalled();
        expect(axiosGet).not.toHaveBeenCalled();
        expect(axiosDelete).not.toHaveBeenCalled();
        expect(prisma.ownedAlbum.findFirst).not.toHaveBeenCalled();
        expect(prisma.discoveryAlbum.findFirst).not.toHaveBeenCalled();
        expect(prisma.ownedAlbum.deleteMany).not.toHaveBeenCalled();
        expect(prisma.discoveryAlbum.deleteMany).not.toHaveBeenCalled();
        expect(prisma.downloadJob.deleteMany).not.toHaveBeenCalled();
    });
});
