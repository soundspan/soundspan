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

function mockFetch(
    testContext: TestContext,
    responder: (url: string, init?: RequestInit) => Response,
) {
    return testContext.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) =>
            responder(String(input), init),
    );
}

test("resolves a 204 No Content response without parsing a body", async (testContext) => {
    const client = new TestApiClient("http://soundspan.test");
    client.setToken("access", "refresh");
    const fetchMock = mockFetch(
        testContext,
        () => new Response(null, { status: 204 }),
    );

    const result = await client.delete("/federation/admin/peers/peer-1");

    assert.equal(result, undefined);
    assert.equal(fetchMock.mock.callCount(), 1);
});

test("resolves a 200 response with an empty body as undefined", async (testContext) => {
    const client = new TestApiClient("http://soundspan.test");
    client.setToken("access", "refresh");
    mockFetch(testContext, () => new Response("", { status: 200 }));

    const result = await client.get("/library/empty");

    assert.equal(result, undefined);
});

test("still parses a JSON body on success", async (testContext) => {
    const client = new TestApiClient("http://soundspan.test");
    client.setToken("access", "refresh");
    mockFetch(testContext, () =>
        Response.json({ success: true }, { status: 200 }),
    );

    const result = await client.get<{ success: boolean }>("/library/ok");

    assert.deepEqual(result, { success: true });
});
