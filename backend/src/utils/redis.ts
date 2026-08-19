import { createClient } from "redis";
import { logger } from "./logger";
import { config } from "../config";

const MAX_RETRY_DELAY_MS = 30_000; // Cap at 30 seconds
const BASE_RETRY_DELAY_MS = 250; // Start at 250ms
const MAX_BLOCKING_RECONNECT_ATTEMPTS = 5;
const MAX_BLOCKING_TIMEOUT_SECONDS = 300;

const redisClient = createClient({
    url: config.redisUrl,
    socket: {
        reconnectStrategy: (retries: number) => {
            // Exponential backoff: 250ms, 500ms, 1s, 2s, 4s, … capped at 30s
            const delay = Math.min(
                BASE_RETRY_DELAY_MS * Math.pow(2, retries),
                MAX_RETRY_DELAY_MS,
            );
            logger.debug(
                `Redis reconnect attempt ${retries + 1} – retrying in ${delay}ms`,
            );
            return delay;
        },
        connectTimeout: 10_000, // 10s connect timeout
    },
});

// Handle Redis errors gracefully
redisClient.on("error", (err) => {
    logger.error("Redis error:", err.message);
    // Don't crash the app - Redis is optional for caching
});

// node-redis emits "end" when the connection closes (there is no "disconnect" event).
redisClient.on("end", () => {
    logger.debug("Redis disconnected - will reconnect automatically");
});

redisClient.on("reconnecting", () => {
    logger.debug("Redis reconnecting...");
});

redisClient.on("ready", () => {
    logger.debug("Redis ready");
});

const runningUnderJest = process.env.JEST_WORKER_ID !== undefined;
if (!runningUnderJest) {
    // Under Jest there is no Redis; the unbounded reconnect loop would outlive test suites and log after teardown.
    redisClient.connect().catch((error) => {
        logger.error("Redis initial connection failed:", error.message);
        logger.debug("Redis will continue retrying in the background...");
    });
}

type DedicatedRedisClient = typeof redisClient;

interface BlockingRedisConnection {
    client: DedicatedRedisClient;
    connectPromise: Promise<void> | null;
    lifecycle: { destroyed: boolean };
}

const blockingConnections = new Map<string, BlockingRedisConnection>();

function blockingReconnectStrategy(
    retries: number,
    shutdownRequested: boolean,
): number | Error {
    if (shutdownRequested) {
        return new Error("Dedicated Redis blocking connection was stopped");
    }
    if (retries >= MAX_BLOCKING_RECONNECT_ATTEMPTS) {
        return new Error(
            `Dedicated Redis reconnect limit reached after ${MAX_BLOCKING_RECONNECT_ATTEMPTS} attempts`,
        );
    }
    return Math.min(
        BASE_RETRY_DELAY_MS * Math.pow(2, retries),
        MAX_RETRY_DELAY_MS,
    );
}

function createBlockingConnection(): BlockingRedisConnection {
    const lifecycle = { destroyed: false };
    const client = redisClient.duplicate({
        socket: {
            connectTimeout: 10_000,
            reconnectStrategy: (retries: number) =>
                blockingReconnectStrategy(retries, lifecycle.destroyed),
        },
    });
    client.on("error", (error) => {
        if (lifecycle.destroyed) return;
        logger.error(
            "Dedicated Redis blocking connection error:",
            error.message,
        );
    });
    return { client, connectPromise: null, lifecycle };
}

function destroyBlockingConnection(
    key: string,
    connection: BlockingRedisConnection,
): void {
    if (connection.lifecycle.destroyed) return;
    connection.lifecycle.destroyed = true;
    if (blockingConnections.get(key) === connection) {
        blockingConnections.delete(key);
    }
    try {
        connection.client.destroy();
    } catch (error) {
        logger.debug(
            "Failed to destroy dedicated Redis connection:",
            error instanceof Error ? error.message : String(error),
        );
    }
}

async function connectBlockingConnection(
    key: string,
    connection: BlockingRedisConnection,
): Promise<void> {
    if (connection.client.isOpen) return;
    if (!connection.connectPromise) {
        const connecting = connection.client
            .connect()
            .then(() => undefined)
            .catch((error: unknown) => {
                destroyBlockingConnection(key, connection);
                throw error;
            })
            .finally(() => {
                if (connection.connectPromise === connecting) {
                    connection.connectPromise = null;
                }
            });
        connection.connectPromise = connecting;
    }
    await connection.connectPromise;
}

function getBlockingConnection(key: string): BlockingRedisConnection {
    const current = blockingConnections.get(key);
    if (current) return current;
    const created = createBlockingConnection();
    blockingConnections.set(key, created);
    return created;
}

function validateBlockingPop(key: string, timeoutSeconds: number): void {
    if (key.trim().length === 0) throw new TypeError("Redis key is required");
    if (
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > MAX_BLOCKING_TIMEOUT_SECONDS
    ) {
        throw new RangeError(
            `Redis blocking timeout must be an integer from 1 through ${MAX_BLOCKING_TIMEOUT_SECONDS}`,
        );
    }
}

/** Run BLPOP on a persistent connection dedicated to this queue key. */
export async function blockingBlPop(
    key: string,
    timeoutSeconds: number,
): Promise<{ key: string; element: string } | null> {
    validateBlockingPop(key, timeoutSeconds);
    const connection = getBlockingConnection(key);
    try {
        await connectBlockingConnection(key, connection);
        return await connection.client.blPop(key, timeoutSeconds);
    } catch (error) {
        destroyBlockingConnection(key, connection);
        throw error;
    }
}

/** Destroy the persistent blocking connection and interrupt its current wait. */
export async function closeBlockingBlPop(key: string): Promise<void> {
    const connection = blockingConnections.get(key);
    if (!connection) return;
    destroyBlockingConnection(key, connection);
}

export { redisClient };
