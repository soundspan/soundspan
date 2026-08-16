import { type Request, type Response } from "express";

const passThrough = (req: Request, _res: Response, next: () => void): void => {
    req.user = { id: "user-1", username: "alice", role: "user" };
    next();
};

jest.mock("../../middleware/subsonicAuth", () => ({
    requireSubsonicAuth: passThrough,
    subsonicRateLimiter: passThrough,
}));

const prisma = {
    user: {
        findUnique: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({ prisma }));

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

import subsonicRouter from "../subsonic";
import { handlePing } from "../subsonic/system";
import { handleGetMusicFolders } from "../subsonic/browsing";
import { handleGetSimilarSongs } from "../subsonic/discovery";
import { handleGetAlbumList } from "../subsonic/albumSongLists";
import { handleSearch2 } from "../subsonic/searching";
import { handleCreatePlaylist } from "../subsonic/playlists";
import { handleGetLyrics } from "../subsonic/mediaRetrieval";
import { handleSetRating } from "../subsonic/mediaAnnotation";
import { handleCreateBookmark } from "../subsonic/bookmarksQueue";
import { handleGetUser } from "../subsonic/usersMisc";

type ProtocolStatus = "ok" | "failed";

interface BoundaryCase {
    name: string;
    path: string;
    status: ProtocolStatus;
    handler: (req: Request, res: Response) => unknown;
}

const boundaryCases: BoundaryCase[] = [
    {
        name: "system",
        path: "/ping?f=json",
        status: "ok",
        handler: handlePing,
    },
    {
        name: "browsing",
        path: "/getMusicFolders.view?f=json",
        status: "ok",
        handler: handleGetMusicFolders,
    },
    {
        name: "discovery",
        path: "/rest/getSimilarSongs?id=ar-a1&musicFolderId=2&f=json",
        status: "ok",
        handler: handleGetSimilarSongs,
    },
    {
        name: "album and song lists",
        path: "/getAlbumList?f=json",
        status: "failed",
        handler: handleGetAlbumList,
    },
    {
        name: "searching",
        path: "/rest/search2.view?f=json",
        status: "failed",
        handler: handleSearch2,
    },
    {
        name: "playlists",
        path: "/createPlaylist?f=json",
        status: "failed",
        handler: handleCreatePlaylist,
    },
    {
        name: "media retrieval",
        path: "/getLyrics.view?f=json",
        status: "failed",
        handler: handleGetLyrics,
    },
    {
        name: "media annotation",
        path: "/rest/setRating?f=json",
        status: "failed",
        handler: handleSetRating,
    },
    {
        name: "bookmarks and queue",
        path: "/createBookmark.view?f=json",
        status: "failed",
        handler: handleCreateBookmark,
    },
    {
        name: "users and miscellaneous",
        path: "/rest/getUser.view?f=json",
        status: "ok",
        handler: handleGetUser,
    },
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function matchesPath(routePath: unknown, path: string): boolean {
    if (routePath === path) return true;
    return Array.isArray(routePath) && routePath.includes(path);
}

function createResponse(): Response & { body?: string } {
    const response = {
        locals: {},
        status: jest.fn(),
        set: jest.fn(),
        setHeader: jest.fn(),
        type: jest.fn(),
        send: jest.fn(),
    } as unknown as Response & { body?: string };
    (response.status as jest.Mock).mockReturnValue(response);
    (response.set as jest.Mock).mockReturnValue(response);
    (response.type as jest.Mock).mockReturnValue(response);
    (response.send as jest.Mock).mockImplementation((body: string) => {
        response.body = body;
        return response;
    });
    return response;
}

function createRequest(parsedUrl: URL): Request {
    return {
        method: "GET",
        path: parsedUrl.pathname,
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
    } as unknown as Request;
}

function getRouterStack(): unknown[] {
    const stackValue: unknown = Reflect.get(subsonicRouter, "stack");
    if (!Array.isArray(stackValue)) throw new Error("Router stack not found");
    return stackValue;
}

function getRouteHandlers(route: Record<string, unknown>): Function[] {
    if (!Array.isArray(route.stack)) return [];
    return route.stack
        .filter(isRecord)
        .map((layer) => layer.handle)
        .filter(
            (handler): handler is Function => typeof handler === "function",
        );
}

function collectHandlers(
    path: string,
    expectedHandler: BoundaryCase["handler"],
): Function[] {
    const handlers: Function[] = [];
    for (const entryValue of getRouterStack()) {
        if (!isRecord(entryValue)) continue;
        if (!isRecord(entryValue.route)) {
            if (typeof entryValue.handle === "function")
                handlers.push(entryValue.handle);
            continue;
        }

        const route = entryValue.route;
        if (!matchesPath(route.path, path)) continue;
        if (!isRecord(route.methods) || route.methods.get !== true) continue;
        const routeHandlers = getRouteHandlers(route);
        expect(routeHandlers).toContain(expectedHandler);
        handlers.push(...routeHandlers);
        break;
    }
    return handlers;
}

const MAX_ROUTER_HANDLERS = 10;

async function dispatchHandlers(
    handlers: Function[],
    req: Request,
    res: Response,
): Promise<void> {
    for (let index = 0; index < MAX_ROUTER_HANDLERS; index += 1) {
        const handler = handlers[index];
        if (!handler) return;
        let nextCalled = false;
        let nextError: unknown;
        await Reflect.apply(handler, undefined, [
            req,
            res,
            (error?: unknown) => {
                nextError = error;
                nextCalled = true;
            },
        ]);
        if (nextError) throw nextError;
        if (!nextCalled) return;
    }
    throw new Error("Router handler bound exceeded");
}

async function executeGet(
    url: string,
    expectedHandler: BoundaryCase["handler"],
): Promise<Record<string, unknown>> {
    const parsedUrl = new URL(url, "http://soundspan.test");
    const req = createRequest(parsedUrl);
    const res = createResponse();
    const handlers = collectHandlers(parsedUrl.pathname, expectedHandler);
    await dispatchHandlers(handlers, req, res);

    if (!responseHasJsonBody(res)) throw new Error("JSON response not sent");
    return JSON.parse(res.body) as Record<string, unknown>;
}

function responseHasJsonBody(
    response: Response & { body?: string },
): response is Response & { body: string } {
    return typeof response.body === "string";
}

describe("subsonic domain module boundaries", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.user.findUnique.mockResolvedValue({
            username: "alice",
            role: "user",
        });
    });

    it.each(boundaryCases)(
        "serves one $name endpoint through the composed router",
        async ({ path, status, handler }) => {
            expect(typeof handler).toBe("function");

            const response = await executeGet(path, handler);

            expect(response["subsonic-response"]).toEqual(
                expect.objectContaining({ status }),
            );
        },
    );
});
