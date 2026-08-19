import assert from "node:assert/strict";
import test, {
    after,
    afterEach,
    beforeEach,
    type TestContext,
} from "node:test";
import { ApiClientCore } from "../../lib/api/core";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROACTIVE_REFRESH_DELAY_MS = DAY_MS * 0.8;
const INITIAL_REFRESH_BACKOFF_MS = 60_000;
const START_TIME_MS = 1_800_000_000_000;

class TestApiClient extends ApiClientCore {}

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length(): number {
        return this.values.size;
    }

    clear(): void {
        this.values.clear();
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
}

const browserWindow = new EventTarget();
const browserDocument = new EventTarget();
const storage = new MemoryStorage();
let visibilityState: DocumentVisibilityState = "visible";
const clients: TestApiClient[] = [];

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
);
const originalLocalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
);

Object.defineProperty(browserDocument, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
});
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: browserWindow,
});
Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: browserDocument,
});
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
});

function restoreGlobal(
    key: "window" | "document" | "localStorage",
    descriptor: PropertyDescriptor | undefined,
): void {
    if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
        return;
    }
    Reflect.deleteProperty(globalThis, key);
}

function createToken(expiresAtMs: number): string {
    const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
    ).toString("base64url");
    return `header.${payload}.signature`;
}

function createClient(): TestApiClient {
    const client = new TestApiClient("http://soundspan.test");
    clients.push(client);
    return client;
}

function setVisibility(nextVisibility: DocumentVisibilityState): void {
    visibilityState = nextVisibility;
    browserDocument.dispatchEvent(new Event("visibilitychange"));
}

function mockRefreshEndpoint(testContext: TestContext) {
    return testContext.mock.method(globalThis, "fetch", async () => {
        const token = createToken(Date.now() + DAY_MS);
        return Response.json({ token, refreshToken: "rotated-refresh" });
    });
}

function trackSessionExpiry(): { count: () => number; stop: () => void } {
    let eventCount = 0;
    const listener = () => {
        eventCount += 1;
    };
    browserWindow.addEventListener("auth:session-expired", listener);
    return {
        count: () => eventCount,
        stop: () =>
            browserWindow.removeEventListener("auth:session-expired", listener),
    };
}

async function flushAsyncWork(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await Promise.resolve();
    }
}

beforeEach((testContext) => {
    storage.clear();
    visibilityState = "visible";
    if (!("mock" in testContext)) {
        throw new Error("test mock context is unavailable");
    }
    testContext.mock.timers.enable({
        apis: ["Date", "setTimeout"],
        now: START_TIME_MS,
    });
});

afterEach(() => {
    for (const client of clients.splice(0)) {
        client.clearToken();
    }
});

after(() => {
    restoreGlobal("window", originalWindow);
    restoreGlobal("document", originalDocument);
    restoreGlobal("localStorage", originalLocalStorage);
});

test("refreshes once at 80% of a token's remaining 24-hour lifetime", async (testContext) => {
    const fetchMock = mockRefreshEndpoint(testContext);
    const client = createClient();
    const initialToken = createToken(START_TIME_MS + DAY_MS);

    client.setToken(initialToken, "refresh-token");
    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS - 1);
    assert.equal(fetchMock.mock.callCount(), 0);

    testContext.mock.timers.tick(1);
    await flushAsyncWork();

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.notEqual(client.getToken(), initialToken);
    assert.equal(localStorage.getItem("auth_token"), client.getToken());
});

test("re-arms proactive refresh after each successful refresh", async (testContext) => {
    const fetchMock = mockRefreshEndpoint(testContext);
    const client = createClient();

    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-token");
    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 2);
});

test("clearing tokens cancels the pending proactive refresh", async (testContext) => {
    const fetchMock = mockRefreshEndpoint(testContext);
    const client = createClient();

    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-token");
    client.clearToken();
    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();

    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(client.getToken(), null);
});

test("refreshes on visibility catch-up after a hidden timer is delayed", async (testContext) => {
    const fetchMock = mockRefreshEndpoint(testContext);
    const client = createClient();

    setVisibility("hidden");
    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-token");
    testContext.mock.timers.setTime(
        START_TIME_MS + PROACTIVE_REFRESH_DELAY_MS + 1,
    );
    assert.equal(fetchMock.mock.callCount(), 0);

    setVisibility("visible");
    await flushAsyncWork();

    assert.equal(fetchMock.mock.callCount(), 1);
});

test("simultaneous proactive triggers share one in-flight refresh", async (testContext) => {
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
    });
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () => {
        await fetchGate;
        return Response.json({
            token: createToken(Date.now() + DAY_MS),
            refreshToken: "rotated-refresh",
        });
    });
    const client = createClient();

    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-token");
    testContext.mock.timers.setTime(
        START_TIME_MS + PROACTIVE_REFRESH_DELAY_MS + 1,
    );
    setVisibility("visible");
    setVisibility("visible");
    await Promise.resolve();

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(releaseFetch);
    releaseFetch();
    await flushAsyncWork();
});

test("does not replay a stale session mutation after a replacement login", async (testContext) => {
    let resolveSessionARequest: ((response: Response) => void) | undefined;
    const sessionAResponse = new Promise<Response>((resolve) => {
        resolveSessionARequest = resolve;
    });
    let dangerRequestCount = 0;
    let refreshRequestCount = 0;
    const authorizations: Array<string | null> = [];
    const fetchMock = testContext.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith("/api/auth/refresh")) {
                refreshRequestCount += 1;
                return Response.json({
                    token: "access-b-rotated",
                    refreshToken: "refresh-b-rotated",
                });
            }

            dangerRequestCount += 1;
            authorizations.push(
                new Headers(init?.headers).get("Authorization"),
            );
            return dangerRequestCount === 1
                ? sessionAResponse
                : Response.json({ ok: true });
        },
    );
    const sessionExpiry = trackSessionExpiry();
    const client = createClient();

    try {
        client.setToken("access-a", "refresh-a");
        const sessionARequest = client.post("/danger", { destructive: true });
        await flushAsyncWork();
        assert.equal(fetchMock.mock.callCount(), 1);
        assert.deepEqual(authorizations, ["Bearer access-a"]);

        client.clearToken();
        client.setToken("access-b", "refresh-b");
        assert.ok(resolveSessionARequest);
        resolveSessionARequest(
            Response.json(
                { error: "Not authenticated", code: "AUTH_REQUIRED" },
                { status: 401 },
            ),
        );

        await assert.rejects(sessionARequest, (error: unknown) => {
            assert.ok(error instanceof Error);
            const apiError = error as Error & {
                status?: number;
                data?: Record<string, unknown>;
            };
            assert.equal(apiError.status, 401);
            assert.equal(apiError.data?.code, "AUTH_REQUIRED");
            return true;
        });

        assert.equal(dangerRequestCount, 1);
        assert.equal(refreshRequestCount, 0);
        assert.equal(client.getToken(), "access-b");
        assert.equal(client.getRefreshToken(), "refresh-b");
        assert.equal(sessionExpiry.count(), 0);
    } finally {
        sessionExpiry.stop();
    }
});

test("a pre-login request cannot replay under a later session", async (testContext) => {
    let resolveAnonymousRequest: ((response: Response) => void) | undefined;
    const anonymousResponse = new Promise<Response>((resolve) => {
        resolveAnonymousRequest = resolve;
    });
    let dangerRequestCount = 0;
    let refreshRequestCount = 0;
    const fetchMock = testContext.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL) => {
            if (String(input).endsWith("/api/auth/refresh")) {
                refreshRequestCount += 1;
                return Response.json({
                    token: "access-b-rotated",
                    refreshToken: "refresh-b-rotated",
                });
            }
            dangerRequestCount += 1;
            return dangerRequestCount === 1
                ? anonymousResponse
                : Response.json({ ok: true });
        },
    );
    const sessionExpiry = trackSessionExpiry();
    const client = createClient();

    try {
        const anonymousRequest = client.post("/danger", { destructive: true });
        await flushAsyncWork();
        assert.equal(fetchMock.mock.callCount(), 1);

        client.setToken("access-b", "refresh-b");
        assert.ok(resolveAnonymousRequest);
        resolveAnonymousRequest(
            Response.json(
                { error: "Not authenticated", code: "AUTH_REQUIRED" },
                { status: 401 },
            ),
        );

        await assert.rejects(anonymousRequest, (error: unknown) => {
            assert.ok(error instanceof Error);
            const apiError = error as Error & { status?: number };
            assert.equal(apiError.status, 401);
            return true;
        });

        assert.equal(dangerRequestCount, 1);
        assert.equal(refreshRequestCount, 0);
        assert.equal(client.getToken(), "access-b");
        assert.equal(client.getRefreshToken(), "refresh-b");
        assert.equal(sessionExpiry.count(), 0);
    } finally {
        sessionExpiry.stop();
    }
});

test("stale refresh success cannot overwrite a replacement session", async (testContext) => {
    let resolveSessionARefresh: ((response: Response) => void) | undefined;
    const sessionARefresh = new Promise<Response>((resolve) => {
        resolveSessionARefresh = resolve;
    });
    let sessionBRefreshCount = 0;
    const fetchMock = testContext.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith("/api/auth/refresh")) {
                const body = JSON.parse(String(init?.body)) as {
                    refreshToken: string;
                };
                if (body.refreshToken === "refresh-a") {
                    return sessionARefresh;
                }
                assert.equal(body.refreshToken, "refresh-b");
                sessionBRefreshCount += 1;
                return Response.json({
                    token: "access-b-rotated",
                    refreshToken: "refresh-b-rotated",
                });
            }

            const authorization = new Headers(init?.headers).get(
                "Authorization",
            );
            if (authorization?.endsWith("-rotated")) {
                return Response.json({ ok: true });
            }
            return Response.json(
                { error: "Not authenticated", code: "AUTH_REQUIRED" },
                { status: 401 },
            );
        },
    );
    const client = createClient();

    client.setToken("access-a", "refresh-a");
    const sessionARequest = client.get("/session-a");
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 2);

    client.clearToken();
    client.setToken("access-b", "refresh-b");
    const sessionBRequest = client.get("/session-b");
    await flushAsyncWork();
    const detachedRefreshCount = sessionBRefreshCount;
    if (detachedRefreshCount === 1) {
        await sessionBRequest;
    }

    assert.ok(resolveSessionARefresh);
    resolveSessionARefresh(
        Response.json({
            token: "access-a-rotated",
            refreshToken: "refresh-a-rotated",
        }),
    );
    await Promise.allSettled([sessionARequest, sessionBRequest]);

    assert.equal(detachedRefreshCount, 1);
    assert.equal(client.getToken(), "access-b-rotated");
    assert.equal(client.getRefreshToken(), "refresh-b-rotated");
});

test("stale refresh rejection cannot expire a replacement session", async (testContext) => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
    });
    const sessionExpiry = trackSessionExpiry();
    const fetchMock = testContext.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL) => {
            if (String(input).endsWith("/api/auth/refresh")) {
                return refreshResponse;
            }
            return Response.json(
                { error: "Not authenticated", code: "AUTH_REQUIRED" },
                { status: 401 },
            );
        },
    );
    const client = createClient();

    try {
        client.setToken("access-a", "refresh-a");
        const sessionARequest = client.get("/session-a");
        await flushAsyncWork();
        assert.equal(fetchMock.mock.callCount(), 2);

        client.clearToken();
        client.setToken("access-b", "refresh-b");
        assert.ok(resolveRefresh);
        resolveRefresh(
            Response.json({ error: "Invalid refresh token" }, { status: 401 }),
        );
        await assert.rejects(sessionARequest);

        assert.equal(client.getToken(), "access-b");
        assert.equal(client.getRefreshToken(), "refresh-b");
        assert.equal(sessionExpiry.count(), 0);
    } finally {
        sessionExpiry.stop();
    }
});

test("stale transient refresh cannot alter replacement session scheduling or backoff", async (testContext) => {
    let resolveSessionARefresh: ((response: Response) => void) | undefined;
    const sessionARefresh = new Promise<Response>((resolve) => {
        resolveSessionARefresh = resolve;
    });
    let refreshCount = 0;
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () => {
        refreshCount += 1;
        if (refreshCount === 1) {
            return sessionARefresh;
        }
        if (refreshCount === 2) {
            return Response.json({ error: "Unavailable" }, { status: 503 });
        }
        return Response.json({
            token: createToken(Date.now() + DAY_MS),
            refreshToken: "refresh-b-rotated",
        });
    });
    const client = createClient();

    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-a");
    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    client.clearToken();
    client.setToken(createToken(Date.now() + DAY_MS), "refresh-b");
    assert.ok(resolveSessionARefresh);
    resolveSessionARefresh(
        Response.json({ error: "Unavailable" }, { status: 503 }),
    );
    await flushAsyncWork();

    testContext.mock.timers.tick(INITIAL_REFRESH_BACKOFF_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    testContext.mock.timers.tick(
        PROACTIVE_REFRESH_DELAY_MS - INITIAL_REFRESH_BACKOFF_MS,
    );
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 2);

    testContext.mock.timers.tick(INITIAL_REFRESH_BACKOFF_MS - 1);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 2);
    testContext.mock.timers.tick(1);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 3);
});

test("proactive refresh rejection expires the session exactly once", async (testContext) => {
    const sessionExpiry = trackSessionExpiry();
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () =>
        Response.json({ error: "Invalid refresh token" }, { status: 401 }),
    );
    const client = createClient();

    try {
        client.setToken(
            createToken(START_TIME_MS + DAY_MS),
            "rejected-refresh",
        );
        testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
        await flushAsyncWork();

        assert.equal(fetchMock.mock.callCount(), 1);
        assert.equal(client.getToken(), null);
        assert.equal(storage.getItem("refresh_token"), null);
        assert.equal(sessionExpiry.count(), 1);
    } finally {
        sessionExpiry.stop();
    }
});

test("visibility catch-up rejection expires the session", async (testContext) => {
    const sessionExpiry = trackSessionExpiry();
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () =>
        Response.json({ error: "Invalid refresh token" }, { status: 403 }),
    );
    const client = createClient();

    try {
        setVisibility("hidden");
        client.setToken(
            createToken(START_TIME_MS + DAY_MS),
            "rejected-refresh",
        );
        testContext.mock.timers.setTime(
            START_TIME_MS + PROACTIVE_REFRESH_DELAY_MS + 1,
        );
        setVisibility("visible");
        await flushAsyncWork();

        assert.equal(fetchMock.mock.callCount(), 1);
        assert.equal(sessionExpiry.count(), 1);
    } finally {
        sessionExpiry.stop();
    }
});

test("transient proactive failure defers timer and visibility retries", async (testContext) => {
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () =>
        Response.json(
            { error: "Authentication temporarily unavailable" },
            { status: 503 },
        ),
    );
    const client = createClient();

    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-token");
    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    testContext.mock.timers.tick(INITIAL_REFRESH_BACKOFF_MS - 1);
    setVisibility("visible");
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    testContext.mock.timers.tick(1);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 2);
});

test("429 retry scheduling honors Retry-After", async (testContext) => {
    const retryAfterSeconds = 5 * 60;
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () =>
        Response.json(
            { error: "Too many token refresh attempts", code: "RATE_LIMITED" },
            {
                status: 429,
                headers: { "Retry-After": String(retryAfterSeconds) },
            },
        ),
    );
    const client = createClient();

    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-token");
    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    testContext.mock.timers.tick(retryAfterSeconds * 1000 - 1);
    setVisibility("visible");
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 1);

    testContext.mock.timers.tick(1);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 2);
});

test("successful refresh resets transient backoff", async (testContext) => {
    let refreshCount = 0;
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () => {
        refreshCount += 1;
        if (refreshCount === 2 || refreshCount === 4) {
            return Response.json({
                token: createToken(Date.now() + DAY_MS),
                refreshToken: `rotated-${refreshCount}`,
            });
        }
        return Response.json({ error: "Unavailable" }, { status: 503 });
    });
    const client = createClient();

    client.setToken(createToken(START_TIME_MS + DAY_MS), "refresh-token");
    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();
    testContext.mock.timers.tick(INITIAL_REFRESH_BACKOFF_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 2);

    testContext.mock.timers.tick(PROACTIVE_REFRESH_DELAY_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 3);

    testContext.mock.timers.tick(INITIAL_REFRESH_BACKOFF_MS);
    await flushAsyncWork();
    assert.equal(fetchMock.mock.callCount(), 4);
});

test("ignores malformed tokens without throwing or scheduling refresh", async (testContext) => {
    const fetchMock = mockRefreshEndpoint(testContext);
    const client = createClient();

    assert.doesNotThrow(() => {
        client.setToken("not-a-jwt", "refresh-token");
    });
    testContext.mock.timers.tick(DAY_MS * 7);
    setVisibility("visible");
    await flushAsyncWork();

    assert.equal(fetchMock.mock.callCount(), 0);
});
