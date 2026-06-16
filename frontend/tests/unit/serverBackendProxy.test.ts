import assert from "node:assert/strict";
import test from "node:test";
import {
    buildBackendProxyOptions,
    createBackendProxy,
    createProxyErrorHandler,
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
        writeHead(statusCode: number, headers: unknown) {
            this.writeHeadCalls.push({ statusCode, headers });
        },
        end(body: string) {
            this.body = body;
        },
    };
}

test("buildBackendProxyOptions registers the error handler via the v3 on.error API", () => {
    const logger = createFakeLogger();
    const options = buildBackendProxyOptions({
        name: "api-proxy",
        target: "http://127.0.0.1:3006",
        logger,
        errorMessage: "API backend unavailable",
        errorCode: "API_PROXY_UNAVAILABLE",
    });

    // http-proxy-middleware v3 only honors options.on.error; the v2
    // onError/logLevel options are silently ignored (dead code).
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
