import type { Request, Response } from "express";

function createResponse() {
    const response: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn((statusCode: number) => {
            response.statusCode = statusCode;
            return response;
        }),
        json: jest.fn((body: unknown) => {
            response.body = body;
            return response;
        }),
    };
    return response;
}

function getBatchStatusHandler(router: any) {
    const layer = router.stack.find(
        (entry: any) =>
            entry.route?.path === "/batch-status" && entry.route?.methods?.get,
    );
    if (!layer) throw new Error("GET /batch-status route not found");
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function loadRouter(mode: "legacy" | "recommendation") {
    jest.resetModules();
    const getJobs = jest.fn(async () => []);
    const findFirst = jest.fn(async () => null);

    jest.doMock("../../config", () => ({
        config: { discover: { mode }, music: { musicPath: "/music" } },
    }));
    jest.doMock("../../middleware/auth", () => ({
        requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
            next(),
        requireAdmin: (_req: Request, _res: Response, next: () => void) =>
            next(),
    }));
    jest.doMock("../../utils/logger", () => ({
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn().mockReturnThis(),
        },
    }));
    jest.doMock("../../utils/db", () => ({
        prisma: { discoveryBatch: { findFirst } },
    }));
    jest.doMock("../../workers/queues", () => ({
        discoverQueue: { getJobs },
        scanQueue: {},
    }));
    jest.doMock("../../services/lastfm", () => ({ lastFmService: {} }));
    jest.doMock("../../utils/systemSettings", () => ({
        getSystemSettings: jest.fn(),
    }));
    jest.doMock("../../services/lidarr", () => ({ lidarrService: {} }));
    jest.doMock("../../services/discovery", () => ({
        discoveryRecommendationsService: {},
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require("../discover").default;
    return { router, getJobs, findFirst };
}

describe("discover mode dispatch", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("dispatches batch status to the modern handler in legacy mode", async () => {
        const { router, getJobs, findFirst } = loadRouter("legacy");
        const response = createResponse();

        await getBatchStatusHandler(router)(
            { user: { id: "user-1" } } as any,
            response,
        );

        expect(getJobs).toHaveBeenCalledWith(
            ["active", "waiting", "delayed"],
            0,
            200,
        );
        expect(findFirst).not.toHaveBeenCalled();
        expect(response.body).toEqual({
            active: false,
            status: null,
            progress: null,
        });
    });

    it("dispatches batch status to the modern handler by default", async () => {
        const { router, getJobs, findFirst } = loadRouter("recommendation");
        const response = createResponse();

        await getBatchStatusHandler(router)(
            { user: { id: "user-1" } } as any,
            response,
        );

        expect(getJobs).toHaveBeenCalledWith(
            ["active", "waiting", "delayed"],
            0,
            200,
        );
        expect(findFirst).not.toHaveBeenCalled();
        expect(response.body).toEqual({
            active: false,
            status: null,
            progress: null,
        });
    });
});
