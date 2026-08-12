import type { NextFunction, Request, RequestHandler, Response } from "express";

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
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) {
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: function apiLimiter(
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) {
        next();
    },
    imageLimiter: function imageLimiter(
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) {
        next();
    },
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

jest.mock("../../utils/redis", () => ({
    redisClient: {},
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {},
}));

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

import router from "../library";
import * as albums from "../library/albums";
import * as artistCounts from "../library/artistCounts";
import * as artists from "../library/artists";
import * as coverArt from "../library/coverArt";
import * as imageBackfill from "../library/imageBackfill";
import * as maintenance from "../library/maintenance";
import * as metadataBackfill from "../library/metadataBackfill";
import * as radio from "../library/radio";
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

const isNamedFunction = (name: string | undefined): name is string =>
    Boolean(name && name !== "<anonymous>");

const getRouterStack = (): RouteLayer[] =>
    (router as unknown as { stack: RouteLayer[] }).stack;

const getRouteLayers = (): RegisteredRouteLayer[] =>
    flattenLibraryRouteLayers(router) as RegisteredRouteLayer[];

const buildRouteTable = (): Array<RouteTableEntry | RouterMiddlewareEntry> => {
    const stack = getRouterStack();
    const routerMiddleware = stack
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

const getTerminalHandlerNames = (): string[] => {
    return getRouteLayers().map(
        (layer) => layer.route.stack.at(-1)?.handle?.name ?? "",
    );
};

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
];

describe("library route table", () => {
    it("matches the locked route surface", () => {
        const table = buildRouteTable();
        const routeCount = table.filter((entry) => "method" in entry).length;

        expect(routeCount).toBe(36);
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

        expect(handlerNames).toHaveLength(36);
        expect(handlerNames.every((name) => /^handle[A-Z]/.test(name))).toBe(
            true,
        );
        expect(new Set(exportedHandlerNames)).toEqual(new Set(handlerNames));
    });
});
