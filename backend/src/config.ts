import dotenv from "dotenv";
import { z } from "zod";
import * as fs from "fs";
import { validateMusicConfig, MusicConfig } from "./utils/configValidator";
import { logger } from "./utils/logger";
import {
    isEnvFlagEnabled,
    parseEnvBool,
    parseEnvCsv,
    parseEnvInt,
} from "./utils/envParsers";

dotenv.config();

// Validate critical environment variables on startup
const envSchema = z.object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    SESSION_SECRET: z
        .string()
        .min(32, "SESSION_SECRET must be at least 32 characters"),
    PORT: z.string().optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).optional(),
    MUSIC_PATH: z.string().min(1, "MUSIC_PATH is required"),
});

try {
    envSchema.parse(process.env);
    logger.debug("Environment variables validated");
} catch (error) {
    if (error instanceof z.ZodError) {
        logger.error(" Environment validation failed:");
        error.errors.forEach((err) => {
            logger.error(`   - ${err.path.join(".")}: ${err.message}`);
        });
        logger.error(
            "\n Please check your .env file and ensure all required variables are set."
        );
        process.exit(1);
    }
}

// Music config - will be initialized async
let musicConfig: MusicConfig = {
    musicPath: process.env.MUSIC_PATH || "/music",
    transcodeCachePath:
        process.env.TRANSCODE_CACHE_PATH || "./cache/transcodes",
    transcodeCacheMaxGb: parseEnvInt(process.env.TRANSCODE_CACHE_MAX_GB, 10),
};

const allowedOriginsFromEnv = parseEnvCsv(process.env.ALLOWED_ORIGINS);

// Reverse-proxy hop count for client-IP resolution. A non-negative
// TRUST_PROXY_HOPS makes X-Forwarded-For spoofing past that many hops untrusted
// (so a client can't mint fresh per-IP rate-limit buckets). Unset/invalid →
// trust all hops, preserving existing multi-hop Docker/Portainer behavior.
const trustProxyHops = parseEnvInt(process.env.TRUST_PROXY_HOPS, -1);

// Initialize music configuration asynchronously
/** Loads and validates music-path/cache settings, with safe fallback to env defaults. */
export async function initializeMusicConfig() {
    try {
        musicConfig = await validateMusicConfig();
        logger.debug("Music configuration initialized");
    } catch (err: any) {
        logger.error(" Configuration validation failed:", err.message);
        logger.warn("   Using default/environment configuration");
        // Don't exit process - allow app to start for other features
        // Music features will fail gracefully if config is invalid
    }
}

/** Centralized runtime configuration object for backend services and integrations. */
export const config = {
    port: parseEnvInt(process.env.PORT, 3006),
    nodeEnv: process.env.NODE_ENV || "development",
    // DATABASE_URL and REDIS_URL are validated by envSchema above, so they're guaranteed to exist
    databaseUrl: process.env.DATABASE_URL!,
    redisUrl: process.env.REDIS_URL!,
    sessionSecret: process.env.SESSION_SECRET!,

    // Session cookie `secure` flag. Defaults to true in production (cookies
    // should only travel over HTTPS); HTTP-only local-network deploys must set
    // SECURE_COOKIES=false explicitly. An explicit SECURE_COOKIES is honored in
    // any environment. Routed through config to satisfy the env-boundary rule.
    secureCookies: parseEnvBool(
        process.env.SECURE_COOKIES,
        (process.env.NODE_ENV || "development") === "production"
    ),

    // Express `trust proxy` value: a numeric hop count for spoof-resistant IP
    // resolution, or `true` (trust all) by default. Set TRUST_PROXY_HOPS to your
    // real reverse-proxy depth (usually 1) to enable spoof protection.
    trustProxy: (trustProxyHops >= 0 ? trustProxyHops : true) as number | boolean,

    // Worker event-loop stall watchdog (issue #43): a stall above the warn
    // threshold logs the active Bull jobs so liveness-probe kills can be
    // attributed to the job that pegged the loop.
    workerEventLoop: {
        warnThresholdMs: parseEnvInt(
            process.env.WORKER_EVENT_LOOP_WARN_MS,
            1000
        ),
        sampleIntervalMs: parseEnvInt(
            process.env.WORKER_EVENT_LOOP_SAMPLE_MS,
            5000
        ),
    },

    // Music library configuration (self-contained native music system)
    // Access via config.music - will be updated after initialization
    get music() {
        return musicConfig;
    },

    // Lidarr - now reads from database via lidarrService.ensureInitialized()
    lidarr: isEnvFlagEnabled(process.env.LIDARR_ENABLED) ? {
        url: process.env.LIDARR_URL!,
        apiKey: process.env.LIDARR_API_KEY!,
        enabled: true,
    } : undefined,

    // Last.fm - operator-provided via env or system settings
    lastfm: {
        apiKey: process.env.LASTFM_API_KEY || "",
    },

    // OpenAI - reads from database
    openai: {
        apiKey: process.env.OPENAI_API_KEY || "", // Fallback to DB
    },

    // Deezer - reads from database
    deezer: {
        apiKey: process.env.DEEZER_API_KEY || "", // Fallback to DB
    },

    discover: {
        mode: process.env.DISCOVERY_MODE === "legacy" ? "legacy" : "recommendation",
    },

    // Coarse feature flags for ML/recommendation subsystems.
    // All default ON to preserve existing behavior; operators can disable
    // them per-deployment (e.g. via the Helm chart's config.features values).
    features: {
        // Audio analysis queueing/consumption (Essentia + CLAP vibe embeddings)
        audioAnalysis: parseEnvBool(process.env.AUDIO_ANALYSIS_ENABLED, true),
        // Discover Weekly recommendations + discovery auto-download lifecycle
        discovery: parseEnvBool(process.env.DISCOVERY_ENABLED, true),
        // Made For You mixes / programmatic playlist generation
        autoPlaylists: parseEnvBool(process.env.AUTO_PLAYLISTS_ENABLED, true),
    },

    audiobookshelf: process.env.AUDIOBOOKSHELF_URL
        ? {
              url: process.env.AUDIOBOOKSHELF_URL,
              token: process.env.AUDIOBOOKSHELF_TOKEN!,
          }
        : undefined,

    // YouTube Music streamer sidecar (also serves the regular-YouTube /yt/
    // endpoints used for URL-paste streaming and download-to-library)
    ytmusicStreamer: {
        url: process.env.YTMUSIC_STREAMER_URL || "http://127.0.0.1:8586",
    },

    allowedOrigins:
        allowedOriginsFromEnv ||
        (process.env.NODE_ENV === "development" ? true : []),
};
