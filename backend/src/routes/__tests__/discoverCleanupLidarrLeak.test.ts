import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
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
    ownedAlbum: { findFirst: jest.fn(async () => null) },
    discoveryAlbum: { findFirst: jest.fn(async () => null) },
    downloadJob: { findMany: jest.fn(async () => []) },
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
