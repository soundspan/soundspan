import Bull from "bull";
import { logger } from "../utils/logger";
import { config } from "../config";

function buildBullRedisConfig(redisUrlString: string): Bull.QueueOptions["redis"] {
    const fallback: Bull.QueueOptions["redis"] = {
        host: "127.0.0.1",
        port: 6379,
    };

    try {
        const redisUrl = new URL(redisUrlString);
        const isTls = redisUrl.protocol === "rediss:";
        const port = redisUrl.port
            ? Number.parseInt(redisUrl.port, 10)
            : isTls
              ? 6380
              : 6379;
        const dbRaw = redisUrl.pathname.replace(/^\/+/, "");
        const db = dbRaw ? Number.parseInt(dbRaw, 10) : undefined;

        const redisConfig: Record<string, unknown> = {
            host: redisUrl.hostname,
            port,
        };

        if (redisUrl.username) {
            redisConfig.username = decodeURIComponent(redisUrl.username);
        }
        if (redisUrl.password) {
            redisConfig.password = decodeURIComponent(redisUrl.password);
        }
        if (db !== undefined && Number.isFinite(db) && db >= 0) {
            redisConfig.db = db;
        }
        if (isTls) {
            // Enable TLS for rediss:// endpoints.
            redisConfig.tls = {};
        }

        logger.debug(
            `[Bull] Redis config resolved (host=${redisUrl.hostname}, port=${port}, db=${redisConfig.db ?? 0}, tls=${isTls})`
        );

        return redisConfig as Bull.QueueOptions["redis"];
    } catch (error) {
        logger.warn(
            `[Bull] Failed to parse REDIS_URL for queues, falling back to ${fallback.host}:${fallback.port}`
        );
        return fallback;
    }
}

const redisConfig = buildBullRedisConfig(config.redisUrl);

// Default queue settings for better stability
const defaultQueueSettings: Bull.QueueOptions["settings"] = {
    // Check for stalled jobs every 30 seconds
    stalledInterval: 30000,
    // Mark a job as stalled if it hasn't reported progress in 30 seconds
    lockDuration: 30000,
    // Retry stalled jobs once before marking as failed
    maxStalledCount: 1,
};

// Create queues with stability settings
export const scanQueue = new Bull("library-scan", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

export const discoverQueue = new Bull("discover-weekly", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

export const imageQueue = new Bull("image-optimization", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

export const validationQueue = new Bull("file-validation", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

export const analysisQueue = new Bull("audio-analysis", {
    redis: redisConfig,
    settings: {
        ...defaultQueueSettings,
        // Audio analysis can take longer - extend lock duration
        lockDuration: 120000,
    },
});

export const schedulerQueue = new Bull("worker-scheduler", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

// Export all queues for monitoring
export const queues = [
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
    analysisQueue,
    schedulerQueue,
];

// Add error handlers to all queues to prevent unhandled exceptions
queues.forEach((queue) => {
    queue.on("error", (error) => {
        logger.error(`Bull queue error (${queue.name}):`, {
            message: error.message,
            stack: error.stack,
        });
    });

    queue.on("stalled", (job) => {
        logger.warn(`Bull job stalled (${queue.name}):`, {
            jobId: job.id,
            data: job.data,
        });
    });
});

// Log queue initialization
logger.debug("Bull queues initialized with stability settings");
