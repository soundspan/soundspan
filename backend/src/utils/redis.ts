import { createClient } from "redis";
import { logger } from "./logger";
import { config } from "../config";

const MAX_RETRY_DELAY_MS = 30_000; // Cap at 30 seconds
const BASE_RETRY_DELAY_MS = 250;   // Start at 250ms

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

redisClient.on("disconnect", () => {
    logger.debug("Redis disconnected - will reconnect automatically");
});

redisClient.on("reconnecting", () => {
    logger.debug("Redis reconnecting...");
});

redisClient.on("ready", () => {
    logger.debug("Redis ready");
});

// Connect immediately on module load
redisClient.connect().catch((error) => {
    logger.error("Redis initial connection failed:", error.message);
    logger.debug("Redis will continue retrying in the background...");
});

export { redisClient };
