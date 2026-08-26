import type { NextFunction, Request, Response } from "express";

const status = jest.fn();
const saveToken = jest.fn();
const startAuth = jest.fn();
const completeAuth = jest.fn();
const disconnect = jest.fn();
const setEnabled = jest.fn();

class InvalidListenBrainzTokenError extends Error {}
class LastFmServerConfigurationError extends Error {}
class LastFmAuthStateError extends Error {
    constructor(message = "No pending Last.fm authorization was found") {
        super(message);
    }
}
class LastFmCredentialsRejectedError extends Error {
    constructor() {
        super(
            "The server's Last.fm API key or shared secret was rejected by Last.fm",
        );
    }
}
class ScrobbleProviderRequestError extends Error {
    constructor(public readonly service: "Last.fm" | "ListenBrainz") {
        super(`${service} request failed`);
    }
}

const requireAuth = (_req: Request, _res: Response, next: NextFunction) =>
    next();
const authLimiter = (_req: Request, _res: Response, next: NextFunction) =>
    next();

jest.mock("../../middleware/auth", () => ({ requireAuth }));
jest.mock("../../middleware/rateLimiter", () => ({ authLimiter }));
jest.mock("../../services/scrobbleConnections", () => ({
    getScrobblingStatus: status,
    saveListenBrainzToken: saveToken,
    startLastFmAuth: startAuth,
    completeLastFmAuth: completeAuth,
    disconnectScrobbler: disconnect,
    setScrobblerEnabled: setEnabled,
    InvalidListenBrainzTokenError,
    LastFmServerConfigurationError,
    LastFmAuthStateError,
    LastFmCredentialsRejectedError,
    ScrobbleProviderRequestError,
}));

import router from "../scrobbling";

type HttpMethod = "get" | "put" | "post" | "patch" | "delete";

function routeStack(path: string, method: HttpMethod): any[] {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route.methods[method] === true,
    );
    if (!layer) throw new Error(`Missing ${method} ${path}`);
    return layer.route.stack;
}

function createResponse() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
        end: jest.fn(() => res),
    };
    return res;
}

async function invoke(path: string, method: HttpMethod, body: unknown = {}) {
    const req: any = {
        body,
        user: { id: "user-1", username: "tester", role: "user" },
    };
    const res = createResponse();
    const stack = routeStack(path, method);
    for (let index = 0; index < 4; index += 1) {
        const layer = stack[index];
        if (!layer) break;
        let nextCalled = false;
        let nextError: unknown;
        await layer.handle(req, res, (error?: unknown) => {
            nextCalled = true;
            nextError = error;
        });
        if (nextError) throw nextError;
        if (!nextCalled) break;
    }
    return res;
}

describe("scrobbling routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        status.mockResolvedValue({
            lastfm: {
                connected: true,
                enabled: true,
                username: "listener",
                serverConfigured: true,
                apiKeyConfigured: true,
                sharedSecretConfigured: true,
            },
            listenbrainz: { connected: true, enabled: false },
        });
        saveToken.mockResolvedValue(undefined);
    });

    it("mounts authentication before every route", () => {
        expect((router as any).stack[0].handle).toBe(requireAuth);
    });

    it.each([
        ["/listenbrainz", "put"],
        ["/lastfm/start-auth", "post"],
        ["/lastfm/complete-auth", "post"],
    ] as const)("mounts authLimiter first on %s", (path, method) => {
        expect(routeStack(path, method)[0].handle).toBe(authLimiter);
    });

    it("returns status without credentials or pending tokens", async () => {
        const response = await invoke("/", "get");

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({
            lastfm: {
                connected: true,
                enabled: true,
                username: "listener",
                serverConfigured: true,
                apiKeyConfigured: true,
                sharedSecretConfigured: true,
            },
            listenbrainz: { connected: true, enabled: false },
        });
        expect(JSON.stringify(response.body)).not.toMatch(
            /encryptedCredential|encryptedPendingToken|"(?:token|apiKey|sharedSecret|signature)":/i,
        );
    });

    it("validates and saves a ListenBrainz token", async () => {
        const response = await invoke("/listenbrainz", "put", {
            token: "user-token",
        });

        expect(response.statusCode).toBe(200);
        expect(saveToken).toHaveBeenCalledWith("user-1", "user-token");
        expect(response.body).toEqual({ connected: true, enabled: true });
    });

    it("returns 422 for an invalid ListenBrainz token", async () => {
        saveToken.mockRejectedValue(new InvalidListenBrainzTokenError());

        const response = await invoke("/listenbrainz", "put", {
            token: "invalid",
        });

        expect(response.statusCode).toBe(422);
        expect(response.body).toEqual({
            error: "ListenBrainz rejected the token",
        });
    });

    it.each(["start-auth", "complete-auth"])(
        "returns 409 when Last.fm server keys are absent for %s",
        async (operation) => {
            const error = new LastFmServerConfigurationError(
                "Last.fm scrobbling is not configured on this server",
            );
            if (operation === "start-auth") startAuth.mockRejectedValue(error);
            else completeAuth.mockRejectedValue(error);

            const response = await invoke(`/lastfm/${operation}`, "post");

            expect(response.statusCode).toBe(409);
            expect(response.body).toEqual({
                error: "Last.fm scrobbling is not configured on this server",
            });
        },
    );

    it("returns 409 when Last.fm completion loses the pending-token race", async () => {
        completeAuth.mockRejectedValue(new LastFmAuthStateError());

        const response = await invoke("/lastfm/complete-auth", "post");

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({
            error: "No pending Last.fm authorization was found",
        });
    });

    it("returns 409 when Last.fm credentials are rejected", async () => {
        startAuth.mockRejectedValue(new LastFmCredentialsRejectedError());

        const response = await invoke("/lastfm/start-auth", "post");

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({
            error: "The server's Last.fm API key or shared secret was rejected by Last.fm",
        });
    });

    it("returns 409 with approval guidance for an unauthorized Last.fm token", async () => {
        completeAuth.mockRejectedValue(
            new LastFmAuthStateError(
                "Approve access in the Last.fm tab, then try again",
            ),
        );

        const response = await invoke("/lastfm/complete-auth", "post");

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({
            error: "Approve access in the Last.fm tab, then try again",
        });
    });

    it("returns 502 when Last.fm does not respond", async () => {
        startAuth.mockRejectedValue(
            new ScrobbleProviderRequestError("Last.fm"),
        );

        const response = await invoke("/lastfm/start-auth", "post");

        expect(response.statusCode).toBe(502);
        expect(response.body).toEqual({
            error: "Last.fm did not respond. Try again in a moment.",
        });
    });

    it("returns 502 when ListenBrainz does not respond", async () => {
        saveToken.mockRejectedValue(
            new ScrobbleProviderRequestError("ListenBrainz"),
        );

        const response = await invoke("/listenbrainz", "put", {
            token: "user-token",
        });

        expect(response.statusCode).toBe(502);
        expect(response.body).toEqual({
            error: "ListenBrainz did not respond. Try again in a moment.",
        });
    });
});
