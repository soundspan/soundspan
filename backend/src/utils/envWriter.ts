import fs from "fs";
import { logger } from "./logger";
import path from "path";

const STALE_ENV_SYNC_KEYS = [
    "SOULSEEK_USERNAME",
    "SOULSEEK_PASSWORD",
    "SLSKD_SOULSEEK_USERNAME",
    "SLSKD_SOULSEEK_PASSWORD",
    "MULLVAD_PRIVATE_KEY",
    "MULLVAD_ADDRESSES",
    "MULLVAD_SERVER_CITY",
] as const;

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
    if (envPath === rootEnvPath && process.env.ENABLE_ENV_FILE_SYNC !== "true") {
        return "resolved .env path is filesystem root; refusing implicit write";
    }

    return null;
}

/**
 * Writes key-value pairs to .env file
 * Preserves existing variables not in the provided map
 */
export async function writeEnvFile(
    variables: Record<string, string | null | undefined>
): Promise<void> {
    const envPath = resolveEnvPath();
    const skipReason = shouldSkipEnvSync(envPath);
    if (skipReason) {
        logger.debug(`[ENV] Skipping .env sync: ${skipReason}`);
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
        logger.debug("No existing .env file, creating new one");
    }

    // Remove env keys that are no longer consumed at runtime.
    STALE_ENV_SYNC_KEYS.forEach((key) => {
        existingVars.delete(key);
    });

    // Update with new values
    Object.entries(variables).forEach(([key, value]) => {
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

    // Write to file
    fs.writeFileSync(envPath, lines.join("\n"), "utf-8");
    logger.debug(`.env file updated with ${existingVars.size} variables`);
}
