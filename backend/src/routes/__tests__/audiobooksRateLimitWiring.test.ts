import {
    type NextFunction,
    type Request,
    type RequestHandler,
    type Response,
} from "express";
import rateLimit from "express-rate-limit";

const API_TEST_MAX = 2;
const STREAMING_TEST_MAX = 10;

function namedLimiter(name: string, max: number): RequestHandler {
    const limiter = rateLimit({
        windowMs: 60_000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        validate: { trustProxy: false },
    });
    return Object.defineProperty(
        (req: Request, res: Response, next: NextFunction) =>
            limiter(req, res, next),
        "name",
        { value: name },
    );
}

const apiLimiter = namedLimiter("apiLimiter", API_TEST_MAX);
const coverArtLimiter = namedLimiter("coverArtLimiter", 5);
const streamingLimiter = namedLimiter("streamingLimiter", STREAMING_TEST_MAX);

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: function requireAuthOrToken(
        req: Request,
        _res: Response,
        next: NextFunction,
    ) {
        req.user = { id: "user-1", username: "test" } as Request["user"];
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter,
    coverArtLimiter,
    streamingLimiter,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/audiobookshelf", () => ({
    audiobookshelfService: {},
}));
jest.mock("../../services/audiobookCache", () => ({
    audiobookCacheService: {},
}));
jest.mock("../../services/federationAudiobookProxy", () => ({
    proxyFederatedAudiobookStream: jest.fn(),
    proxyFederatedAudiobookCover: jest.fn(),
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({
        audiobookshelfEnabled: false,
    }),
}));
jest.mock("../../utils/db", () => ({
    prisma: {},
}));
jest.mock("../../config", () => ({
    config: {
        features: { federation: false },
        music: { musicPath: "/music" },
    },
}));

import router from "../audiobooks";

type RouteLayer = {
    handle?: RequestHandler & { stack?: RouteLayer[] };
    route?: {
        methods: Record<string, boolean>;
        path: string;
        stack: RouteLayer[];
    };
};

type LimitedRoute = {
    handlers: RequestHandler[];
    method: string;
    middlewareOrder: string[];
    path: string;
    limiters: string[];
};

const limiterNames = new Set([
    "apiLimiter",
    "coverArtLimiter",
    "streamingLimiter",
]);

function collectLimitedRoutes(): LimitedRoute[] {
    const routes: LimitedRoute[] = [];
    const visit = (stack: RouteLayer[], inherited: string[]): void => {
        const active = [...inherited];
        for (const layer of stack) {
            if (layer.route) {
                const middlewareOrder = layer.route.stack.map(
                    (entry) => entry.handle?.name ?? "",
                );
                const routeLimiters = middlewareOrder.filter((name) =>
                    limiterNames.has(name),
                );
                for (const method of Object.keys(layer.route.methods)) {
                    if (layer.route.methods[method]) {
                        routes.push({
                            handlers: layer.route.stack.flatMap((entry) =>
                                entry.handle &&
                                limiterNames.has(entry.handle.name)
                                    ? [entry.handle]
                                    : [],
                            ),
                            method: method.toUpperCase(),
                            middlewareOrder,
                            path: layer.route.path,
                            limiters: [...active, ...routeLimiters].filter(
                                (name) => limiterNames.has(name),
                            ),
                        });
                    }
                }
                continue;
            }
            if (layer.handle?.stack) {
                visit(layer.handle.stack, active);
                continue;
            }
            const name = layer.handle?.name ?? "";
            if (name) active.push(name);
        }
    };
    visit((router as unknown as { stack: RouteLayer[] }).stack, []);
    return routes;
}

async function runLimiters(
    handlers: RequestHandler[],
    path: string,
): Promise<number> {
    const req = {
        app: { get: () => false },
        headers: {},
        ip: "127.0.0.1",
        method: "GET",
        originalUrl: path,
        path,
        socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;
    type FakeResponse = {
        headersSent: boolean;
        statusCode: number;
        setHeader: jest.Mock;
        status(code: number): FakeResponse;
        send(): FakeResponse;
    };
    const responseState: FakeResponse = {
        headersSent: false,
        statusCode: 200,
        setHeader: jest.fn(),
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        send() {
            this.headersSent = true;
            return this;
        },
    };
    const res = responseState as unknown as Response;

    for (const handler of handlers) {
        const continued = await new Promise<boolean>((resolve, reject) => {
            const next: NextFunction = (error?: unknown) => {
                if (error) reject(error);
                else resolve(true);
            };
            const originalSend = res.send.bind(res);
            res.send = ((...args: Parameters<Response["send"]>) => {
                originalSend(...args);
                resolve(false);
                return res;
            }) as Response["send"];
            void handler(req, res, next);
        });
        if (!continued) break;
    }
    return responseState.statusCode;
}

describe("audiobook rate-limit wiring", () => {
    it("assigns every handler to exactly one rate-limit class", () => {
        const routes = collectLimitedRoutes();

        expect(routes).toHaveLength(11);
        for (const route of routes) {
            const expectedLimiter = route.path.endsWith("/cover")
                ? "coverArtLimiter"
                : route.path.endsWith("/stream")
                  ? "streamingLimiter"
                  : "apiLimiter";
            expect(route.limiters).toEqual([expectedLimiter]);
            expect(route.middlewareOrder.indexOf(expectedLimiter)).toBeLessThan(
                route.middlewareOrder.indexOf("requireAuthOrToken"),
            );
        }
    });

    it("keeps streaming available after the metadata budget is exhausted", async () => {
        const routes = collectLimitedRoutes();
        const metadataRoute = routes.find((route) => route.path === "/")!;
        const streamingRoute = routes.find(
            (route) => route.path === "/:id/stream",
        )!;

        const metadataResponses = await Promise.all(
            Array.from({ length: API_TEST_MAX + 1 }, () =>
                runLimiters(metadataRoute.handlers, "/api/audiobooks"),
            ),
        );
        expect(metadataResponses.at(-1)).toBe(429);

        const streamResponses = await Promise.all(
            Array.from({ length: API_TEST_MAX + 1 }, () =>
                runLimiters(
                    streamingRoute.handlers,
                    "/api/audiobooks/book-1/stream",
                ),
            ),
        );
        expect(streamResponses.every((status) => status !== 429)).toBe(true);
    });
});
