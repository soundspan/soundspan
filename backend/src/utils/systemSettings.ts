import { prisma } from "./db";
import { logger } from "./logger";
import { encrypt, decrypt, encryptField } from "./encryption";
import { isSecretsDbOnlyEnabled } from "../config/secretsPolicy";

const CACHE_TTL_MS = 60 * 1000;

let cachedSettings: any | null = null;
let cacheExpiry = 0;
let cacheGeneration = 0;

// Re-export encryptField for backwards compatibility
export { encryptField };

/**
 * Executes invalidateSystemSettingsCache.
 */
export function invalidateSystemSettingsCache() {
    cacheGeneration += 1;
    cachedSettings = null;
    cacheExpiry = 0;
}

/**
 * Safely decrypt a field, returning null if decryption fails
 * This prevents one corrupted encrypted field from breaking all settings
 */
// Track logged warnings to prevent spam
const loggedDecryptionWarnings = new Set<string>();

function safeDecrypt(value: string | null, fieldName?: string): string | null {
    if (!value) return null;
    try {
        return decrypt(value);
    } catch (error) {
        const key = fieldName || "field";
        if (!loggedDecryptionWarnings.has(key)) {
            logger.warn(
                `[Settings] Failed to decrypt ${key}, returning null (suppressing further warnings for this field)`,
            );
            loggedDecryptionWarnings.add(key);
        }
        return null;
    }
}

/**
 * Executes getSystemSettings.
 */
export async function getSystemSettings(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedSettings && cacheExpiry > now) {
        return { ...cachedSettings };
    }
    const loadGeneration = cacheGeneration;

    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
    });

    if (!settings) {
        if (loadGeneration === cacheGeneration) {
            cachedSettings = null;
            cacheExpiry = 0;
        }
        return null;
    }

    // Decrypt sensitive fields - use safeDecrypt to handle corrupted fields gracefully
    const decrypted = {
        ...settings,
        lidarrApiKey: safeDecrypt(settings.lidarrApiKey, "lidarrApiKey"),
        lidarrWebhookSecret: safeDecrypt(
            settings.lidarrWebhookSecret,
            "lidarrWebhookSecret",
        ),
        openaiApiKey: safeDecrypt(settings.openaiApiKey, "openaiApiKey"),
        lastfmApiKey: safeDecrypt(settings.lastfmApiKey, "lastfmApiKey"),
        fanartApiKey: safeDecrypt(settings.fanartApiKey, "fanartApiKey"),
        audiobookshelfApiKey: safeDecrypt(
            settings.audiobookshelfApiKey,
            "audiobookshelfApiKey",
        ),
        soulseekPassword: safeDecrypt(
            settings.soulseekPassword,
            "soulseekPassword",
        ),
        ytMusicClientSecret: safeDecrypt(
            settings.ytMusicClientSecret,
            "ytMusicClientSecret",
        ),
    };

    if (loadGeneration === cacheGeneration) {
        cachedSettings = decrypted;
        cacheExpiry = now + CACHE_TTL_MS;
    }
    return { ...decrypted };
}

/** Under SECRETS_DB_ONLY, verifies the settings layer is readable before services start. */
export async function assertSecretsDbOnlyReady(): Promise<void> {
    if (!isSecretsDbOnlyEnabled()) {
        return;
    }

    try {
        await getSystemSettings(true);
    } catch {
        logger.error("SECRETS_DB_ONLY readiness check failed");
        throw new Error(
            "SECRETS_DB_ONLY=true but system settings are not readable; the database/settings layer must be initialized before services start",
        );
    }
}
