import dotenv from "dotenv";
import { z } from "zod";
import * as fs from "fs";
import { validateMusicConfig, MusicConfig } from "./utils/configValidator";
import { logger } from "./utils/logger";
import {
    isEnvFlagEnabled,
    parseEnvBool,
    parseEnvCsv,
    parseEnvFloat,
    parseEnvInt,
} from "./utils/envParsers";
import {
    CRITICAL_SECRET_MIN_LENGTH,
    getCriticalSecretFailure,
    INSECURE_INTERNAL_API_SECRET,
    INSECURE_SETTINGS_ENCRYPTION_KEY,
    isSecretsDbOnlyEnabled,
    resolveSettingsEncryptionKey,
    type CriticalSecretFailure,
} from "./config/secretsPolicy";

const { resolveDatabaseUrl } = require("../databaseUrl") as {
    resolveDatabaseUrl: (environment: NodeJS.ProcessEnv) => string | undefined;
};

// quiet is a no-op on dotenv 16 and silences v17's per-boot injection tip line
dotenv.config({ quiet: true });

const databaseUrl = resolveDatabaseUrl(process.env);
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const secretsDbOnly = isSecretsDbOnlyEnabled();

// Lenient positive-int env read with a numeric fallback (matches the historical
// `Number.parseInt(value || `${fallback}`, 10)` then `>0 ? : fallback` idiom).
const positiveIntEnvOr = (
    value: string | undefined,
    fallback: number,
): number => {
    const parsed = Number.parseInt((value ?? "").trim() || `${fallback}`, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const boundedPositiveIntEnvOr = (
    value: string | undefined,
    fallback: number,
    maximum: number,
): number => {
    const parsed = parseEnvInt(value, fallback);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
        ? parsed
        : fallback;
};

// Lenient positive-int override; null when unset/empty/non-positive.
const positiveIntEnvOrNull = (value: string | undefined): number | null => {
    const raw = value?.trim();
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// Lenient positive-float override; null when unset/empty/non-positive.
const positiveNumberEnvOrNull = (value: string | undefined): number | null => {
    const raw = value?.trim();
    if (!raw) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// Segmented-streaming trace flag accepts a wider truthy set than isEnvFlagEnabled.
const TRACE_TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const isTraceTruthy = (value: string | undefined): boolean => {
    const normalized = value?.trim().toLowerCase();
    return normalized ? TRACE_TRUTHY_VALUES.has(normalized) : false;
};

function criticalSecretMessage(
    name: string,
    failure: CriticalSecretFailure,
): string {
    if (failure === "missing") return `${name} is required`;
    if (failure === "published-default") {
        return `${name} must not use the published insecure default`;
    }
    return `${name} must be at least ${CRITICAL_SECRET_MIN_LENGTH} characters`;
}

function addCriticalSecretIssue(
    context: z.RefinementCtx,
    name: string,
    value: string | undefined,
    publishedDefault: string,
): void {
    const failure = getCriticalSecretFailure(value, publishedDefault);
    if (!failure) return;
    context.addIssue({
        code: "custom",
        path: [name],
        message: criticalSecretMessage(name, failure),
    });
}

// Validate critical environment variables on startup.
const envSchema = z
    .object({
        DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
        REDIS_URL: z.string().min(1, "REDIS_URL is required"),
        SESSION_SECRET: z
            .string()
            .min(32, "SESSION_SECRET must be at least 32 characters"),
        JWT_SECRET: z
            .string()
            .min(32, "JWT_SECRET must be at least 32 characters")
            .optional(),
        SETTINGS_ENCRYPTION_KEY: z.string().optional(),
        ENCRYPTION_KEY: z.string().optional(),
        INTERNAL_API_SECRET: z.string().optional(),
        PORT: z.string().optional(),
        NODE_ENV: z.enum(["development", "production", "test"]).optional(),
        MUSIC_PATH: z.string().min(1, "MUSIC_PATH is required"),
    })
    .superRefine((env, context) => {
        const encryptionKey = resolveSettingsEncryptionKey(env);
        addCriticalSecretIssue(
            context,
            encryptionKey.name,
            encryptionKey.value,
            INSECURE_SETTINGS_ENCRYPTION_KEY,
        );
        addCriticalSecretIssue(
            context,
            "INTERNAL_API_SECRET",
            env.INTERNAL_API_SECRET,
            INSECURE_INTERNAL_API_SECRET,
        );
    });

try {
    envSchema.parse(process.env);
    logger.debug("Environment variables validated");
} catch (error) {
    if (error instanceof z.ZodError) {
        logger.error(" Environment validation failed:");
        error.issues.forEach((err) => {
            logger.error(`   - ${err.path.join(".")}: ${err.message}`);
        });
        logger.error(
            "\n Please check your .env file and ensure all required variables are set.",
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

const transcodeConcurrency = boundedPositiveIntEnvOr(
    process.env.TRANSCODE_CONCURRENCY,
    3,
    32,
);
const transcodeTimeoutMs = boundedPositiveIntEnvOr(
    process.env.TRANSCODE_TIMEOUT_MS,
    5 * 60 * 1000,
    60 * 60 * 1000,
);

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
    get appVersion(): string {
        return process.env.npm_package_version || "unknown";
    },
    get debugWebhooks(): boolean {
        return process.env.DEBUG_WEBHOOKS === "true";
    },
    get podcastDebug(): boolean {
        return process.env.PODCAST_DEBUG === "1";
    },
    subsonicTraceLogs: process.env.SUBSONIC_TRACE_LOGS === "true",
    get soundspanCallbackUrl(): string {
        return process.env.SOUNDSPAN_CALLBACK_URL || "http://backend:3006";
    },
    get playlistLogDir(): string | undefined {
        return process.env.PLAYLIST_LOG_DIR || undefined;
    },
    // DATABASE_URL and REDIS_URL are validated by envSchema above, so they're guaranteed to exist
    databaseUrl: databaseUrl!,
    redisUrl: process.env.REDIS_URL!,
    sessionSecret: process.env.SESSION_SECRET!,

    // Canonical JWT/session signing secret (single derivation shared by token
    // signers). SESSION_SECRET is validated required above, so this is always a string.
    jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET!,

    // One-shot admin password reset via env (consumed once at startup).
    adminResetPassword: process.env.ADMIN_RESET_PASSWORD,

    // Raw OpenAPI JSON spec is public in production only when DOCS_PUBLIC=true.
    docsPublic: isEnvFlagEnabled(process.env.DOCS_PUBLIC),

    // Legacy (pre-GCM) at-rest decryption fails closed when true.
    settingsDecryptFailClosed: isEnvFlagEnabled(
        process.env.SETTINGS_DECRYPT_FAIL_CLOSED,
    ),

    // Integration secrets remain env-fallback compatible by default. When
    // true, reads are DB-only, envWriter omits those keys, and startup asserts
    // the settings layer is readable; see docs/ENVIRONMENT_VARIABLES.md.
    secretsDbOnly,

    // Session cookie `secure` flag. Defaults to true in production (cookies
    // should only travel over HTTPS); HTTP-only local-network deploys must set
    // SECURE_COOKIES=false explicitly. An explicit SECURE_COOKIES is honored in
    // any environment. Routed through config to satisfy the env-boundary rule.
    secureCookies: parseEnvBool(
        process.env.SECURE_COOKIES,
        (process.env.NODE_ENV || "development") === "production",
    ),

    // Express `trust proxy` value: a numeric hop count for spoof-resistant IP
    // resolution, or `true` (trust all) by default. Set TRUST_PROXY_HOPS to your
    // real reverse-proxy depth (usually 1) to enable spoof protection.
    trustProxy: (trustProxyHops >= 0 ? trustProxyHops : true) as
        | number
        | boolean,

    // Worker event-loop stall watchdog (issue #43): a stall above the warn
    // threshold logs the active Bull jobs so liveness-probe kills can be
    // attributed to the job that pegged the loop.
    workerEventLoop: {
        warnThresholdMs: parseEnvInt(
            process.env.WORKER_EVENT_LOOP_WARN_MS,
            1000,
        ),
        sampleIntervalMs: parseEnvInt(
            process.env.WORKER_EVENT_LOOP_SAMPLE_MS,
            5000,
        ),
    },

    // Disk-backed browse thumbnails share the covers volume. Both limits are
    // enforced on each cache write so query churn cannot grow it indefinitely.
    browseImageCache: {
        maxBytes: positiveIntEnvOr(
            process.env.BROWSE_IMAGE_CACHE_MAX_BYTES,
            256 * 1024 * 1024,
        ),
        maxEntries: positiveIntEnvOr(
            process.env.BROWSE_IMAGE_CACHE_MAX_ENTRIES,
            2048,
        ),
    },

    // Artist-diversity knobs for generated queues (GH #46): each artist
    // weighs n^alpha (alpha 0 = one share each, 1 = fully proportional)
    // under a hard per-artist ceiling expressed as a share of queue size.
    generationDiversity: {
        weightAlpha: parseEnvFloat(
            process.env.GENERATION_ARTIST_WEIGHT_ALPHA,
            0.5,
        ),
        shareCeiling: parseEnvFloat(
            process.env.GENERATION_ARTIST_SHARE_CEILING,
            0.3,
        ),
    },

    // pgvector ivfflat.probes: how many of the index's inverted lists each ANN
    // ("similar tracks" / vibe) query scans. The track_embeddings index is built
    // WITH (lists = 224); Postgres defaults probes to 1, so an unconfigured query
    // scans 1/224 lists and recall is silently near-random. Applied per-query on
    // the same pooled connection via utils/annQuery.ts (roadmap F14). Higher =
    // better recall, more list scans (≈ linear cost). Default is benchmark-chosen
    // for the local corpus (recall@10 ≥ ~0.95); see scripts/benchmark-ivfflat-probes.ts.
    // Benchmark (15,230-row corpus, lists=224): probes=1 recall@10≈0.26 (near-random)
    // → probes=32 recall@10≈0.96 at p95≈5.7ms; latency cliffs to ~44ms only at probes≥112.
    // Values outside Postgres' valid 1..32768 domain are clamped at the query site
    // (out-of-range only WARNs server-side and silently keeps probes=1 otherwise).
    ivfflatProbes: parseEnvInt(process.env.IVFFLAT_PROBES, 32),

    // Music library configuration (self-contained native music system)
    // Access via config.music - will be updated after initialization
    transcodeConcurrency,
    transcodeTimeoutMs,
    get music() {
        return musicConfig;
    },

    // Lidarr - now reads from database via lidarrService.ensureInitialized()
    lidarr: isEnvFlagEnabled(process.env.LIDARR_ENABLED)
        ? {
              url: process.env.LIDARR_URL!,
              apiKey: secretsDbOnly ? "" : process.env.LIDARR_API_KEY!,
              enabled: true,
          }
        : undefined,

    // Last.fm - operator-provided via env or system settings
    lastfm: {
        apiKey: secretsDbOnly ? "" : process.env.LASTFM_API_KEY || "",
    },

    // OpenAI - reads from database
    openai: {
        apiKey: secretsDbOnly ? "" : process.env.OPENAI_API_KEY || "", // Fallback to DB
    },

    // Deezer - reads from database
    deezer: {
        apiKey: secretsDbOnly ? "" : process.env.DEEZER_API_KEY || "", // Fallback to DB
    },

    fanart: {
        get apiKey(): string | undefined {
            return process.env.FANART_API_KEY;
        },
    },

    discover: {
        mode:
            process.env.DISCOVERY_MODE === "legacy"
                ? "legacy"
                : "recommendation",
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

    listenTogether: {
        reconnectSloMs: positiveIntEnvOr(
            process.env.LISTEN_TOGETHER_RECONNECT_SLO_MS,
            5000,
        ),
        allowPolling: process.env.LISTEN_TOGETHER_ALLOW_POLLING === "true",
        redisAdapterEnabled:
            process.env.LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED !== "false",
        mutationLockEnabled:
            process.env.LISTEN_TOGETHER_MUTATION_LOCK_ENABLED !== "false",
        mutationLockTtlMs: positiveIntEnvOr(
            process.env.LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS,
            3000,
        ),
        mutationLockPrefix:
            process.env.LISTEN_TOGETHER_MUTATION_LOCK_PREFIX ||
            "listen-together:mutation-lock",
        get stateSyncEnabled(): boolean {
            return process.env.LISTEN_TOGETHER_STATE_SYNC_ENABLED !== "false";
        },
        get stateSyncChannel(): string {
            return (
                process.env.LISTEN_TOGETHER_STATE_SYNC_CHANNEL ||
                "listen-together:state-sync"
            );
        },
        get stateStoreEnabled(): boolean {
            return process.env.LISTEN_TOGETHER_STATE_STORE_ENABLED !== "false";
        },
        get stateStoreKeyPrefix(): string {
            return (
                process.env.LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX ||
                "listen-together:state"
            );
        },
        get stateStoreTtlSeconds(): number {
            return positiveIntEnvOr(
                process.env.LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS,
                21_600,
            );
        },
    },

    readiness: {
        dependencyCheckIntervalMs: positiveIntEnvOr(
            process.env.READINESS_DEPENDENCY_CHECK_INTERVAL_MS,
            5000,
        ),
        dependencyCheckTimeoutMs: positiveIntEnvOr(
            process.env.READINESS_DEPENDENCY_CHECK_TIMEOUT_MS,
            2000,
        ),
        requireDependencies:
            process.env.READINESS_REQUIRE_DEPENDENCIES !== "false",
    },

    segmentedStreaming: {
        dashBuildLockEnabled:
            process.env.SEGMENTED_STREAMING_DASH_BUILD_LOCK_ENABLED !== "false",
        dashBuildLockPrefix:
            process.env.SEGMENTED_STREAMING_DASH_BUILD_LOCK_PREFIX ||
            "segmented-streaming:dash-build-lock",
        dashBuildLockTtlMsOverride: positiveIntEnvOrNull(
            process.env.SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS,
        ),
        localSegmentDurationSecOverride: positiveNumberEnvOrNull(
            process.env.SEGMENTED_LOCAL_SEG_DURATION_SEC,
        ),
        ffmpegPathOverride: process.env.FFMPEG_PATH?.trim() || undefined,
        traceEnabled:
            isTraceTruthy(process.env.STREAMING_TRACE_LOGS) ||
            isTraceTruthy(process.env.SEGMENTED_STREAMING_TRACE_LOGS),
        cache: {
            basePathOverride:
                process.env.SEGMENTED_STREAMING_CACHE_PATH?.trim() || undefined,
            maxGbOverride: positiveNumberEnvOrNull(
                process.env.SEGMENTED_STREAMING_CACHE_MAX_GB,
            ),
            pruneIntervalMsOverride: positiveNumberEnvOrNull(
                process.env.SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS,
            ),
            minAgeMsOverride: positiveNumberEnvOrNull(
                process.env.SEGMENTED_STREAMING_CACHE_MIN_AGE_MS,
            ),
            pruneTargetRatioOverride: positiveNumberEnvOrNull(
                process.env.SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO,
            ),
            schemaVersionOverride:
                process.env.SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION?.trim() ||
                undefined,
        },
    },

    get audiobookshelf(): { url: string; apiKey: string } | undefined {
        if (secretsDbOnly) return undefined;
        const url = process.env.AUDIOBOOKSHELF_URL;
        const apiKey = process.env.AUDIOBOOKSHELF_API_KEY;
        return url && apiKey ? { url, apiKey } : undefined;
    },

    get audiobookshelfEnv(): { url: string; apiKey: string } {
        return {
            url: process.env.AUDIOBOOKSHELF_URL || "",
            apiKey: secretsDbOnly
                ? ""
                : process.env.AUDIOBOOKSHELF_API_KEY || "",
        };
    },

    // YouTube Music region hint for browse/discovery proxies.
    ytmusicRegion: process.env.YTMUSIC_REGION || "US",

    tidal: {
        // TIDAL downloader/streamer sidecar base URL.
        sidecarUrl: process.env.TIDAL_SIDECAR_URL || "http://127.0.0.1:8585",
    },

    // YouTube Music streamer sidecar (also serves the regular-YouTube /yt/
    // endpoints used for URL-paste streaming and download-to-library)
    ytmusicStreamer: {
        url: process.env.YTMUSIC_STREAMER_URL || "http://127.0.0.1:8586",
    },

    // Validated shared secret sent as the `x-internal-secret` header on
    // backend→sidecar calls (F31).
    internalApiSecret: process.env.INTERNAL_API_SECRET!,

    // When no webhook secret is configured in system settings, the Lidarr
    // webhook rejects requests (fail closed) unless this is true; see
    // docs/UPGRADING.md.
    webhooks: {
        lidarrAllowUnauthenticated: parseEnvBool(
            process.env.LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED,
            false,
        ),
    },

    workers: {
        get moodBucketClaimTtlMs(): number {
            return positiveIntEnvOr(
                process.env.MOOD_BUCKET_CLAIM_TTL_MS,
                2 * 60 * 1000,
            );
        },
        get enrichmentClaimTtlMs(): number {
            return positiveIntEnvOr(
                process.env.ENRICHMENT_CLAIM_TTL_MS,
                15 * 60 * 1000,
            );
        },
    },

    // Because CORS credentials are enabled, production denies cross-origin
    // requests by default. ALLOWED_ORIGINS configures the allowlist;
    // CORS_ALLOW_ALL=true restores the legacy permissive behavior. Development
    // continues to allow all origins. See docs/UPGRADING.md.
    allowedOrigins:
        allowedOriginsFromEnv ||
        (process.env.NODE_ENV === "development"
            ? true
            : parseEnvBool(process.env.CORS_ALLOW_ALL, false)
              ? true
              : []),
};
