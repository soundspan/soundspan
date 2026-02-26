import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeApiBaseUrlInput,
    resolveApiBaseUrl,
    resolveApiPathMode,
} from "../../lib/api-base-url.ts";

test("resolveApiBaseUrl auto mode uses proxy path on canonical frontend ports", () => {
    const result = resolveApiBaseUrl({
        isServer: false,
        browserLocation: {
            protocol: "http:",
            hostname: "127.0.0.1",
            port: "3030",
        },
    });
    assert.equal(result, "");
});

test("resolveApiBaseUrl auto mode uses proxy path on non-canonical frontend ports", () => {
    const result = resolveApiBaseUrl({
        isServer: false,
        browserLocation: {
            protocol: "http:",
            hostname: "127.0.0.1",
            port: "3031",
        },
    });
    assert.equal(result, "");
});

test("resolveApiBaseUrl auto mode prefers explicit NEXT_PUBLIC_API_URL", () => {
    const result = resolveApiBaseUrl({
        isServer: false,
        configuredApiUrl: "https://api.example.com/",
        browserLocation: {
            protocol: "https:",
            hostname: "soundspan.example.com",
            port: "443",
        },
    });
    assert.equal(result, "https://api.example.com");
});

test("resolveApiBaseUrl proxy mode forces relative /api path", () => {
    const result = resolveApiBaseUrl({
        isServer: false,
        apiPathMode: "proxy",
        configuredApiUrl: "https://api.example.com",
        browserLocation: {
            protocol: "https:",
            hostname: "soundspan.example.com",
            port: "443",
        },
    });
    assert.equal(result, "");
});

test("resolveApiBaseUrl direct mode uses explicit URL when provided", () => {
    const result = resolveApiBaseUrl({
        isServer: false,
        apiPathMode: "direct",
        configuredApiUrl: "https://api.example.com/",
        browserLocation: {
            protocol: "https:",
            hostname: "soundspan.example.com",
            port: "443",
        },
    });
    assert.equal(result, "https://api.example.com");
});

test("resolveApiBaseUrl direct mode derives backend URL from browser host when unset", () => {
    const result = resolveApiBaseUrl({
        isServer: false,
        apiPathMode: "direct",
        browserLocation: {
            protocol: "https:",
            hostname: "soundspan.example.com",
            port: "443",
        },
    });
    assert.equal(result, "https://soundspan.example.com:3006");
});

test("resolveApiBaseUrl invalid mode falls back to auto behavior", () => {
    const result = resolveApiBaseUrl({
        isServer: false,
        apiPathMode: "bogus",
        browserLocation: {
            protocol: "http:",
            hostname: "127.0.0.1",
            port: "3030",
        },
    });
    assert.equal(result, "");
});

test("resolveApiBaseUrl server mode uses BACKEND_URL and strips trailing slash", () => {
    const result = resolveApiBaseUrl({
        isServer: true,
        backendUrl: "http://127.0.0.1:3007/",
    });
    assert.equal(result, "http://127.0.0.1:3007");
});

test("resolveApiPathMode trims and lowercases mode values", () => {
    assert.equal(resolveApiPathMode(" PROXY "), "proxy");
    assert.equal(resolveApiPathMode(" DiReCt "), "direct");
});

test("resolveApiPathMode falls back to auto for empty or invalid values", () => {
    assert.equal(resolveApiPathMode(""), "auto");
    assert.equal(resolveApiPathMode("bogus"), "auto");
});

test("normalizeApiBaseUrlInput trims and removes all trailing slashes", () => {
    assert.equal(
        normalizeApiBaseUrlInput(" https://api.example.com/// "),
        "https://api.example.com"
    );
});

test("normalizeApiBaseUrlInput returns null for missing or whitespace input", () => {
    assert.equal(normalizeApiBaseUrlInput(undefined), null);
    assert.equal(normalizeApiBaseUrlInput("   "), null);
});
