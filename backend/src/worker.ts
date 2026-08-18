import { createServer, type Server as HttpServer } from "http";
import { config } from "./config";
import { redisClient } from "./utils/redis";
import { prisma } from "./utils/db";
import { logger } from "./utils/logger";
import { createDependencyReadinessTracker } from "./utils/dependencyReadiness";
import { isSecretsDbOnlyEnabled } from "./config/secretsPolicy";
import { metricsRegistry } from "./metrics";
import { isMetricsRequestAuthorized } from "./metrics/endpoint";
import { registerQueueMetrics } from "./metrics/queueMetrics";
import { backfillFederationOutboundTokens } from "./services/federationCredentials";
import { warnIfLegacyDiscoveryMode } from "./utils/legacyDiscoveryDeprecation";

const log = logger.child("WorkerStartup");

type WorkerProcessRole = "worker" | "all";

function resolveWorkerProcessRole(): WorkerProcessRole {
    const raw = (process.env.BACKEND_PROCESS_ROLE || "worker")
        .trim()
        .toLowerCase();

    if (raw === "worker" || raw === "all") {
        return raw;
    }

    if (raw === "api") {
        log.error(
            'BACKEND_PROCESS_ROLE="api" is invalid for worker entrypoint.',
        );
        process.exit(1);
    }

    log.warn(
        `Invalid BACKEND_PROCESS_ROLE="${process.env.BACKEND_PROCESS_ROLE}", defaulting to "worker"`,
    );
    return "worker";
}

const workerProcessRole = resolveWorkerProcessRole();
warnIfLegacyDiscoveryMode("Worker");
let isShuttingDown = false;
let workersInitialized = false;
let isStartupComplete = false;
let isDraining = false;
let healthServer: HttpServer | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;
const dependencyReadiness = createDependencyReadinessTracker("worker");

const DEFAULT_WORKER_HEALTH_PORT = 3010;
const parsedWorkerHealthPort = Number.parseInt(
    process.env.WORKER_HEALTH_PORT || `${DEFAULT_WORKER_HEALTH_PORT}`,
    10,
);
const workerHealthPort =
    Number.isFinite(parsedWorkerHealthPort) && parsedWorkerHealthPort > 0
        ? parsedWorkerHealthPort
        : DEFAULT_WORKER_HEALTH_PORT;

if (workerHealthPort !== parsedWorkerHealthPort) {
    log.warn(
        `Invalid WORKER_HEALTH_PORT="${process.env.WORKER_HEALTH_PORT}", defaulting to ${DEFAULT_WORKER_HEALTH_PORT}`,
    );
}

function buildHealthPayload() {
    return {
        status: "ok",
        role: workerProcessRole,
        startupComplete: isStartupComplete,
        draining: isDraining,
        dependencies: dependencyReadiness.getSnapshot(),
    };
}

function sendHealth(
    res: {
        writeHead: (
            statusCode: number,
            headers: Record<string, string>,
        ) => void;
        end: (data?: string) => void;
    },
    statusCode: number,
) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildHealthPayload()));
}

async function sendMetrics(
    authorization: string | undefined,
    res: Parameters<typeof sendHealth>[0],
): Promise<void> {
    if (!isMetricsRequestAuthorized(authorization, config.metrics)) {
        res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="metrics"',
        });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
    }
    try {
        const body = await metricsRegistry.metrics();
        res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
        res.end(body);
    } catch (error) {
        log.error("metrics collection failed", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Metrics collection failed" }));
    }
}

function startHealthServer() {
    healthServer = createServer((req, res) => {
        const handleReady = async () => {
            try {
                await dependencyReadiness.probe();
                if (
                    !isStartupComplete ||
                    isDraining ||
                    !dependencyReadiness.isHealthy()
                ) {
                    sendHealth(res, 503);
                    return;
                }
                sendHealth(res, 200);
            } catch (error) {
                log.error("readiness probe failed:", error);
                sendHealth(res, 503);
            }
        };

        const path = (req.url || "").split("?")[0];
        if (path === "/health/live") {
            sendHealth(res, 200);
            return;
        }

        if (path === "/health/ready" || path === "/health") {
            void handleReady();
            return;
        }

        if (path === "/metrics") {
            void sendMetrics(req.headers.authorization, res);
            return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    });

    healthServer.on("error", (error) => {
        log.error("Health server error:", error);
    });

    healthServer.listen(workerHealthPort, "0.0.0.0", () => {
        log.debug(`Health server listening on port ${workerHealthPort}`);
    });
}

async function stopHealthServer() {
    const server = healthServer;
    if (!server) {
        return;
    }

    healthServer = null;
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

async function checkPostgresConnection() {
    try {
        await prisma.$queryRaw`SELECT 1`;
        log.debug("✓ PostgreSQL connection verified");
    } catch (error) {
        log.error("✗ PostgreSQL connection failed:", {
            error: error instanceof Error ? error.message : String(error),
            databaseUrl: config.databaseUrl?.replace(/:[^:@]+@/, ":***@"),
        });
        log.error("Unable to connect to PostgreSQL. Please ensure:");
        log.error(
            "  1. PostgreSQL is running on the correct port (default: 5433)",
        );
        log.error("  2. DATABASE_URL in .env is correct");
        log.error("  3. Database credentials are valid");
        process.exit(1);
    }
}

async function checkRedisConnection() {
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 1_000;
    const MAX_DELAY_MS = 15_000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (!redisClient.isReady) {
                throw new Error(
                    "Redis client is not ready - connection failed or still connecting",
                );
            }

            await redisClient.ping();
            log.debug("✓ Redis connection verified");
            return;
        } catch (error) {
            const errorMsg =
                error instanceof Error ? error.message : String(error);

            if (attempt < MAX_RETRIES) {
                const delay = Math.min(
                    BASE_DELAY_MS * Math.pow(2, attempt - 1),
                    MAX_DELAY_MS,
                );
                log.warn(
                    `Redis connection attempt ${attempt}/${MAX_RETRIES} failed: ${errorMsg} – retrying in ${delay}ms`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            } else {
                log.error("✗ Redis connection failed after all retries:", {
                    error: errorMsg,
                    redisUrl: config.redisUrl?.replace(/:[^:@]+@/, ":***@"),
                });
                log.error("Unable to connect to Redis. Please ensure:");
                log.error(
                    "  1. Redis is running on the correct port (default: 6379)",
                );
                log.error("  2. REDIS_URL in .env is correct");
                process.exit(1);
            }
        }
    }
}

async function startWorkerRuntime() {
    await checkPostgresConnection();
    await backfillFederationOutboundTokens();
    await checkRedisConnection();
    if (isSecretsDbOnlyEnabled()) {
        // Lazy import keeps the entrypoint free of the settings/encryption
        // module chain unless the DB-only secrets flag is enabled.
        const { assertSecretsDbOnlyReady } =
            await import("./utils/systemSettings");
        await assertSecretsDbOnlyReady().catch((error) => {
            log.error(String(error?.message ?? error));
            process.exit(1);
        });
    }
    await dependencyReadiness.probe(true);

    log.info(
        `BACKEND_PROCESS_ROLE=${workerProcessRole} (api=false, worker=true)`,
    );

    const { initializeMusicConfig } = await import("./config");
    await initializeMusicConfig();

    await import("./workers");
    workersInitialized = true;
    const { queues } = await import("./workers/queues");
    registerQueueMetrics(metricsRegistry, queues);

    // Event-loop stall watchdog: attributes liveness-probe-visible stalls
    // to the Bull jobs running at the time (issue #43)
    const { startWorkerEventLoopMonitor } =
        await import("./services/workerEventLoopMonitor");
    const { config } = await import("./config");
    startWorkerEventLoopMonitor(config.workerEventLoop);

    log.debug(
        "Background enrichment enabled for owned content (genres, MBIDs, etc.)",
    );
    log.debug(
        "Startup maintenance jobs are queue-claimed (cache warmup, podcast cleanup, audiobook sync, download reconciliation, backfills)",
    );

    log.info("Worker runtime initialized");
    isStartupComplete = true;
}

async function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
        log.debug("Shutdown already in progress...");
        return;
    }

    isShuttingDown = true;
    isDraining = true;
    log.debug(`\nReceived ${signal}. Starting graceful worker shutdown...`);

    try {
        if (healthCheckInterval) {
            clearInterval(healthCheckInterval);
            healthCheckInterval = null;
        }

        if (workersInitialized) {
            const { shutdownWorkers } = await import("./workers");
            await shutdownWorkers();
        }

        // node-redis v5+ replaced quit() with close()
        log.debug("Closing Redis connection...");
        await redisClient.close();

        log.debug("Closing database connection...");
        await prisma.$disconnect();

        await stopHealthServer();
        log.debug("Graceful worker shutdown complete");
        process.exit(0);
    } catch (error) {
        log.error("Error during worker shutdown:", error);
        process.exit(1);
    }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
    log.error("Unhandled Promise Rejection:", {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
    });
});

process.on("uncaughtException", (error) => {
    log.error("Uncaught Exception - initiating graceful worker shutdown:", {
        message: error.message,
        stack: error.stack,
    });
    gracefulShutdown("uncaughtException").catch(() => {
        process.exit(1);
    });
});

const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
healthCheckInterval = setInterval(async () => {
    try {
        const dependencySnapshot = await dependencyReadiness.probe(true);
        if (!dependencySnapshot.overallHealthy) {
            log.error("Worker readiness dependency check failed:", {
                postgres: dependencySnapshot.postgres,
                redis: dependencySnapshot.redis,
            });

            if (!dependencySnapshot.postgres.ok) {
                try {
                    await prisma.$disconnect();
                    await prisma.$connect();
                    log.debug("Worker database connection recovered");
                    await dependencyReadiness.probe(true);
                } catch (reconnectError) {
                    log.error(
                        "Worker failed to recover database connection:",
                        reconnectError,
                    );
                }
            }
        }
    } catch (error) {
        log.error("Worker health check failed - connections may be stale:", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}, HEALTH_CHECK_INTERVAL);
healthCheckInterval.unref();

startHealthServer();

startWorkerRuntime().catch(async (error) => {
    isDraining = true;
    log.error("Fatal startup error:", error);
    await stopHealthServer();
    process.exit(1);
});
