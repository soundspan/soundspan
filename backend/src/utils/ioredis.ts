/**
 * Shared ioredis connection factory
 *
 * Provides a pre-configured Redis constructor with exponential-backoff retry,
 * sensible timeouts, and structured logging so every ioredis connection in the
 * app behaves consistently.
 *
 * Usage:
 *   import { createIORedisClient } from "../utils/ioredis";
 *   const redis = createIORedisClient("enrichment-state");
 */

import Redis, { RedisOptions } from "ioredis";
import { logger } from "./logger";
import { config } from "../config";

const MAX_RETRY_DELAY_MS = 30_000; // 30 seconds
const BASE_RETRY_DELAY_MS = 250;   // Start at 250ms

/**
 * Create an ioredis client with built-in retry logic.
 *
 * @param label  - Human-readable label used in log messages (e.g. "enrichment-state")
 * @param overrides - Any per-instance ioredis option overrides
 */
export function createIORedisClient(
    label: string,
    overrides: Partial<RedisOptions> = {},
): Redis {
    const client = new Redis(config.redisUrl, {
        // Exponential backoff: 250ms → 500ms → 1s → 2s → … capped at 30s
        retryStrategy(times: number) {
            const delay = Math.min(
                BASE_RETRY_DELAY_MS * Math.pow(2, times - 1),
                MAX_RETRY_DELAY_MS,
            );
            logger.debug(
                `[ioredis:${label}] Reconnect attempt ${times} – retrying in ${delay}ms`,
            );
            return delay;
        },

        maxRetriesPerRequest: 3,       // Fail individual commands after 3 retries
        connectTimeout: 10_000,        // 10s connect timeout
        enableReadyCheck: true,        // Wait for Redis INFO before emitting "ready"
        lazyConnect: false,            // Connect immediately

        ...overrides,
    });

    client.on("error", (err) => {
        logger.error(`[ioredis:${label}] Error: ${err.message}`);
    });

    client.on("close", () => {
        logger.debug(`[ioredis:${label}] Connection closed`);
    });

    client.on("reconnecting", (ms: number) => {
        logger.debug(`[ioredis:${label}] Reconnecting in ${ms}ms...`);
    });

    client.on("ready", () => {
        logger.debug(`[ioredis:${label}] Ready`);
    });

    return client;
}
