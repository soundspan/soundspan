import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
    buildBackendProxyOptions,
    createBackendProxy,
    createFirstByteTimeoutProxyReqHandler,
    createProxyErrorHandler,
    resolveProxyTimeoutMs,
} from "../../server-proxy";

interface FakeLogger {
    errors: string[][];
    error(...args: string[]): void;
}

function createFakeLogger(): FakeLogger {
    return {
        errors: [],
        error(...args: string[]) {
            this.errors.push(args);
        },
    };
}

function createFakeResponse(headersSent = false) {
    return {
        headersSent,
        writeHeadCalls: [] as Array<{ statusCode: number; headers: unknown }>,
        body: null as string | null,
        closeHandlers: [] as Array<() => void>,
        writeHead(statusCode: number, headers: unknown) {
            this.headersSent = true;
            this.writeHeadCalls.push({ statusCode, headers });
        },
        end(body: string) {
            this.body = body;
        },
        on(event: string, handler: () => void) {
            if (event === "close") {
                this.closeHandlers.push(handler);
            }
        },
    };
}

function createFakeProxyReq() {
    const proxyReq = new EventEmitter() as EventEmitter & {
        destroyed: boolean;
        destroy: () => void;
    };
    proxyReq.destroyed = false;
    proxyReq.destroy = () => {
        proxyReq.destroyed = true;
    };
    return proxyReq;
}

test("buildBackendProxyOptions registers the error handler via the v3+ on.error API", () => {
    const logger = createFakeLogger();
    const options = buildBackendProxyOptions({
        name: "api-proxy",
        target: "http://127.0.0.1:3006",
        logger,
        errorMessage: "API backend unavailable",
        errorCode: "API_PROXY_UNAVAILABLE",
    });

    // http-proxy-middleware v3+ (incl. v4) only honors options.on.error;
    // the v2 onError/logLevel options are silently ignored (dead code).
    assert.equal(typeof options.on?.error, "function");
    assert.equal("onError" in options, false);
    assert.equal("logLevel" in options, false);
    assert.equal(options.target, "http://127.0.0.1:3006");
    assert.equal(options.ws, false);
    assert.equal(options.changeOrigin, true);
    assert.equal(options.xfwd, true);
    assert.equal(options.timeout, 120000);
    assert.equal(options.proxyTimeout, 120000);
});

test("buildBackendProxyOptions enables websocket proxying when requested", () => {
    const options = buildBackendProxyOptions({
        name: "listen-together-proxy",
        target: "http://127.0.0.1:3006",
        ws: true,
        logger: createFakeLogger(),
        errorMessage: "Listen Together backend unavailable",
        errorCode: "LISTEN_TOGETHER_PROXY_UNAVAILABLE",
    });

    assert.equal(options.ws, true);
});

test("proxy error handler responds with the structured 503 JSON contract", () => {
    const logger = createFakeLogger();
    const handler = createProxyErrorHandler({
        name: "api-proxy",
        logger,
        errorMessage: "API backend unavailable",
        errorCode: "API_PROXY_UNAVAILABLE",
    });
    const res = createFakeResponse();

    handler(new Error("connect ECONNREFUSED"), { method: "GET", url: "/api/library" }, res);

    assert.equal(res.writeHeadCalls.length, 1);
    assert.equal(res.writeHeadCalls[0]?.statusCode, 503);
    assert.deepEqual(res.writeHeadCalls[0]?.headers, {
        "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(res.body ?? "null"), {
        error: "API backend unavailable",
        code: "API_PROXY_UNAVAILABLE",
    });
    assert.equal(logger.errors.length, 1);
    assert.match(logger.errors[0]?.[0] ?? "", /\[api-proxy\] GET \/api\/library failed:/);
});

test("proxy error handler does not write once headers were already sent", () => {
    const handler = createProxyErrorHandler({
        name: "api-proxy",
        logger: createFakeLogger(),
        errorMessage: "API backend unavailable",
        errorCode: "API_PROXY_UNAVAILABLE",
    });
    const res = createFakeResponse(true);

    handler(new Error("socket hang up"), { method: "GET", url: "/api/stream" }, res);

    assert.equal(res.writeHeadCalls.length, 0);
    assert.equal(res.body, null);
});

test("proxy error handler destroys socket-like responses from websocket upgrades", () => {
    const handler = createProxyErrorHandler({
        name: "listen-together-proxy",
        logger: createFakeLogger(),
        errorMessage: "Listen Together backend unavailable",
        errorCode: "LISTEN_TOGETHER_PROXY_UNAVAILABLE",
    });
    let destroyCalls = 0;
    const socketLike = {
        write() {
            // socket-like: write exists but writeHead does not
        },
        destroy() {
            destroyCalls += 1;
        },
    };

    handler(new Error("connect ECONNREFUSED"), { method: "GET", url: "/socket.io" }, socketLike);

    assert.equal(destroyCalls, 1);
});

test("createBackendProxy returns a middleware exposing websocket upgrade", () => {
    const proxy = createBackendProxy({
        name: "listen-together-proxy",
        target: "http://127.0.0.1:3006",
        ws: true,
        logger: createFakeLogger(),
        errorMessage: "Listen Together backend unavailable",
        errorCode: "LISTEN_TOGETHER_PROXY_UNAVAILABLE",
    });

    assert.equal(typeof proxy, "function");
    assert.equal(typeof proxy.upgrade, "function");
});

test("resolveProxyTimeoutMs applies the 20s default and 90s import-preview default", () => {
    assert.equal(resolveProxyTimeoutMs("/api/library", {}), 20_000);
    assert.equal(resolveProxyTimeoutMs("/api/import/preview", {}), 90_000);
    assert.equal(resolveProxyTimeoutMs("/api/import/preview/", {}), 90_000);
    assert.equal(resolveProxyTimeoutMs("/api/import/preview/step", {}), 90_000);
    assert.equal(resolveProxyTimeoutMs("/API/Import/Preview", {}), 90_000);
    // Mount-stripped form (e.g. if the proxy is ever Express-mounted under
    // /api, req.url loses the prefix) keeps the import-preview budget.
    assert.equal(resolveProxyTimeoutMs("/import/preview", {}), 90_000);
    assert.equal(resolveProxyTimeoutMs("/import/preview/step", {}), 90_000);
    // Non-preview paths that merely share the prefix text are not special.
    assert.equal(resolveProxyTimeoutMs("/api/import/previews", {}), 20_000);
    assert.equal(resolveProxyTimeoutMs("/import/previews", {}), 20_000);
});

test("resolveProxyTimeoutMs honors PROXY_REQUEST_TIMEOUT_MS and PROXY_IMPORT_PREVIEW_TIMEOUT_MS", () => {
    assert.equal(
        resolveProxyTimeoutMs("/api/library", {
            PROXY_REQUEST_TIMEOUT_MS: "5000",
        }),
        5_000
    );
    assert.equal(
        resolveProxyTimeoutMs("/api/import/preview", {
            PROXY_IMPORT_PREVIEW_TIMEOUT_MS: "120000",
        }),
        120_000
    );
    // A lower global timeout never shrinks the import-preview default…
    assert.equal(
        resolveProxyTimeoutMs("/api/import/preview", {
            PROXY_REQUEST_TIMEOUT_MS: "5000",
        }),
        90_000
    );
    // …but a higher global raises it when no explicit preview override exists.
    assert.equal(
        resolveProxyTimeoutMs("/api/import/preview", {
            PROXY_REQUEST_TIMEOUT_MS: "100000",
        }),
        100_000
    );
    // Invalid values fall back to the defaults.
    assert.equal(
        resolveProxyTimeoutMs("/api/library", {
            PROXY_REQUEST_TIMEOUT_MS: "not-a-number",
        }),
        20_000
    );
    assert.equal(
        resolveProxyTimeoutMs("/api/library", {
            PROXY_REQUEST_TIMEOUT_MS: "-1",
        }),
        20_000
    );
});

test("buildBackendProxyOptions registers the first-byte timeout handler when enabled", () => {
    const options = buildBackendProxyOptions({
        name: "api-proxy",
        target: "http://127.0.0.1:3006",
        logger: createFakeLogger(),
        errorMessage: "API backend unavailable",
        errorCode: "API_PROXY_UNAVAILABLE",
        firstByteTimeout: true,
        env: {},
    });

    assert.equal(typeof options.on?.proxyReq, "function");
    assert.equal(options.timeout, 120000);
    assert.equal(options.proxyTimeout, 120000);
});

test("buildBackendProxyOptions widens socket timeouts to cover configured first-byte budgets", () => {
    const options = buildBackendProxyOptions({
        name: "api-proxy",
        target: "http://127.0.0.1:3006",
        logger: createFakeLogger(),
        errorMessage: "API backend unavailable",
        errorCode: "API_PROXY_UNAVAILABLE",
        firstByteTimeout: true,
        env: { PROXY_REQUEST_TIMEOUT_MS: "300000" },
    });

    assert.equal(options.timeout, 300000);
    assert.equal(options.proxyTimeout, 300000);
});

test("first-byte timeout answers 504 UPSTREAM_TIMEOUT and aborts the upstream request", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const logger = createFakeLogger();
    const handler = createFirstByteTimeoutProxyReqHandler({
        name: "api-proxy",
        logger,
        env: {},
    });
    const proxyReq = createFakeProxyReq();
    const res = createFakeResponse();

    handler(proxyReq, { method: "GET", url: "/api/library" }, res);

    t.mock.timers.tick(19_999);
    assert.equal(res.writeHeadCalls.length, 0);
    assert.equal(proxyReq.destroyed, false);

    t.mock.timers.tick(1);
    assert.equal(res.writeHeadCalls.length, 1);
    assert.equal(res.writeHeadCalls[0]?.statusCode, 504);
    assert.deepEqual(res.writeHeadCalls[0]?.headers, {
        "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(res.body ?? "null"), {
        error: "Upstream request timed out",
        code: "UPSTREAM_TIMEOUT",
        description:
            "The frontend could not get a response from the backend in time.",
    });
    assert.equal(proxyReq.destroyed, true);
    assert.equal(logger.errors.length, 1);
    assert.match(
        logger.errors[0]?.[0] ?? "",
        /\[api-proxy\] GET \/api\/library timed out after 20000ms/
    );
});

test("first-byte timeout uses the import-preview budget for import preview paths", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const handler = createFirstByteTimeoutProxyReqHandler({
        name: "api-proxy",
        logger: createFakeLogger(),
        env: {},
    });
    const proxyReq = createFakeProxyReq();
    const res = createFakeResponse();

    handler(proxyReq, { method: "POST", url: "/api/import/preview?src=x" }, res);

    t.mock.timers.tick(20_000);
    assert.equal(res.writeHeadCalls.length, 0);
    assert.equal(proxyReq.destroyed, false);

    t.mock.timers.tick(70_000);
    assert.equal(res.writeHeadCalls.length, 1);
    assert.equal(res.writeHeadCalls[0]?.statusCode, 504);
    assert.equal(proxyReq.destroyed, true);
});

test("first-byte timeout is cancelled once the upstream response starts streaming", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const handler = createFirstByteTimeoutProxyReqHandler({
        name: "api-proxy",
        logger: createFakeLogger(),
        env: {},
    });
    const proxyReq = createFakeProxyReq();
    const res = createFakeResponse();

    handler(proxyReq, { method: "GET", url: "/api/stream/track-1" }, res);
    proxyReq.emit("response");

    t.mock.timers.tick(600_000);
    assert.equal(res.writeHeadCalls.length, 0);
    assert.equal(res.body, null);
    assert.equal(proxyReq.destroyed, false);
});

test("first-byte timeout is cancelled when the client response closes first", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const handler = createFirstByteTimeoutProxyReqHandler({
        name: "api-proxy",
        logger: createFakeLogger(),
        env: {},
    });
    const proxyReq = createFakeProxyReq();
    const res = createFakeResponse();

    handler(proxyReq, { method: "GET", url: "/api/library" }, res);
    for (const close of res.closeHandlers) close();

    t.mock.timers.tick(600_000);
    assert.equal(res.writeHeadCalls.length, 0);
    assert.equal(proxyReq.destroyed, false);
});
