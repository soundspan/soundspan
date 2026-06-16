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
    // Most of the ~15 scanQueue.add() sites enqueue without per-job retention
    // options, so without a default Redis accumulates completed/failed scan
    // records unbounded. Keep a bounded window: the last 100 completed (enough
    // for the recent-job status lookup in routes/library.ts) and 200 failed for
    // debugging.
    defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200,
    },
});

export const discoverQueue = new Bull("discover-weekly", {
    redis: redisConfig,
    settings: defaultQueueSettings,
    // The processor now re-throws on failure, so give Bull a bounded retry with
    // backoff for transient upstream (Last.fm / MusicBrainz) or DB blips instead
    // of losing the week's generation. The default "recommendation" path is
    // idempotent per (user, week) — it deletes and recreates the week's batch in
    // one transaction — so a retry replaces rather than duplicates. Legacy mode's
    // missing per-(user, week) guard is tracked separately (#13, F20).
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60000 },
    },
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
