import { createServer, type Server as HttpServer } from "http";
import { config } from "./config";
import { redisClient } from "./utils/redis";
import { prisma } from "./utils/db";
import { logger } from "./utils/logger";
import { createDependencyReadinessTracker } from "./utils/dependencyReadiness";

type WorkerProcessRole = "worker" | "all";

function resolveWorkerProcessRole(): WorkerProcessRole {
    const raw = (process.env.BACKEND_PROCESS_ROLE || "worker").trim().toLowerCase();

    if (raw === "worker" || raw === "all") {
        return raw;
    }

    if (raw === "api") {
        logger.error(
            '[Worker Startup] BACKEND_PROCESS_ROLE="api" is invalid for worker entrypoint.'
        );
        process.exit(1);
    }

    logger.warn(
        `[Worker Startup] Invalid BACKEND_PROCESS_ROLE="${process.env.BACKEND_PROCESS_ROLE}", defaulting to "worker"`
    );
    return "worker";
}

const workerProcessRole = resolveWorkerProcessRole();
let isShuttingDown = false;
let workersInitialized = false;
let isStartupComplete = false;
let isDraining = false;
let healthServer: HttpServer | null = null;
const dependencyReadiness = createDependencyReadinessTracker("worker");

const DEFAULT_WORKER_HEALTH_PORT = 3010;
const parsedWorkerHealthPort = Number.parseInt(
    process.env.WORKER_HEALTH_PORT || `${DEFAULT_WORKER_HEALTH_PORT}`,
    10
);
const workerHealthPort =
    Number.isFinite(parsedWorkerHealthPort) && parsedWorkerHealthPort > 0
        ? parsedWorkerHealthPort
        : DEFAULT_WORKER_HEALTH_PORT;

if (workerHealthPort !== parsedWorkerHealthPort) {
    logger.warn(
        `[Worker Startup] Invalid WORKER_HEALTH_PORT="${process.env.WORKER_HEALTH_PORT}", defaulting to ${DEFAULT_WORKER_HEALTH_PORT}`
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
        writeHead: (statusCode: number, headers: Record<string, string>) => void;
        end: (data?: string) => void;
    },
    statusCode: number,
) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildHealthPayload()));
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
                logger.error("[Worker Startup] readiness probe failed:", error);
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

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    });

    healthServer.on("error", (error) => {
        logger.error("[Worker Startup] Health server error:", error);
    });

    healthServer.listen(workerHealthPort, "0.0.0.0", () => {
        logger.debug(
            `[Worker Startup] Health server listening on port ${workerHealthPort}`
        );
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
        logger.debug("✓ PostgreSQL connection verified");
    } catch (error) {
        logger.error("✗ PostgreSQL connection failed:", {
            error: error instanceof Error ? error.message : String(error),
            databaseUrl: config.databaseUrl?.replace(/:[^:@]+@/, ":***@"),
        });
        logger.error("Unable to connect to PostgreSQL. Please ensure:");
        logger.error("  1. PostgreSQL is running on the correct port (default: 5433)");
        logger.error("  2. DATABASE_URL in .env is correct");
        logger.error("  3. Database credentials are valid");
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
                    "Redis client is not ready - connection failed or still connecting"
                );
            }

            await redisClient.ping();
            logger.debug("✓ Redis connection verified");
            return;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            if (attempt < MAX_RETRIES) {
                const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
                logger.warn(
                    `Redis connection attempt ${attempt}/${MAX_RETRIES} failed: ${errorMsg} – retrying in ${delay}ms`
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            } else {
                logger.error("✗ Redis connection failed after all retries:", {
                    error: errorMsg,
                    redisUrl: config.redisUrl?.replace(/:[^:@]+@/, ":***@"),
                });
                logger.error("Unable to connect to Redis. Please ensure:");
                logger.error("  1. Redis is running on the correct port (default: 6379)");
                logger.error("  2. REDIS_URL in .env is correct");
                process.exit(1);
            }
        }
    }
}

async function startWorkerRuntime() {
    await checkPostgresConnection();
    await checkRedisConnection();
    await dependencyReadiness.probe(true);

    logger.info(
        `[Worker Startup] BACKEND_PROCESS_ROLE=${workerProcessRole} (api=false, worker=true)`
    );

    const { initializeMusicConfig } = await import("./config");
    await initializeMusicConfig();

    await import("./workers");
    workersInitialized = true;

    logger.debug(
        "Background enrichment enabled for owned content (genres, MBIDs, etc.)"
    );
    logger.debug(
        "Startup maintenance jobs are queue-claimed (cache warmup, podcast cleanup, audiobook sync, download reconciliation, backfills)"
    );

    logger.info("[Worker Startup] Worker runtime initialized");
    isStartupComplete = true;
}

async function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
        logger.debug("Shutdown already in progress...");
        return;
    }

    isShuttingDown = true;
    isDraining = true;
    logger.debug(`\nReceived ${signal}. Starting graceful worker shutdown...`);

    try {
        if (workersInitialized) {
            const { shutdownWorkers } = await import("./workers");
            await shutdownWorkers();
        }

        logger.debug("Closing Redis connection...");
        await redisClient.quit();

        logger.debug("Closing database connection...");
        await prisma.$disconnect();

        await stopHealthServer();
        logger.debug("Graceful worker shutdown complete");
        process.exit(0);
    } catch (error) {
        logger.error("Error during worker shutdown:", error);
        process.exit(1);
    }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled Promise Rejection:", {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
    });
});

process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception - initiating graceful worker shutdown:", {
        message: error.message,
        stack: error.stack,
    });
    gracefulShutdown("uncaughtException").catch(() => {
        process.exit(1);
    });
});

const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
setInterval(async () => {
    try {
        const dependencySnapshot = await dependencyReadiness.probe(true);
        if (!dependencySnapshot.overallHealthy) {
            logger.error("Worker readiness dependency check failed:", {
                postgres: dependencySnapshot.postgres,
                redis: dependencySnapshot.redis,
            });

            if (!dependencySnapshot.postgres.ok) {
                try {
                    await prisma.$disconnect();
                    await prisma.$connect();
                    logger.debug("Worker database connection recovered");
                    await dependencyReadiness.probe(true);
                } catch (reconnectError) {
                    logger.error(
                        "Worker failed to recover database connection:",
                        reconnectError
                    );
                }
            }
        }
    } catch (error) {
        logger.error("Worker health check failed - connections may be stale:", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}, HEALTH_CHECK_INTERVAL);

startHealthServer();

startWorkerRuntime().catch(async (error) => {
    isDraining = true;
    logger.error("[Worker Startup] Fatal startup error:", error);
    await stopHealthServer();
    process.exit(1);
});
