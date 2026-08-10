import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import { logger } from "./logger";
import path from "path";
import {
    DB_ONLY_SECRET_ENV_KEYS,
    isSecretsDbOnlyEnabled,
} from "../config/secretsPolicy";

const log = logger.child("EnvWriter");

const STALE_ENV_SYNC_KEYS = [
    "SOULSEEK_USERNAME",
    "SOULSEEK_PASSWORD",
    "SLSKD_SOULSEEK_USERNAME",
    "SLSKD_SOULSEEK_PASSWORD",
    "MULLVAD_PRIVATE_KEY",
    "MULLVAD_ADDRESSES",
    "MULLVAD_SERVER_CITY",
] as const;

/**
 * Represents the EnvFileSyncSkippedError class.
 */
export class EnvFileSyncSkippedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EnvFileSyncSkippedError";
    }
}

function resolveEnvPath(): string {
    const explicitPath = process.env.ENV_FILE_PATH?.trim();
    if (explicitPath) {
        return explicitPath;
    }
    // Historical behavior for host-run backend from /backend -> repo root .env
    return path.resolve(process.cwd(), "..", ".env");
}

function shouldSkipEnvSync(envPath: string): string | null {
    if (process.env.ENABLE_ENV_FILE_SYNC === "false") {
        return "disabled by ENABLE_ENV_FILE_SYNC=false";
    }

    // In Kubernetes, settings are typically managed via Secrets/ConfigMaps,
    // and writing local .env files is both unnecessary and often disallowed.
    if (
        process.env.KUBERNETES_SERVICE_HOST &&
        process.env.ENABLE_ENV_FILE_SYNC !== "true"
    ) {
        return "running in Kubernetes without explicit ENABLE_ENV_FILE_SYNC=true";
    }

    const rootEnvPath = `${path.parse(envPath).root}.env`;
    if (
        envPath === rootEnvPath &&
        process.env.ENABLE_ENV_FILE_SYNC !== "true"
    ) {
        return "resolved .env path is filesystem root; refusing implicit write";
    }

    return null;
}

function atomicWriteFileSecret(targetPath: string, content: string): void {
    assert.strictEqual(
        typeof targetPath,
        "string",
        "targetPath must be a string",
    );
    assert.ok(targetPath.trim().length > 0, "targetPath must not be empty");

    const tempPath = `${targetPath}.tmp-${process.pid}-${crypto
        .randomBytes(6)
        .toString("hex")}`;

    try {
        fs.writeFileSync(tempPath, content, {
            encoding: "utf-8",
            mode: 0o600,
        });
        fs.chmodSync(tempPath, 0o600);
        fs.renameSync(tempPath, targetPath);
    } catch (error) {
        try {
            fs.unlinkSync(tempPath);
        } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
                log.debug(
                    "Failed to clean up temporary .env file",
                    cleanupError,
                );
            }
        }
        throw error;
    }
}

/**
 * Writes key-value pairs to .env file
 * Preserves existing variables not in the provided map
 */
export async function writeEnvFile(
    variables: Record<string, string | null | undefined>,
): Promise<void> {
    const envPath = resolveEnvPath();
    const secretsDbOnly = isSecretsDbOnlyEnabled();
    const skipReason = shouldSkipEnvSync(envPath);
    if (skipReason) {
        log.debug(`Skipping .env sync: ${skipReason}`);
        throw new EnvFileSyncSkippedError(skipReason);
    }

    // Read existing .env
    let existingContent = "";
    const existingVars = new Map<string, string>();

    try {
        existingContent = fs.readFileSync(envPath, "utf-8");

        // Parse existing variables
        existingContent.split("\n").forEach((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
                const [key, ...valueParts] = trimmed.split("=");
                if (key) {
                    existingVars.set(key.trim(), valueParts.join("="));
                }
            }
        });
    } catch (error) {
        log.debug("No existing .env file, creating new one");
    }

    // Remove env keys that are no longer consumed at runtime.
    STALE_ENV_SYNC_KEYS.forEach((key) => {
        existingVars.delete(key);
    });

    if (secretsDbOnly) {
        DB_ONLY_SECRET_ENV_KEYS.forEach((key) => {
            existingVars.delete(key);
        });
    }

    // Update with new values
    Object.entries(variables).forEach(([key, value]) => {
        if (
            secretsDbOnly &&
            DB_ONLY_SECRET_ENV_KEYS.includes(
                key as (typeof DB_ONLY_SECRET_ENV_KEYS)[number],
            )
        ) {
            return;
        }
        if (value !== null && value !== undefined) {
            existingVars.set(key, value);
        }
    });

    // Build new .env content
    const lines: string[] = [
        "# soundspan Environment Variables",
        `# Auto-generated on ${new Date().toISOString()}`,
        "",
    ];

    // Group variables by category
    const categories = {
        "Database & Redis": ["DATABASE_URL", "REDIS_URL"],
        Server: ["PORT", "NODE_ENV", "SESSION_SECRET", "ALLOWED_ORIGINS"],
        Lidarr: ["LIDARR_ENABLED", "LIDARR_URL", "LIDARR_API_KEY"],
        "Last.fm": ["LASTFM_API_KEY"],
        "Fanart.tv": ["FANART_API_KEY"],
        OpenAI: ["OPENAI_API_KEY"],
        Audiobookshelf: ["AUDIOBOOKSHELF_URL", "AUDIOBOOKSHELF_API_KEY"],
        "Docker Paths": ["MUSIC_PATH", "DOWNLOAD_PATH"],
        Security: ["SETTINGS_ENCRYPTION_KEY"],
    };

    const writtenKeys = new Set<string>();

    // Write categorized variables
    Object.entries(categories).forEach(([category, keys]) => {
        const categoryVars: string[] = [];

        keys.forEach((key) => {
            if (existingVars.has(key)) {
                const value = existingVars.get(key);
                categoryVars.push(`${key}=${value}`);
                writtenKeys.add(key);
            }
        });

        if (categoryVars.length > 0) {
            lines.push("", `# ${category}`, ...categoryVars);
        }
    });

    // Write uncategorized variables
    const uncategorized: string[] = [];
    existingVars.forEach((value, key) => {
        if (!writtenKeys.has(key)) {
            uncategorized.push(`${key}=${value}`);
        }
    });

    if (uncategorized.length > 0) {
        lines.push("", "# Other Variables", ...uncategorized);
    }

    lines.push(""); // Trailing newline

    atomicWriteFileSecret(envPath, lines.join("\n"));
    log.debug(`.env file updated with ${existingVars.size} variables`);
}
