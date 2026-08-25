import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import { isLibraryMediaPath } from "../../middleware/libraryRateLimitPaths";

const METADATA_TEST_MAX = 2;
const COVER_TEST_MAX = 1;
const STREAMING_TEST_MAX = 2;
const EXPECTED_LIBRARY_ROUTE_COUNT = 39;
const MAX_STATUS_REQUESTS = 3;
const mockMiddlewareTrace = new Map<string, string[]>();

function traceMiddleware(req: Request, name: string): void {
    const key = String(req.headers["x-test-key"] ?? "missing");
    const trace = mockMiddlewareTrace.get(key) ?? [];
    trace.push(name);
    mockMiddlewareTrace.set(key, trace);
}

function namedLimiter(
    name: string,
    max: number,
    skip?: (req: Request) => boolean,
): RequestHandler {
    const limiter = rateLimit({
        windowMs: 60_000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => String(req.headers["x-test-key"] ?? "missing"),
        skip,
        validate: { keyGeneratorIpFallback: false, trustProxy: false },
    });
    return Object.defineProperty(
        (req: Request, res: Response, next: NextFunction) => {
            if (!skip?.(req)) traceMiddleware(req, name);
            limiter(req, res, next);
        },
        "name",
        { value: name },
    );
}

const mockLibraryMetadataLimiter = namedLimiter(
    "libraryMetadataLimiter",
    METADATA_TEST_MAX,
    (req) => isLibraryMediaPath(req.path),
);
const mockCoverArtLimiter = namedLimiter("coverArtLimiter", COVER_TEST_MAX);
const mockStreamingLimiter = namedLimiter(
    "streamingLimiter",
    STREAMING_TEST_MAX,
);

jest.mock("../../middleware/auth", () => ({
    requireAuth: function requireAuth(
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) {
        next();
    },
    requireAdmin: function requireAdmin(
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) {
        next();
    },
    requireAuthOrToken: function requireAuthOrToken(
        req: Request,
        res: Response,
    ) {
        traceMiddleware(req, "requireAuthOrToken");
        res.status(401).json({ error: "Not authenticated" });
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    coverArtLimiter: mockCoverArtLimiter,
    libraryMetadataLimiter: mockLibraryMetadataLimiter,
    streamingLimiter: mockStreamingLimiter,
}));

jest.mock("../../middleware/asyncHandler", () => ({
    asyncHandler: (handler: RequestHandler) => handler,
}));

jest.mock("../../config", () => ({
    config: {
        audiobookshelf: undefined,
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
        generationDiversity: {
            weightAlpha: 0.5,
            shareCeiling: 0.3,
        },
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {},
    Prisma: {
        DbNull: null,
        SortOrder: { asc: "asc", desc: "desc" },
    },
}));

jest.mock("../../utils/redis", () => ({ redisClient: {} }));
jest.mock("../../workers/queues", () => ({ scanQueue: {} }));
jest.mock("../../workers/organizeSingles", () => ({
    organizeSingles: jest.fn(),
}));
jest.mock("../../services/lastfm", () => ({ lastFmService: {} }));
jest.mock("../../services/fanart", () => ({ fanartService: {} }));
jest.mock("../../services/deezer", () => ({ deezerService: {} }));
jest.mock("../../services/imageProvider", () => ({ imageProviderService: {} }));
jest.mock("../../services/musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../services/coverArt", () => ({ coverArtService: {} }));
jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
}));
jest.mock("../../services/dataCache", () => ({ dataCacheService: {} }));
jest.mock("../../services/artistCountsService", () => ({}));
jest.mock("../../services/remoteTrackBackfillService", () => ({}));
jest.mock("../../services/imageBackfill", () => ({}));
jest.mock("../../services/imageProxy", () => ({}));
jest.mock("../../services/imageStorage", () => ({}));
jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {},
}));
jest.mock("../../services/remoteTrackMetadataResolver", () => ({}));
jest.mock("../../utils/systemSettings", () => ({}));
jest.mock("../../utils/colorExtractor", () => ({}));

jest.mock("../../services/metadata/catalogPersistence", () => ({
    findFreshCatalogAlbum: jest.fn(async () => null),
    findFreshCatalogReleaseGroups: jest.fn(async () => null),
    logCatalogPersistenceError: jest.fn(),
    persistCatalogReleaseGroups: jest.fn(async () => undefined),
    persistCatalogTracklist: jest.fn(async () => undefined),
    readFreshCatalogReleaseGroups: jest.fn(() => null),
}));

import router from "../library";
import * as albums from "../library/albums";
import * as artistCounts from "../library/artistCounts";
import * as artists from "../library/artists";
import * as coverArt from "../library/coverArt";
import * as imageBackfill from "../library/imageBackfill";
import * as maintenance from "../library/maintenance";
import * as metadataBackfill from "../library/metadataBackfill";
import * as radio from "../library/radio";
import * as radioPlaylists from "../library/radioPlaylists";
import * as remoteTracks from "../library/remoteTracks";
import * as tracks from "../library/tracks";
import { flattenLibraryRouteLayers } from "./libraryRouteTestUtils";

interface RouteLayer {
    handle?: { name?: string; stack?: RouteLayer[] };
    name?: string;
    route?: {
        methods: Record<string, boolean>;
        path: string;
        stack: RouteLayer[];
    };
}

interface RouteTableEntry {
    method: string;
    path: string;
    middleware: string[];
}

interface RouterMiddlewareEntry {
    middleware: string;
    path: "(router-level)";
}

type RegisteredRouteLayer = RouteLayer & {
    route: NonNullable<RouteLayer["route"]>;
};

const limiterNames = new Set([
    "coverArtLimiter",
    "libraryMetadataLimiter",
    "streamingLimiter",
]);
const coverPaths = new Set([
    "/cover-art{/:id}",
    "/album-cover/:mbid",
    "/cover-art-colors",
]);

const isNamedFunction = (name: string | undefined): name is string =>
    Boolean(name && name !== "<anonymous>");

const getRouterStack = (): RouteLayer[] =>
    (router as unknown as { stack: RouteLayer[] }).stack;

const getRouteLayers = (): RegisteredRouteLayer[] =>
    flattenLibraryRouteLayers(router) as RegisteredRouteLayer[];

const buildRouteTable = (): Array<RouteTableEntry | RouterMiddlewareEntry> => {
    const routerMiddleware = getRouterStack()
        .filter((layer) => layer.handle && !layer.route)
        .filter((layer) => !layer.handle?.stack)
        .map((layer) => ({
            middleware: layer.handle?.name || layer.name || "<anonymous>",
            path: "(router-level)" as const,
        }));
    const routes = getRouteLayers().flatMap((layer) =>
        Object.keys(layer.route.methods)
            .filter((method) => layer.route.methods[method])
            .map((method) => ({
                method: method.toUpperCase(),
                path: layer.route.path,
                middleware: layer.route.stack
                    .slice(0, -1)
                    .map((routeLayer) => routeLayer.handle?.name)
                    .filter(isNamedFunction),
            })),
    );

    return [...routerMiddleware, ...routes];
};

const getTerminalHandlerNames = (): string[] =>
    getRouteLayers().map(
        (layer) => layer.route.stack.at(-1)?.handle?.name ?? "",
    );

const handlerModules = [
    maintenance,
    artists,
    artistCounts,
    imageBackfill,
    metadataBackfill,
    albums,
    tracks,
    coverArt,
    remoteTracks,
    radio,
    radioPlaylists,
];

function testPath(routePath: string): string {
    return routePath.replace("{/:id}", "/item-1").replace(/:[^/]+/g, "item-1");
}

function expectedLimiter(routePath: string): string {
    if (coverPaths.has(routePath)) return "coverArtLimiter";
    if (routePath === "/tracks/:id/stream") return "streamingLimiter";
    return "libraryMetadataLimiter";
}

function createRequest(method: string, path: string, key: string): Request {
    const req = {
        app: { get: () => false },
        headers: { "x-test-key": key },
        method,
        originalUrl: path,
        socket: { remoteAddress: "127.0.0.1" },
        url: path,
    } as unknown as Request;
    Object.defineProperty(req, "path", {
        configurable: true,
        get: () => new URL(req.url, "http://localhost").pathname,
    });
    return req;
}

function createResponse(resolve: (status: number) => void): Response {
    const headers = new Map<string, number | string | readonly string[]>();
    const res = {
        headersSent: false,
        statusCode: 200,
        appendHeader(name: string, value: string) {
            headers.set(name.toLowerCase(), value);
            return this;
        },
        end() {
            this.headersSent = true;
            resolve(this.statusCode);
            return this;
        },
        getHeader(name: string) {
            return headers.get(name.toLowerCase());
        },
        json() {
            return this.end();
        },
        removeHeader(name: string) {
            headers.delete(name.toLowerCase());
        },
        send() {
            return this.end();
        },
        setHeader(name: string, value: number | string | readonly string[]) {
            headers.set(name.toLowerCase(), value);
            return this;
        },
        status(statusCode: number) {
            this.statusCode = statusCode;
            return this;
        },
    };
    return res as unknown as Response;
}

async function send(
    method: string,
    path: string,
    key: string,
): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const req = createRequest(method, path, key);
        const res = createResponse(resolve);
        router(req, res, (error?: unknown) => {
            if (error) reject(error);
            else resolve(res.statusCode);
        });
    });
}

async function statuses(
    method: string,
    path: string,
    key: string,
    count: number,
): Promise<number[]> {
    if (count < 1 || count > MAX_STATUS_REQUESTS) {
        throw new RangeError(
            `count must be between 1 and ${MAX_STATUS_REQUESTS}`,
        );
    }
    const results: number[] = [];
    for (let index = 0; index < MAX_STATUS_REQUESTS; index += 1) {
        if (index >= count) break;
        results.push(await send(method, path, key));
    }
    return results;
}

describe("library route table", () => {
    it("matches the locked route surface", () => {
        const table = buildRouteTable();
        const routeCount = table.filter((entry) => "method" in entry).length;

        expect(routeCount).toBe(EXPECTED_LIBRARY_ROUTE_COUNT);
        expect(table).toMatchSnapshot();
    });

    it("registers every route with a named handler", () => {
        const handlerNames = getTerminalHandlerNames();
        const exportedHandlerNames = handlerModules
            .flatMap((module) => Object.values(module))
            .filter(
                (value): value is (...args: never[]) => unknown =>
                    typeof value === "function" &&
                    /^handle[A-Z]/.test(value.name),
            )
            .map((handler) => handler.name);

        expect(handlerNames).toHaveLength(EXPECTED_LIBRARY_ROUTE_COUNT);
        expect(handlerNames.every((name) => /^handle[A-Z]/.test(name))).toBe(
            true,
        );
        expect(new Set(exportedHandlerNames)).toEqual(new Set(handlerNames));
    });

    it("routes every registered handler through exactly one limiter class", async () => {
        const registeredRoutes = buildRouteTable().filter(
            (route): route is RouteTableEntry => "method" in route,
        );
        expect(registeredRoutes).toHaveLength(EXPECTED_LIBRARY_ROUTE_COUNT);
        for (let index = 0; index < EXPECTED_LIBRARY_ROUTE_COUNT; index += 1) {
            const route = registeredRoutes[index];
            if (!route)
                throw new Error(`missing library route at index ${index}`);
            const key = `route-${route.method}-${route.path}`;

            await send(route.method, testPath(route.path), key);

            expect(
                mockMiddlewareTrace
                    .get(key)
                    ?.filter((name) => limiterNames.has(name)),
            ).toEqual([expectedLimiter(route.path)]);
        }
    });

    it("keeps cover and stream requests available after metadata exhaustion", async () => {
        const key = "metadata-isolation";

        expect(
            await statuses("GET", "/tracks/item-1/preference", key, 3),
        ).toEqual([401, 401, 429]);
        expect(await send("GET", "/tracks/item-1/stream", key)).toBe(401);
        expect(await send("GET", "/cover-art/item-1", key)).toBe(401);
    });

    it("keeps metadata available after cover exhaustion", async () => {
        const key = "cover-isolation";

        expect(await statuses("GET", "/cover-art/item-1", key, 2)).toEqual([
            401, 429,
        ]);
        expect(await send("GET", "/tracks/item-1", key)).toBe(401);
    });

    it("classifies mixed-case media paths away from the metadata budget", async () => {
        const key = "mixed-case-isolation";

        expect(await send("GET", "/COVER-ART/item-1", key)).toBe(401);
        expect(await send("GET", "/TRACKS/item-1/STREAM", key)).toBe(401);
        expect(
            mockMiddlewareTrace
                .get(key)
                ?.filter((name) => limiterNames.has(name)),
        ).toEqual(["coverArtLimiter", "streamingLimiter"]);
    });

    it("counts an after-media metadata request exactly once", async () => {
        expect(
            await statuses(
                "GET",
                "/tracks/item-1/preference",
                "single-metadata-count",
                3,
            ),
        ).toEqual([401, 401, 429]);
    });

    it("counts unauthenticated requests before authentication", async () => {
        const key = "limiter-before-auth";

        expect(await statuses("GET", "/tracks", key, 3)).toEqual([
            401, 401, 429,
        ]);
        expect(mockMiddlewareTrace.get(key)?.slice(0, 2)).toEqual([
            "libraryMetadataLimiter",
            "requireAuthOrToken",
        ]);
    });
});
