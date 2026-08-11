import { isEnvFlagEnabled } from "../utils/envParsers";

/** Minimum accepted length for backend encryption and internal-auth secrets. */
export const CRITICAL_SECRET_MIN_LENGTH = 32;

/** Published encryption-key sentinel that must never be accepted at runtime. */
export const INSECURE_SETTINGS_ENCRYPTION_KEY =
    "default-encryption-key-change-me";

/** Published internal-auth sentinel that must never be accepted at runtime. */
export const INSECURE_INTERNAL_API_SECRET =
    "soundspan-internal-secret-change-me";

/** Stable reason codes returned by critical-secret validation. */
export type CriticalSecretFailure =
    | "missing"
    | "published-default"
    | "too-short";

/**
 * Resolve the primary settings-encryption key with the legacy key as fallback.
 */
export function resolveSettingsEncryptionKey(env: NodeJS.ProcessEnv): {
    name: "SETTINGS_ENCRYPTION_KEY" | "ENCRYPTION_KEY";
    value: string | undefined;
} {
    if (env.SETTINGS_ENCRYPTION_KEY) {
        return {
            name: "SETTINGS_ENCRYPTION_KEY",
            value: env.SETTINGS_ENCRYPTION_KEY,
        };
    }
    if (env.ENCRYPTION_KEY) {
        return { name: "ENCRYPTION_KEY", value: env.ENCRYPTION_KEY };
    }
    return { name: "SETTINGS_ENCRYPTION_KEY", value: undefined };
}

/** Validate a required critical secret without exposing its value. */
export function getCriticalSecretFailure(
    value: string | undefined,
    publishedDefault: string,
): CriticalSecretFailure | null {
    if (!value) return "missing";
    if (value === publishedDefault) return "published-default";
    if (value.length < CRITICAL_SECRET_MIN_LENGTH) return "too-short";
    return null;
}

/**
 * Integration secret env keys excluded from fallback and env-file sync when
 * the opt-in DB-only secrets policy is enabled.
 */
export const DB_ONLY_SECRET_ENV_KEYS = [
    "LASTFM_API_KEY",
    "FANART_API_KEY",
    "LIDARR_API_KEY",
    "OPENAI_API_KEY",
    "DEEZER_API_KEY",
    "AUDIOBOOKSHELF_API_KEY",
] as const;

/**
 * Reads the opt-in SECRETS_DB_ONLY flag at call time. The default is false so
 * plug-and-play deployments retain integration-secret env fallback behavior.
 */
export function isSecretsDbOnlyEnabled(): boolean {
    return isEnvFlagEnabled(process.env.SECRETS_DB_ONLY);
}
