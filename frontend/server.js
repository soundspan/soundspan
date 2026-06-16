/* eslint-disable @typescript-eslint/no-require-imports */
const { createServer } = require("http");
const next = require("next");
const { createBackendProxy } = require("./server-proxy");

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "3030", 10);
const backendUrl = (process.env.BACKEND_URL || "http://127.0.0.1:3006").replace(/\/+$/, "");

const LISTEN_TOGETHER_SOCKET_PATH = "/socket.io/listen-together";
const SUBSONIC_REST_PATH = "/rest";
const API_PATH = "/api";
const HEALTH_LIVE_PATH = "/health/live";
const HEALTH_READY_PATH = "/health/ready";
const HEALTH_PATH = "/health";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
let isStartupComplete = false;
let isDraining = false;

function serializeLogArg(arg) {
    if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === "string") {
        return arg;
    }
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

function emitServerLog(level, message, ...args) {
    const payload = args.length > 0
        ? `${message} ${args.map(serializeLogArg).join(" ")}`
        : message;
    const line = `[${level}] [frontend.server] ${payload}\n`;
    if (level === "ERROR" || level === "WARN") {
        process.stderr.write(line);
        return;
    }
    process.stdout.write(line);
}

const serverLogger = {
    info(message, ...args) {
        emitServerLog("INFO", message, ...args);
    },
    warn(message, ...args) {
        emitServerLog("WARN", message, ...args);
    },
    error(message, ...args) {
        emitServerLog("ERROR", message, ...args);
    },
};

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

// All /api/* paths are backend-owned; Next-owned handlers live at
// /runtime-config and /health (the latter is handled above the proxy).
function isApiPath(pathname) {
    return (
        pathname === API_PATH ||
        pathname === `${API_PATH}/` ||
        pathname.startsWith(`${API_PATH}/`)
    );
}

const listenTogetherSocketProxy = createBackendProxy({
    name: "listen-together-proxy",
    target: backendUrl,
    ws: true,
    logger: serverLogger,
    errorMessage: "Listen Together backend unavailable",
    errorCode: "LISTEN_TOGETHER_PROXY_UNAVAILABLE",
});

const subsonicRestProxy = createBackendProxy({
    name: "subsonic-rest-proxy",
    target: backendUrl,
    logger: serverLogger,
    errorMessage: "Subsonic backend unavailable",
    errorCode: "SUBSONIC_PROXY_UNAVAILABLE",
});

// Streams /api traffic straight to the backend (no body buffering or
// gzip stripping, unlike the Next route-handler fallback in
// app/api/[...path]/route.ts).
const apiProxy = createBackendProxy({
    name: "api-proxy",
    target: backendUrl,
    logger: serverLogger,
    errorMessage: "API backend unavailable",
    errorCode: "API_PROXY_UNAVAILABLE",
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

        if (isApiPath(pathname)) {
            apiProxy(req, res);
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
        serverLogger.info(`> Frontend ready on http://${hostname}:${port}`);
        serverLogger.info(
            `> Listen Together socket proxy enabled: ${LISTEN_TOGETHER_SOCKET_PATH} -> ${backendUrl}`
        );
        serverLogger.info(
            `> Subsonic REST proxy enabled: ${SUBSONIC_REST_PATH} -> ${backendUrl}`
        );
        serverLogger.info(
            `> API proxy enabled: ${API_PATH} -> ${backendUrl}`
        );
    });

    const gracefulShutdown = (signal) => {
        isDraining = true;
        serverLogger.info(`> ${signal} received, draining frontend server...`);

        server.close((err) => {
            if (err) {
                serverLogger.error("> Frontend shutdown error:", err);
                process.exit(1);
            }
            process.exit(0);
        });

        setTimeout(() => {
            serverLogger.error("> Frontend shutdown timeout exceeded; forcing exit");
            process.exit(1);
        }, 10000).unref();
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
});
