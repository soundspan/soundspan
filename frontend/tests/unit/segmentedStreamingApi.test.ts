import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";

import { api } from "../../lib/api";

const originalFetch = globalThis.fetch;

after(() => {
    api.clearToken();
    if (originalFetch) {
        globalThis.fetch = originalFetch;
    } else {
        Reflect.deleteProperty(globalThis, "fetch");
    }
});

function mockFetch(testContext: TestContext, response: Response) {
    return testContext.mock.method(globalThis, "fetch", async () => response);
}

test("fetchSegmentedStreamingManifest preserves the raw manifest request", async (testContext) => {
    const response = new Response("<MPD />", { status: 200 });
    const fetchMock = mockFetch(testContext, response);
    const controller = new AbortController();
    api.setToken("access-token");

    const result = await api.fetchSegmentedStreamingManifest(
        "https://stream.test/session-1/manifest.mpd?st=session-token",
        "session-token",
        controller.signal,
    );

    assert.equal(result, response);
    assert.deepEqual(fetchMock.mock.calls[0]?.arguments, [
        "https://stream.test/session-1/manifest.mpd?st=session-token",
        {
            method: "GET",
            credentials: "include",
            headers: {
                "x-streaming-session-token": "session-token",
                Authorization: "Bearer access-token",
            },
            signal: controller.signal,
        },
    ]);
});

test("fetchSegmentedStreamingSegment preserves the relative URL and encoding", async (testContext) => {
    const response = new Response(null, { status: 204 });
    const fetchMock = mockFetch(testContext, response);
    const controller = new AbortController();
    api.setToken("access-token");

    const result = await api.fetchSegmentedStreamingSegment(
        "session-1",
        "session token/+",
        "chunk name/+1.m4s",
        controller.signal,
    );

    assert.equal(result, response);
    assert.deepEqual(fetchMock.mock.calls[0]?.arguments, [
        "/api/streaming/v1/sessions/session-1/segments/chunk%20name%2F%2B1.m4s?st=session%20token%2F%2B",
        {
            method: "GET",
            credentials: "include",
            headers: {
                "x-streaming-session-token": "session token/+",
                Authorization: "Bearer access-token",
            },
            signal: controller.signal,
        },
    ]);
});

test("segmented asset methods return unmarked 401 responses without expiring auth", async (testContext) => {
    const response = Response.json(
        { error: "Invalid streaming session token" },
        { status: 401 },
    );
    mockFetch(testContext, response);
    api.setToken("access-current");

    const result = await api.fetchSegmentedStreamingManifest(
        "https://stream.test/session-2/manifest.mpd",
        "expired-session-token",
        new AbortController().signal,
    );

    assert.equal(result, response);
    assert.equal(result.status, 401);
    assert.equal(api.getToken(), "access-current");
});
