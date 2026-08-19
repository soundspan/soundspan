import dotenv from "dotenv";
import { z } from "zod";
import * as fs from "fs";
import { validateMusicConfig, MusicConfig } from "./utils/configValidator";
import { logger } from "./utils/logger";
import { validateEncryptionKey } from "./utils/encryption";
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

// Playback trace logging accepts a wider truthy set than isEnvFlagEnabled.
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

const nonnegativeIntegerEnvSchema = z
    .string()
    .regex(/^(0|[1-9]\d*)$/, "must be an integer greater than or equal to 0")
    .refine((value) => Number.isSafeInteger(Number(value)), {
        message: "must be a safe integer",
    })
    .optional();
const positiveIntegerEnvSchema = z
    .string()
    .regex(/^[1-9]\d*$/, "must be a positive integer")
    .refine((value) => Number.isSafeInteger(Number(value)), {
        message: "must be a safe integer",
    })
    .optional();
const booleanEnvSchema = z.enum(["true", "false"]).optional();
const federationTombstoneRetentionEnvSchema = z
    .string()
    .regex(/^[1-9]\d*$/, "must be an integer greater than or equal to 3")
    .refine((value) => Number.isSafeInteger(Number(value)), {
        message: "must be a safe integer",
    })
    .refine((value) => Number(value) >= 3, {
        message: "must be an integer greater than or equal to 3",
    })
    .optional();

const vibeProviderUrlEnvSchema = z
    .string()
    .trim()
    .refine(
        (value) => {
            try {
                const url = new URL(value);
                return (
                    (url.protocol === "http:" || url.protocol === "https:") &&
                    !url.username &&
                    !url.password &&
                    !url.search &&
                    !url.hash
                );
            } catch {
                return false;
            }
        },
        {
            message:
                "VIBE_PROVIDER_URL must be a valid HTTP(S) URL without credentials",
        },
    )
    .optional();

const vibeEmbedConcurrencyEnvSchema = z
    .string()
    .regex(/^[1-8]$/, {
        message: "VIBE_EMBED_CONCURRENCY must be an integer from 1 through 8",
    })
    .optional();

const loudnessBackfillBatchSizeEnvSchema = z
    .string()
    .regex(/^-?\d+$/, {
        message: "LOUDNESS_BACKFILL_BATCH_SIZE must be an integer",
    })
    .refine((value) => Number.isSafeInteger(Number(value)), {
        message: "LOUDNESS_BACKFILL_BATCH_SIZE must be a safe integer",
    })
    .optional();
const loudnessBackfillBatchSizeSchema = z
    .number()
    .int()
    .safe()
    .transform((value) => Math.max(1, Math.min(200, value)));

const vibeMapWorkerMemoryMbEnvSchema = z
    .string()
    .refine(
        (value) => {
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed >= 128 && parsed <= 4096;
        },
        {
            message:
                "VIBE_MAP_WORKER_MEMORY_MB must be an integer from 128 through 4096",
        },
    )
    .optional();

const vibeSpaceCutoverThresholdEnvSchema = z
    .string()
    .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/, {
        message:
            "VIBE_SPACE_CUTOVER_THRESHOLD must be a number from 0.5 through 1",
    })
    .refine((value) => Number(value) >= 0.5, {
        message:
            "VIBE_SPACE_CUTOVER_THRESHOLD must be a number from 0.5 through 1",
    })
    .optional();

const vibeSpaceRetirementGraceDaysEnvSchema = z
    .string()
    .regex(/^[1-9]\d*$/, {
        message:
            "VIBE_SPACE_RETIREMENT_GRACE_DAYS must be an integer from 1 through 90",
    })
    .refine((value) => Number(value) <= 90, {
        message:
            "VIBE_SPACE_RETIREMENT_GRACE_DAYS must be an integer from 1 through 90",
    })
    .optional();

const loudnessTargetLufsEnvSchema = z
    .string()
    .trim()
    .refine(
        (value) => {
            const parsed = parseEnvFloat(value, Number.NaN);
            return Number.isFinite(parsed) && parsed >= -30 && parsed <= -10;
        },
        {
            message:
                "LOUDNESS_TARGET_LUFS must be a number from -30 through -10",
        },
    )
    .optional();

function normalizeVibeProviderUrl(
    value: string | undefined,
): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return trimmed.replace(/\/+$/, "");
}

type OidcEnvInput = {
    LOCAL_LOGIN_ENABLED?: string;
    OIDC_ENABLED?: string;
    OIDC_ISSUER_URL?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_CLIENT_SECRET?: string;
    OIDC_REDIRECT_URI?: string;
    OIDC_WEB_BASE_URL?: string;
    OIDC_MANAGE_ROLES?: string;
    OIDC_ADMIN_GROUP?: string;
};

const REQUIRED_OIDC_KEYS = [
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI",
] as const;

const OIDC_URL_KEYS = ["OIDC_ISSUER_URL", "OIDC_REDIRECT_URI"] as const;

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function normalizeOidcWebBaseUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
        const url = new URL(trimmed);
        const isHttp = url.protocol === "http:" || url.protocol === "https:";
        const schemeEnd = trimmed.indexOf("://") + 3;
        const pathStart = trimmed.indexOf("/", schemeEnd);
        const path = pathStart === -1 ? "" : trimmed.slice(pathStart);
        const hasUrlSuffix =
            (path !== "" && path !== "/") ||
            trimmed.includes("?") ||
            trimmed.includes("#");
        if (
            !isHttp ||
            url.username ||
            url.password ||
            trimmed.includes("\\") ||
            hasUrlSuffix
        ) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
}

function addLoginLockoutIssue(
    localLoginEnabled: boolean,
    oidcEnabled: boolean,
    context: z.RefinementCtx,
): void {
    if (localLoginEnabled || oidcEnabled) return;
    context.addIssue({
        code: "custom",
        path: ["LOCAL_LOGIN_ENABLED"],
        message:
            "LOCAL_LOGIN_ENABLED=false requires OIDC_ENABLED=true to prevent total lockout",
    });
}

function addRoleManagementIssues(
    env: OidcEnvInput,
    oidcEnabled: boolean,
    manageRoles: boolean,
    context: z.RefinementCtx,
): void {
    if (!manageRoles) return;
    if (!oidcEnabled) {
        context.addIssue({
            code: "custom",
            path: ["OIDC_MANAGE_ROLES"],
            message: "OIDC_MANAGE_ROLES=true requires OIDC_ENABLED=true",
        });
    }
    if (!env.OIDC_ADMIN_GROUP?.trim()) {
        context.addIssue({
            code: "custom",
            path: ["OIDC_ADMIN_GROUP"],
            message: "OIDC_ADMIN_GROUP is required when OIDC_MANAGE_ROLES=true",
        });
    }
}

function addOidcWebBaseUrlIssues(
    env: OidcEnvInput,
    oidcEnabled: boolean,
    context: z.RefinementCtx,
): void {
    const value = env.OIDC_WEB_BASE_URL?.trim();
    if (!value) return;
    if (!oidcEnabled) {
        context.addIssue({
            code: "custom",
            path: ["OIDC_WEB_BASE_URL"],
            message: "OIDC_WEB_BASE_URL requires OIDC_ENABLED=true",
        });
    }
    if (normalizeOidcWebBaseUrl(value) !== null) return;
    context.addIssue({
        code: "custom",
        path: ["OIDC_WEB_BASE_URL"],
        message:
            "OIDC_WEB_BASE_URL must be a valid HTTP(S) origin with no path, query, or fragment",
    });
}

function addRequiredOidcIssues(
    env: OidcEnvInput,
    context: z.RefinementCtx,
): void {
    for (const key of REQUIRED_OIDC_KEYS) {
        if (env[key]?.trim()) continue;
        context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when OIDC_ENABLED=true`,
        });
    }
}

function addOidcUrlIssues(env: OidcEnvInput, context: z.RefinementCtx): void {
    for (const key of OIDC_URL_KEYS) {
        const value = env[key]?.trim();
        if (!value || isHttpUrl(value)) continue;
        context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} must be a valid HTTP(S) URL`,
        });
    }
}

function addOidcConfigIssues(
    env: OidcEnvInput,
    context: z.RefinementCtx,
): void {
    const oidcEnabled = parseEnvBool(env.OIDC_ENABLED, false);
    const localLoginEnabled = parseEnvBool(env.LOCAL_LOGIN_ENABLED, true);
    const manageRoles = parseEnvBool(env.OIDC_MANAGE_ROLES, false);

    addLoginLockoutIssue(localLoginEnabled, oidcEnabled, context);
    addRoleManagementIssues(env, oidcEnabled, manageRoles, context);
    addOidcWebBaseUrlIssues(env, oidcEnabled, context);
    if (!oidcEnabled) return;
    addRequiredOidcIssues(env, context);
    addOidcUrlIssues(env, context);
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
        VIBE_PROVIDER_URL: vibeProviderUrlEnvSchema,
        VIBE_EMBED_CONCURRENCY: vibeEmbedConcurrencyEnvSchema,
        LOUDNESS_BACKFILL_BATCH_SIZE: loudnessBackfillBatchSizeEnvSchema,
        VIBE_MAP_WORKER_MEMORY_MB: vibeMapWorkerMemoryMbEnvSchema,
        VIBE_SPACE_CUTOVER_THRESHOLD: vibeSpaceCutoverThresholdEnvSchema,
        VIBE_SPACE_CUTOVER_ALLOW_FAILED: z.string().optional(),
        VIBE_SPACE_RETIREMENT_GRACE_DAYS: vibeSpaceRetirementGraceDaysEnvSchema,
        LOUDNESS_TARGET_LUFS: loudnessTargetLufsEnvSchema,
        METRICS_TOKEN: z.string().optional(),
        METRICS_PUBLIC: z.string().optional(),
        PORT: z.string().optional(),
        NODE_ENV: z.enum(["development", "production", "test"]).optional(),
        MUSIC_PATH: z.string().min(1, "MUSIC_PATH is required"),
        TRACK_REMOVAL_RETENTION_DAYS: nonnegativeIntegerEnvSchema,
        FEDERATION_TOMBSTONE_RETENTION_DAYS:
            federationTombstoneRetentionEnvSchema,
        FEDERATION_SYNC_INTERVAL_MINUTES: positiveIntegerEnvSchema,
        FEDERATION_ALLOW_PRIVATE_PEERS: booleanEnvSchema,
        LOCAL_LOGIN_ENABLED: z.string().optional(),
        OIDC_ENABLED: z.string().optional(),
        OIDC_ISSUER_URL: z.string().optional(),
        OIDC_CLIENT_ID: z.string().optional(),
        OIDC_CLIENT_SECRET: z.string().optional(),
        OIDC_REDIRECT_URI: z.string().optional(),
        OIDC_WEB_BASE_URL: z.string().optional(),
        OIDC_SCOPES: z.string().optional(),
        OIDC_AUTO_PROVISION: z.string().optional(),
        OIDC_MANAGE_ROLES: z.string().optional(),
        OIDC_GROUPS_CLAIM: z.string().optional(),
        OIDC_ADMIN_GROUP: z.string().optional(),
        OIDC_EMAIL_CLAIM: z.string().optional(),
        OIDC_NAME_CLAIM: z.string().optional(),
        OIDC_PROVIDER_NAME: z.string().optional(),
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
        addOidcConfigIssues(env, context);
    });

try {
    envSchema.parse(process.env);
    validateEncryptionKey();
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
    } else {
        logger.error(" Environment validation failed:", error);
    }
    process.exit(1);
}

const trackRemovalRetentionDays = Number.parseInt(
    process.env.TRACK_REMOVAL_RETENTION_DAYS ?? "90",
    10,
);
const federationTombstoneRetentionDays = Number.parseInt(
    process.env.FEDERATION_TOMBSTONE_RETENTION_DAYS ?? "90",
    10,
);
const federationSyncIntervalMinutes = Number.parseInt(
    process.env.FEDERATION_SYNC_INTERVAL_MINUTES ?? "15",
    10,
);

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
const loudnessBackfillBatchSize = loudnessBackfillBatchSizeSchema.parse(
    Number(process.env.LOUDNESS_BACKFILL_BATCH_SIZE ?? "25"),
);

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
    socketKeepAliveDelayMs: positiveIntEnvOr(
        process.env.SOCKET_KEEPALIVE_DELAY_MS,
        30_000,
    ),
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
    loudnessTargetLufs: parseEnvFloat(process.env.LOUDNESS_TARGET_LUFS, -18),
    get soundspanCallbackUrl(): string {
        return process.env.SOUNDSPAN_CALLBACK_URL || "http://backend:3006";
    },
    get playlistLogDir(): string | undefined {
        return process.env.PLAYLIST_LOG_DIR || undefined;
    },
    // DATABASE_URL and REDIS_URL are validated by envSchema above, so they're guaranteed to exist
    databaseUrl: databaseUrl!,
    redisUrl: process.env.REDIS_URL!,

    // Optional text/audio embedding provider base URL. An empty value disables
    // provider-backed text search and audio embedding consumption.
    vibeProviderUrl: normalizeVibeProviderUrl(process.env.VIBE_PROVIDER_URL),
    vibeEmbedConcurrency: Number(process.env.VIBE_EMBED_CONCURRENCY ?? "1"),
    // Heap ceiling for the UMAP projection worker thread. The map compute
    // degrades its sample size instead of crashing when this is exceeded.
    vibeMapWorkerMemoryMb: Number(
        process.env.VIBE_MAP_WORKER_MEMORY_MB ?? "512",
    ),
    vibeSpaceCutoverThreshold: Number(
        process.env.VIBE_SPACE_CUTOVER_THRESHOLD ?? "0.95",
    ),
    vibeSpaceCutoverAllowFailed: parseEnvBool(
        process.env.VIBE_SPACE_CUTOVER_ALLOW_FAILED,
        false,
    ),
    vibeSpaceRetirementGraceDays: Number(
        process.env.VIBE_SPACE_RETIREMENT_GRACE_DAYS ?? "7",
    ),

    // Required stable deployment secret retained as the JWT signing fallback
    // and final API-key pepper fallback. It no longer configures sessions.
    sessionSecret: process.env.SESSION_SECRET!,

    // Canonical JWT signing secret (single derivation shared by token signers).
    // SESSION_SECRET is validated required above, so this is always a string.
    jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET!,

    // One-shot admin password reset via env (consumed once at startup).
    adminResetPassword: process.env.ADMIN_RESET_PASSWORD,

    localLoginEnabled: parseEnvBool(process.env.LOCAL_LOGIN_ENABLED, true),

    oidc: {
        enabled: parseEnvBool(process.env.OIDC_ENABLED, false),
        issuerUrl: process.env.OIDC_ISSUER_URL || "",
        clientId: process.env.OIDC_CLIENT_ID || "",
        clientSecret: process.env.OIDC_CLIENT_SECRET || "",
        redirectUri: process.env.OIDC_REDIRECT_URI || "",
        webBaseUrl:
            normalizeOidcWebBaseUrl(process.env.OIDC_WEB_BASE_URL ?? "") ?? "",
        scopes: process.env.OIDC_SCOPES || "openid profile email",
        autoProvision: parseEnvBool(process.env.OIDC_AUTO_PROVISION, false),
        manageRoles: parseEnvBool(process.env.OIDC_MANAGE_ROLES, false),
        groupsClaim: process.env.OIDC_GROUPS_CLAIM || "groups",
        adminGroup: process.env.OIDC_ADMIN_GROUP || "",
        emailClaim: process.env.OIDC_EMAIL_CLAIM || "email",
        nameClaim: process.env.OIDC_NAME_CLAIM || "name",
        providerName: process.env.OIDC_PROVIDER_NAME || "SSO",
    },

    // Raw OpenAPI JSON spec is public in production only when DOCS_PUBLIC=true.
    docsPublic: isEnvFlagEnabled(process.env.DOCS_PUBLIC),

    // Prometheus metrics fail closed unless a bearer token is configured.
    // Public exposure is an explicit unsafe opt-out for private networks only.
    metrics: {
        token: process.env.METRICS_TOKEN?.trim() || undefined,
        publicAccess: parseEnvBool(process.env.METRICS_PUBLIC, false),
    },

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
    // ("similar tracks" / vibe) query scans. The indexes use size-banded lists
    // capped at 224; Postgres defaults probes to 1, so an unconfigured query
    // scans one list and recall can be silently near-random. Applied per-query on
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
        // Read-only instance federation API and host credential management.
        federation: parseEnvBool(process.env.FEDERATION_ENABLED, false),
    },

    federation: {
        // SystemSettings has no instance-name field today. Container/host name
        // is the established deployment identity fallback for federation v1.
        instanceName: process.env.HOSTNAME || "soundspan",
        // Unsafe opt-in for administrators whose peers use literal LAN/VPN IPs.
        allowPrivatePeers: parseEnvBool(
            process.env.FEDERATION_ALLOW_PRIVATE_PEERS,
            false,
        ),
    },

    // Keep analyzer queues short enough that waiting work is not mistaken for
    // active processing. Per-track reservations suppress repeated producers.
    analysisQueues: {
        loudnessBackfillBatchSize,
        audioMaxDepth: boundedPositiveIntEnvOr(
            process.env.AUDIO_ANALYSIS_QUEUE_MAX_DEPTH,
            100,
            10_000,
        ),
        vibeMaxDepth: boundedPositiveIntEnvOr(
            process.env.VIBE_ANALYSIS_QUEUE_MAX_DEPTH,
            100,
            10_000,
        ),
        reservationTtlSeconds: boundedPositiveIntEnvOr(
            process.env.ANALYSIS_QUEUE_RESERVATION_TTL_SECONDS,
            3600,
            86_400,
        ),
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

    streaming: {
        ffmpegPathOverride: process.env.FFMPEG_PATH?.trim() || undefined,
        traceEnabled: isTraceTruthy(process.env.STREAMING_TRACE_LOGS),
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
        trackRemovalRetentionDays,
        federationTombstoneRetentionDays,
        federationSyncIntervalMinutes,
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
        get trackReconciliationMaxRows(): number {
            return boundedPositiveIntEnvOr(
                process.env.TRACK_RECONCILIATION_MAX_ROWS,
                10_000,
                100_000,
            );
        },
        get trackReconciliationTimeoutMs(): number {
            return boundedPositiveIntEnvOr(
                process.env.TRACK_RECONCILIATION_TIMEOUT_MS,
                10 * 60 * 1000,
                55 * 60 * 1000,
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
