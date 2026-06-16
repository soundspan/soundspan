/* eslint-disable @typescript-eslint/no-require-imports */
const { createProxyMiddleware } = require("http-proxy-middleware");

/**
 * Build an http-proxy-middleware v3 error handler that preserves the
 * structured 503 JSON error contract ({ error, code }) used by all
 * backend proxies in server.js.
 *
 * v3 removed the v2 `onError` option, so handlers must be registered
 * via `on.error`; when a custom handler is registered, hpm also skips
 * its default plain-text error response. WebSocket upgrade failures
 * hand the handler a raw socket instead of a ServerResponse, so
 * socket-like targets are destroyed rather than written to.
 *
 * @param {{ name: string, logger: { error: Function }, errorMessage: string, errorCode: string }} config
 * @returns {(err: unknown, req: { method?: string, url?: string }, res: unknown) => void}
 */
function createProxyErrorHandler({ name, logger, errorMessage, errorCode }) {
    return (err, req, res) => {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error(`[${name}] ${req?.method} ${req?.url} failed:`, detail);

        if (res && typeof res.writeHead === "function") {
            if (!res.headersSent) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        error: errorMessage,
                        code: errorCode,
                    })
                );
            }
            return;
        }

        if (res && typeof res.destroy === "function") {
            res.destroy();
        }
    };
}

/**
 * Build the shared http-proxy-middleware options for a backend proxy
 * (target, forwarding headers, timeouts, structured error handler).
 *
 * @param {{ name: string, target: string, ws?: boolean, logger: { error: Function }, errorMessage: string, errorCode: string }} config
 * @returns {import("http-proxy-middleware").Options}
 */
function buildBackendProxyOptions({ name, target, ws = false, logger, errorMessage, errorCode }) {
    return {
        target,
        changeOrigin: true,
        ws: Boolean(ws),
        xfwd: true,
        timeout: 120000,
        proxyTimeout: 120000,
        on: {
            error: createProxyErrorHandler({ name, logger, errorMessage, errorCode }),
        },
    };
}

/**
 * Create a backend proxy middleware (with `.upgrade` for websocket
 * proxies) that streams requests to the backend and answers with the
 * structured 503 JSON contract when the backend is unreachable.
 *
 * @param {{ name: string, target: string, ws?: boolean, logger: { error: Function }, errorMessage: string, errorCode: string }} config
 * @returns {import("http-proxy-middleware").RequestHandler}
 */
function createBackendProxy(config) {
    return createProxyMiddleware(buildBackendProxyOptions(config));
}

module.exports = {
    createProxyErrorHandler,
    buildBackendProxyOptions,
    createBackendProxy,
};
