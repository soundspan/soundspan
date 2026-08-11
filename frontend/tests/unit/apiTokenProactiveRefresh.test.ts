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
