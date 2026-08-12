import assert from "node:assert/strict";
import test, { after, beforeEach, type TestContext } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ApiClientCore } from "../../lib/api/core";

GlobalRegistrator.register();

class TestApiClient extends ApiClientCore {}

const originalFetch = globalThis.fetch;

beforeEach(() => {
    localStorage.clear();
});

after(() => {
    if (originalFetch) {
        globalThis.fetch = originalFetch;
    } else {
        Reflect.deleteProperty(globalThis, "fetch");
    }
    GlobalRegistrator.unregister();
});

function trackSessionExpiry(): { count: () => number; stop: () => void } {
    let eventCount = 0;
    const listener = () => {
        eventCount += 1;
    };
    window.addEventListener("auth:session-expired", listener);
    return {
        count: () => eventCount,
        stop: () =>
            window.removeEventListener("auth:session-expired", listener),
    };
}

function mockFetch(
    testContext: TestContext,
    responder: (url: string) => Response | Promise<Response>,
) {
    return testContext.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request) => responder(String(input)),
    );
}

test("refreshes for AUTH_REQUIRED and expires the session when refresh fails", async (testContext) => {
    const sessionExpiry = trackSessionExpiry();
    const client = new TestApiClient("http://soundspan.test");
    client.setToken("access-old", "refresh-old");
    const fetchMock = mockFetch(testContext, (url) => {
        if (url.endsWith("/api/auth/refresh")) {
            return Response.json(
                { error: "Invalid refresh token" },
                { status: 401 },
            );
        }
        return Response.json(
            { error: "Not authenticated", code: "AUTH_REQUIRED" },
            { status: 401 },
        );
    });

    try {
        await assert.rejects(client.post("/system-settings/test-fanart"), {
            message: "Not authenticated",
            status: 401,
            data: {
                error: "Not authenticated",
                code: "AUTH_REQUIRED",
            },
        });
        assert.equal(fetchMock.mock.callCount(), 2);
        assert.equal(client.getToken(), null);
        assert.equal(localStorage.getItem("refresh_token"), null);
        assert.equal(sessionExpiry.count(), 1);
    } finally {
        sessionExpiry.stop();
        client.clearToken();
    }
});

test("preserves the session and response body for an unmarked upstream 401", async (testContext) => {
    const sessionExpiry = trackSessionExpiry();
    const client = new TestApiClient("http://soundspan.test");
    client.setToken("access-current", "refresh-current");
    const fetchMock = mockFetch(testContext, () =>
        Response.json(
            { error: "Invalid Audiobookshelf API key" },
            { status: 401 },
        ),
    );

    try {
        await assert.rejects(
            client.post("/system-settings/test-audiobookshelf"),
            {
                message: "Invalid Audiobookshelf API key",
                status: 401,
                data: { error: "Invalid Audiobookshelf API key" },
            },
        );
        assert.equal(fetchMock.mock.callCount(), 1);
        assert.equal(client.getToken(), "access-current");
        assert.equal(localStorage.getItem("refresh_token"), "refresh-current");
        assert.equal(sessionExpiry.count(), 0);
    } finally {
        sessionExpiry.stop();
        client.clearToken();
    }
});

test("preserves the interactive-session message from a 403 response", async (testContext) => {
    const sessionExpiry = trackSessionExpiry();
    const client = new TestApiClient("http://soundspan.test");
    client.setToken("access-current", "refresh-current");
    const fetchMock = mockFetch(testContext, () =>
        Response.json(
            { error: "Interactive session authentication required" },
            { status: 403 },
        ),
    );

    try {
        await assert.rejects(client.post("/api-keys"), {
            message: "Interactive session authentication required",
            status: 403,
            data: { error: "Interactive session authentication required" },
        });
        assert.equal(fetchMock.mock.callCount(), 1);
        assert.equal(client.getToken(), "access-current");
        assert.equal(sessionExpiry.count(), 0);
    } finally {
        sessionExpiry.stop();
        client.clearToken();
    }
});

test("keeps direct auth refresh 401 handling unchanged without the marker", async (testContext) => {
    const sessionExpiry = trackSessionExpiry();
    const client = new TestApiClient("http://soundspan.test");
    client.setToken("access-old", "refresh-old");
    const fetchMock = mockFetch(testContext, () =>
        Response.json({ error: "Invalid refresh token" }, { status: 401 }),
    );

    try {
        await assert.rejects(client.post("/auth/refresh"), {
            message: "Not authenticated",
            status: 401,
            data: { error: "Invalid refresh token" },
        });
        assert.equal(fetchMock.mock.callCount(), 1);
        assert.equal(client.getToken(), null);
        assert.equal(localStorage.getItem("refresh_token"), null);
        assert.equal(sessionExpiry.count(), 1);
    } finally {
        sessionExpiry.stop();
        client.clearToken();
    }
});
