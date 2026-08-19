import { type Request, type Response } from "express";

const passThrough = (_req: Request, _res: Response, next: () => void): void => {
    next();
};

jest.mock("../../middleware/subsonicAuth", () => ({
    ...jest.requireActual("../../middleware/subsonicAuth"),
    subsonicRateLimiter: passThrough,
}));

const findUser = jest.fn();
const findArtist = jest.fn();
const findAlbum = jest.fn();
const comparePassword = jest.fn();
const runDummyBcrypt = jest.fn().mockResolvedValue(undefined);
const traceLog = { warn: jest.fn() };
const authLog = { debug: jest.fn() };

jest.mock("../../utils/db", () => ({
    prisma: {
        user: { findUnique: (...args: unknown[]) => findUser(...args) },
        artist: { findFirst: (...args: unknown[]) => findArtist(...args) },
        album: { findFirst: (...args: unknown[]) => findAlbum(...args) },
        appPassword: {
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
        },
        apiKey: {
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({}),
        },
    },
}));

jest.mock("bcrypt", () => ({
    __esModule: true,
    default: { compare: (...args: unknown[]) => comparePassword(...args) },
}));

jest.mock("../../utils/dummyCredential", () => ({ runDummyBcrypt }));

jest.mock("../../utils/encryption", () => ({
    decrypt: jest.fn((value: string) => value),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn((scope: string) =>
            scope === "SubsonicTrace" ? traceLog : authLog,
        ),
    },
}));

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

jest.mock("../../services/federationStreamProxy", () => ({
    proxyFederatedTrackStream: jest.fn(),
}));

jest.mock("../../services/federationCoverProxy", () => ({
    proxyFederatedCover: jest.fn(),
}));

jest.mock("../../config", () => ({
    config: {
        subsonicTraceLogs: true,
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
    statusCode: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function createResponse(): CapturedResponse {
    let finishHandler: (() => void) | undefined;
    const response = {
        locals: {},
        statusCode: 200,
        status: jest.fn(),
        setHeader: jest.fn(),
        type: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
        on: jest.fn((event: string, handler: () => void) => {
            if (event === "finish") finishHandler = handler;
        }),
    } as unknown as CapturedResponse;
    (response.status as jest.Mock).mockImplementation((statusCode: number) => {
        response.statusCode = statusCode;
        return response;
    });
    (response.type as jest.Mock).mockReturnValue(response);
    (response.send as jest.Mock).mockImplementation((body: string) => {
        response.body = body;
        finishHandler?.();
        return response;
    });
    (response.json as jest.Mock).mockImplementation((body: unknown) => {
        response.jsonBody = body;
        finishHandler?.();
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

interface PostOptions {
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
}

const validFormCredentials = {
    u: "alice",
    p: "correct-password",
    v: "1.16.1",
    c: "compat-test",
    f: "json",
};

async function executePost(
    path: string,
    options: PostOptions = {},
): Promise<CapturedResponse> {
    const req = {
        method: "POST",
        path,
        query: options.query ?? {},
        body: options.body ?? validFormCredentials,
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
    beforeEach(() => {
        jest.clearAllMocks();
        findUser.mockResolvedValue({
            id: "user-1",
            username: "alice",
            role: "user",
            passwordHash: "stored-hash",
            subsonicPassword: null,
        });
        findArtist.mockResolvedValue({
            mbid: "artist-mbid",
            summary: "Artist biography",
            heroUrl: null,
            similarFrom: [],
        });
        findAlbum.mockResolvedValue({
            rgMbid: "album-mbid",
            title: "Album notes",
            coverUrl: null,
        });
        comparePassword.mockImplementation(
            async (provided: string) => provided === "correct-password",
        );
        runDummyBcrypt.mockResolvedValue(undefined);
    });

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

    it.each([
        "/getArtistInfo",
        "/getArtistInfo.view",
        "/rest/getArtistInfo",
        "/rest/getArtistInfo.view",
    ])("routes classic artist-info alias %s", async (path) => {
        const response = await executePost(path, {
            body: { ...validFormCredentials, id: "ar-artist-1" },
        });

        expect(parseJsonEnvelope(response)).toEqual(
            expect.objectContaining({
                artistInfo: expect.objectContaining({
                    biography: "Artist biography",
                }),
            }),
        );
    });

    it.each([
        "/getAlbumInfo",
        "/getAlbumInfo.view",
        "/rest/getAlbumInfo",
        "/rest/getAlbumInfo.view",
    ])("routes classic album-info alias %s", async (path) => {
        const response = await executePost(path, {
            body: { ...validFormCredentials, id: "al-album-1" },
        });

        expect(parseJsonEnvelope(response)).toEqual(
            expect.objectContaining({
                albumInfo: expect.objectContaining({ notes: "Album notes" }),
            }),
        );
    });

    it("authenticates valid form credentials through the real middleware", async () => {
        const response = await executePost("/getLicense");
        const envelope = parseJsonEnvelope(response);

        expect(envelope).toEqual(expect.objectContaining({ status: "ok" }));
        expect(comparePassword).toHaveBeenCalledWith(
            "correct-password",
            "stored-hash",
        );
    });

    it("returns the uniform Subsonic auth error for invalid form credentials", async () => {
        const wrongPassword = await executePost("/getLicense", {
            body: { ...validFormCredentials, p: "wrong-password" },
        });
        findUser.mockResolvedValueOnce(null);
        const unknownUser = await executePost("/getLicense", {
            body: {
                ...validFormCredentials,
                u: "unknown-user",
                p: "another-wrong-password",
            },
        });

        expect(parseJsonEnvelope(wrongPassword)).toEqual(
            expect.objectContaining({
                status: "failed",
                error: { code: 40, message: "Wrong username or password" },
            }),
        );
        expect(parseJsonEnvelope(unknownUser)).toEqual(
            expect.objectContaining({
                status: "failed",
                error: { code: 40, message: "Wrong username or password" },
            }),
        );
    });

    it("keeps query credentials authoritative over form credentials", async () => {
        const queryWins = await executePost("/getLicense", {
            query: { p: "correct-password" },
            body: { ...validFormCredentials, p: "wrong-password" },
        });
        const invalidQueryWins = await executePost("/getLicense", {
            query: { p: "wrong-password" },
            body: validFormCredentials,
        });

        expect(parseJsonEnvelope(queryWins)).toEqual(
            expect.objectContaining({ status: "ok" }),
        );
        expect(parseJsonEnvelope(invalidQueryWins)).toEqual(
            expect.objectContaining({ status: "failed" }),
        );
    });

    it("sanitizes bounded trace fields without logging credentials", async () => {
        const secrets = {
            p: "password-secret",
            t: "token-secret",
            s: "salt-secret",
            apiKey: "api-key-secret",
        };
        await executePost("/getLicense", {
            body: {
                ...validFormCredentials,
                ...secrets,
                c: "client\r\n\u2028forged\u2029-entry",
                v: "v".repeat(100),
                f: "json\r\n\u2028forged\u2029-format",
            },
        });

        expect(traceLog.warn).toHaveBeenCalledWith(
            "Subsonic request completed",
            expect.objectContaining({
                client: "clientforged-entry",
                version: "v".repeat(64),
                format: "jsonforged-format",
            }),
        );
        const serializedLogs = JSON.stringify(traceLog.warn.mock.calls);
        expect(serializedLogs).not.toMatch(/[\r\n\u2028\u2029]/);
        for (const secret of Object.values(secrets)) {
            expect(serializedLogs).not.toContain(secret);
        }
        expect(serializedLogs).not.toMatch(/"(?:p|t|s|apiKey)"/);
    });
});

function parseJsonEnvelope(
    response: CapturedResponse,
): Record<string, unknown> {
    if (typeof response.body !== "string") {
        throw new Error("Expected a serialized Subsonic response");
    }
    const body = JSON.parse(response.body) as Record<string, unknown>;
    const envelope = body["subsonic-response"];
    if (!isRecord(envelope)) throw new Error("Expected Subsonic envelope");
    return envelope;
}
