import { isEnvFlagEnabled } from "../utils/envParsers";

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
