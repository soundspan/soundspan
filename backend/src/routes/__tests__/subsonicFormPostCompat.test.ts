import { type Request, type Response } from "express";

const passThrough = (req: Request, _res: Response, next: () => void): void => {
    req.user = { id: "user-1", username: "alice", role: "user" };
    next();
};

jest.mock("../../middleware/subsonicAuth", () => ({
    requireSubsonicAuth: passThrough,
    subsonicRateLimiter: passThrough,
}));

jest.mock("../../utils/db", () => ({ prisma: {} }));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        getActive: jest.fn(),
        getWaiting: jest.fn(),
        getDelayed: jest.fn(),
        add: jest.fn(),
    },
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
}));

jest.mock("../../config", () => ({
    config: {
        subsonicTraceLogs: false,
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

jest.mock("../subsonic/mediaAnnotation", () => ({
    handleScrobble: (req: Request, res: Response) =>
        res.status(200).json({ method: req.method }),
    handleSetRating: jest.fn(),
    handleStar: jest.fn(),
    handleUnstar: jest.fn(),
}));

import subsonicRouter from "../subsonic";

type CapturedResponse = Response & {
    body?: string;
    jsonBody?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function createResponse(): CapturedResponse {
    const response = {
        locals: {},
        status: jest.fn(),
        setHeader: jest.fn(),
        type: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
    } as unknown as CapturedResponse;
    (response.status as jest.Mock).mockReturnValue(response);
    (response.type as jest.Mock).mockReturnValue(response);
    (response.send as jest.Mock).mockImplementation((body: string) => {
        response.body = body;
        return response;
    });
    (response.json as jest.Mock).mockImplementation((body: unknown) => {
        response.jsonBody = body;
        return response;
    });
    return response;
}

function getRouterStack(): unknown[] {
    const stackValue: unknown = Reflect.get(subsonicRouter, "stack");
    if (!Array.isArray(stackValue)) throw new Error("Router stack not found");
    return stackValue;
}

function matchesPath(routePath: unknown, path: string): boolean {
    if (routePath === path) return true;
    return Array.isArray(routePath) && routePath.includes(path);
}

async function invokeHandler(
    handler: Function,
    req: Request,
    res: Response,
): Promise<boolean> {
    let nextCalled = false;
    let nextError: unknown;
    await Reflect.apply(handler, undefined, [
        req,
        res,
        (error?: unknown) => {
            nextCalled = true;
            nextError = error;
        },
    ]);
    if (nextError) throw nextError;
    return nextCalled;
}

const MAX_ROUTER_LAYERS = 100;
const MAX_ROUTE_HANDLERS = 5;

async function executePost(path: string): Promise<CapturedResponse> {
    const req = {
        method: "POST",
        path,
        query: {},
        body: { f: "json" },
    } as unknown as Request;
    const res = createResponse();
    const stack = getRouterStack();

    for (let index = 0; index < MAX_ROUTER_LAYERS; index += 1) {
        const layer = stack[index];
        if (!layer || !isRecord(layer)) break;
        if (!isRecord(layer.route)) {
            if (typeof layer.handle === "function") {
                const nextCalled = await invokeHandler(layer.handle, req, res);
                if (!nextCalled) return res;
            }
            continue;
        }
        const method = req.method.toLowerCase();
        if (
            !matchesPath(layer.route.path, path) ||
            !isRecord(layer.route.methods) ||
            layer.route.methods[method] !== true ||
            !Array.isArray(layer.route.stack)
        ) {
            continue;
        }
        for (
            let handlerIndex = 0;
            handlerIndex < MAX_ROUTE_HANDLERS;
            handlerIndex += 1
        ) {
            const routeLayer = layer.route.stack[handlerIndex];
            if (!routeLayer) break;
            if (
                !isRecord(routeLayer) ||
                typeof routeLayer.handle !== "function"
            )
                continue;
            const nextCalled = await invokeHandler(routeLayer.handle, req, res);
            if (!nextCalled) return res;
        }
    }
    throw new Error("Router layer bound exceeded or no response was sent");
}

describe("Subsonic form POST routing", () => {
    it.each([
        "/getLicense",
        "/getLicense.view",
        "/rest/getLicense",
        "/rest/getLicense.view",
    ])("rewrites allowlisted POST %s to its GET handler", async (path) => {
        const response = await executePost(path);
        if (typeof response.body !== "string") {
            throw new Error("Expected a serialized Subsonic response");
        }
        const body = JSON.parse(response.body) as Record<string, unknown>;
        const envelope = body["subsonic-response"];

        expect(envelope).toEqual(expect.objectContaining({ status: "ok" }));
        expect(envelope).toEqual(
            expect.objectContaining({
                license: expect.objectContaining({ valid: true }),
            }),
        );
    });

    it("does not rewrite a mutating POST endpoint", async () => {
        const response = await executePost("/scrobble");

        expect(response.jsonBody).toEqual({ method: "POST" });
    });
});
