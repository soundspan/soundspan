/* eslint-disable @typescript-eslint/no-require-imports */
const { createServer } = require("http");
const next = require("next");
const { createProxyMiddleware } = require("http-proxy-middleware");

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "3030", 10);
const backendUrl = (process.env.BACKEND_URL || "http://127.0.0.1:3006").replace(/\/+$/, "");

const LISTEN_TOGETHER_SOCKET_PATH = "/socket.io/listen-together";
const SUBSONIC_REST_PATH = "/rest";
const HEALTH_LIVE_PATH = "/health/live";
const HEALTH_READY_PATH = "/health/ready";
const HEALTH_PATH = "/health";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
let isStartupComplete = false;
let isDraining = false;

function getPathname(reqUrl) {
    try {
        return new URL(reqUrl || "/", "http://localhost").pathname;
    } catch {
        return "";
    }
}

function isListenTogetherSocketPath(pathname) {
    return (
        pathname === LISTEN_TOGETHER_SOCKET_PATH ||
        pathname === `${LISTEN_TOGETHER_SOCKET_PATH}/` ||
        pathname.startsWith(`${LISTEN_TOGETHER_SOCKET_PATH}/`)
    );
}

function isSubsonicRestPath(pathname) {
    return (
        pathname === SUBSONIC_REST_PATH ||
        pathname === `${SUBSONIC_REST_PATH}/` ||
        pathname.startsWith(`${SUBSONIC_REST_PATH}/`)
    );
}

const listenTogetherSocketProxy = createProxyMiddleware({
    target: backendUrl,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    logLevel: "warn",
    timeout: 120000,
    proxyTimeout: 120000,
    onError: (err, req, res) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[listen-together-proxy] ${req.method} ${req.url} failed:`, errorMessage);
        if (!res.headersSent) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    error: "Listen Together backend unavailable",
                    code: "LISTEN_TOGETHER_PROXY_UNAVAILABLE",
                })
            );
        }
    },
});

const subsonicRestProxy = createProxyMiddleware({
    target: backendUrl,
    changeOrigin: true,
    xfwd: true,
    logLevel: "warn",
    timeout: 120000,
    proxyTimeout: 120000,
    onError: (err, req, res) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[subsonic-rest-proxy] ${req.method} ${req.url} failed:`, errorMessage);
        if (!res.headersSent) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    error: "Subsonic backend unavailable",
                    code: "SUBSONIC_PROXY_UNAVAILABLE",
                })
            );
        }
    },
});

app.prepare().then(() => {
    const server = createServer((req, res) => {
        const pathname = getPathname(req.url);

        if (pathname === HEALTH_LIVE_PATH) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    status: "ok",
                    startupComplete: isStartupComplete,
                    draining: isDraining,
                })
            );
            return;
        }

        if (pathname === HEALTH_READY_PATH || pathname === HEALTH_PATH) {
            if (!isStartupComplete || isDraining) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        status: "unready",
                        startupComplete: isStartupComplete,
                        draining: isDraining,
                    })
                );
                return;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    status: "ok",
                    startupComplete: isStartupComplete,
                    draining: isDraining,
                })
            );
            return;
        }

        if (isListenTogetherSocketPath(pathname)) {
            listenTogetherSocketProxy(req, res);
            return;
        }

        if (isSubsonicRestPath(pathname)) {
            subsonicRestProxy(req, res);
            return;
        }

        handle(req, res);
    });

    server.on("upgrade", (req, socket, head) => {
        const pathname = getPathname(req.url);
        if (isListenTogetherSocketPath(pathname)) {
            listenTogetherSocketProxy.upgrade(req, socket, head);
        }
    });

    server.listen(port, hostname, () => {
        isStartupComplete = true;
        console.log(`> Frontend ready on http://${hostname}:${port}`);
        console.log(`> Listen Together socket proxy enabled: ${LISTEN_TOGETHER_SOCKET_PATH} -> ${backendUrl}`);
        console.log(`> Subsonic REST proxy enabled: ${SUBSONIC_REST_PATH} -> ${backendUrl}`);
    });

    const gracefulShutdown = (signal) => {
        isDraining = true;
        console.log(`> ${signal} received, draining frontend server...`);

        server.close((err) => {
            if (err) {
                console.error("> Frontend shutdown error:", err);
                process.exit(1);
            }
            process.exit(0);
        });

        setTimeout(() => {
            console.error("> Frontend shutdown timeout exceeded; forcing exit");
            process.exit(1);
        }, 10000).unref();
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
});
