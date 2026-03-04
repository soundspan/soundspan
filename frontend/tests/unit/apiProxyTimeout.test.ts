import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveProxyTimeoutMs } from "../../lib/apiProxy";

describe("resolveProxyTimeoutMs", () => {
    test("uses default timeout for non-import requests", () => {
        const timeoutMs = resolveProxyTimeoutMs("api/library", {});
        assert.equal(timeoutMs, 20_000);
    });

    test("respects global proxy timeout override for non-import requests", () => {
        const timeoutMs = resolveProxyTimeoutMs("api/library", {
            PROXY_REQUEST_TIMEOUT_MS: "35000",
        });
        assert.equal(timeoutMs, 35_000);
    });

    test("uses longer default timeout for import preview route", () => {
        const timeoutMs = resolveProxyTimeoutMs("api/import/preview", {});
        assert.equal(timeoutMs, 90_000);
    });

    test("respects import preview specific timeout override", () => {
        const timeoutMs = resolveProxyTimeoutMs("/api/import/preview", {
            PROXY_REQUEST_TIMEOUT_MS: "20000",
            PROXY_IMPORT_PREVIEW_TIMEOUT_MS: "120000",
        });
        assert.equal(timeoutMs, 120_000);
    });

    test("uses import preview timeout when route has trailing slash", () => {
        const timeoutMs = resolveProxyTimeoutMs("/api/import/preview/", {});
        assert.equal(timeoutMs, 90_000);
    });

    test("falls back to defaults when env timeout values are invalid", () => {
        const timeoutMs = resolveProxyTimeoutMs("api/library", {
            PROXY_REQUEST_TIMEOUT_MS: "invalid",
        });
        assert.equal(timeoutMs, 20_000);
    });

    test("falls back to max(global, import default) when import override is invalid", () => {
        const timeoutMs = resolveProxyTimeoutMs("api/import/preview", {
            PROXY_REQUEST_TIMEOUT_MS: "120000",
            PROXY_IMPORT_PREVIEW_TIMEOUT_MS: "invalid",
        });
        assert.equal(timeoutMs, 120_000);
    });
});
