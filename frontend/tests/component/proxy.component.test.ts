import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

type ProxyModule = {
    proxy: typeof import("../../proxy").proxy;
    config: { matcher: string[] };
};

async function loadProxyModule(): Promise<ProxyModule> {
    const mod = await import("../../proxy");
    return { proxy: mod.proxy, config: mod.config };
}

function request(pathname: string) {
    const url = `https://soundspan.test${pathname}`;
    return new NextRequest(url);
}

test("proxy keeps /api/* routes as passthrough responses", async () => {
    const { proxy } = await loadProxyModule();
    const response = proxy(request("/api/docs/"));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
});

test("proxy strips trailing slash for non-api routes with 308 redirect", async () => {
    const { proxy } = await loadProxyModule();
    const response = proxy(request("/explore/tidal-mix/abc/"));

    assert.equal(response.status, 308);
    assert.equal(
        response.headers.get("location"),
        "https://soundspan.test/explore/tidal-mix/abc",
    );
});

test("proxy preserves query params while stripping trailing slash", async () => {
    const { proxy } = await loadProxyModule();
    const response = proxy(request("/search/?q=tidal&tab=library"));

    assert.equal(response.status, 308);
    assert.equal(
        response.headers.get("location"),
        "https://soundspan.test/search?q=tidal&tab=library",
    );
});

test("proxy leaves root path unchanged", async () => {
    const { proxy } = await loadProxyModule();
    const response = proxy(request("/"));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
});

test("proxy keeps /api boundary paths and redirects similarly named non-api paths", async () => {
    const { proxy } = await loadProxyModule();

    const apiBoundary = proxy(request("/api"));
    assert.equal(apiBoundary.status, 200);
    assert.equal(apiBoundary.headers.get("location"), null);

    const apiLikePath = proxy(request("/apiish/"));
    assert.equal(apiLikePath.status, 308);
    assert.equal(
        apiLikePath.headers.get("location"),
        "https://soundspan.test/apiish",
    );
});

test("proxy exports matcher config for non-static routes", async () => {
    const { config } = await loadProxyModule();

    assert.deepEqual(config.matcher, [
        "/((?!_next/static|_next/image|favicon.ico|assets/).*)",
    ]);
});
