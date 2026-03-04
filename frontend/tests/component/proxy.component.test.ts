import assert from "node:assert/strict";
import { test } from "node:test";

type ProxyModule = {
    proxy: (request: { url: string; nextUrl: URL }) => Response;
    config: { matcher: string[] };
};

async function loadProxyModule(): Promise<ProxyModule> {
    const mod = await import("../../proxy");
    const proxy = (mod as { proxy?: ProxyModule["proxy"]; default?: { proxy?: ProxyModule["proxy"] } }).proxy
        ?? (mod as { default?: { proxy?: ProxyModule["proxy"] } }).default?.proxy;
    const config = (mod as { config?: ProxyModule["config"]; default?: { config?: ProxyModule["config"] } }).config
        ?? (mod as { default?: { config?: ProxyModule["config"] } }).default?.config;

    assert.ok(proxy, "proxy export is available");
    assert.ok(config, "config export is available");

    return { proxy, config };
}

function request(pathname: string) {
    const url = `https://soundspan.test${pathname}`;
    return {
        url,
        nextUrl: new URL(url),
    };
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
    assert.equal(apiLikePath.headers.get("location"), "https://soundspan.test/apiish");
});

test("proxy exports matcher config for non-static routes", async () => {
    const { config } = await loadProxyModule();

    assert.deepEqual(config.matcher, ["/((?!_next/static|_next/image|favicon.ico|assets/).*)"]);
});
