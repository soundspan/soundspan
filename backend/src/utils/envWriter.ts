import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import { logger } from "./logger";
import path from "path";
import {
    DB_ONLY_SECRET_ENV_KEYS,
    isSecretsDbOnlyEnabled,
} from "../config/secretsPolicy";
import { isPlainObject } from "./plainObject";

const log = logger.child("EnvWriter");
const ENV_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const STALE_ENV_SYNC_KEYS = [
    "SOULSEEK_USERNAME",
    "SOULSEEK_PASSWORD",
    "SLSKD_SOULSEEK_USERNAME",
    "SLSKD_SOULSEEK_PASSWORD",
    "MULLVAD_PRIVATE_KEY",
    "MULLVAD_ADDRESSES",
    "MULLVAD_SERVER_CITY",
] as const;

const ENV_CATEGORIES = {
    "Database & Redis": ["DATABASE_URL", "REDIS_URL"],
    Server: ["PORT", "NODE_ENV", "SESSION_SECRET", "ALLOWED_ORIGINS"],
    Lidarr: ["LIDARR_ENABLED", "LIDARR_URL", "LIDARR_API_KEY"],
    "Last.fm": ["LASTFM_API_KEY", "LASTFM_SHARED_SECRET"],
    "Fanart.tv": ["FANART_API_KEY"],
    OpenAI: ["OPENAI_API_KEY"],
    Audiobookshelf: ["AUDIOBOOKSHELF_URL", "AUDIOBOOKSHELF_API_KEY"],
    "Docker Paths": ["MUSIC_PATH", "DOWNLOAD_PATH"],
    Security: ["SETTINGS_ENCRYPTION_KEY"],
} as const;

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

function assertSafeEnvVariables(
    variables: Record<string, string | null | undefined>,
): void {
    assert.ok(
        isPlainObject(variables),
        "variables must be an environment variable record",
    );
    Object.entries(variables).forEach(([key, value]) => {
        assert.ok(
            ENV_VARIABLE_NAME_PATTERN.test(key),
            "Invalid environment variable name",
        );
        if (typeof value === "string" && /[\r\n]/.test(value)) {
            throw new Error(
                `Refusing to write .env: value for ${key} contains a line break`,
            );
        }
    });
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

function readExistingEnvVariables(envPath: string): Map<string, string> {
    const existingVars = new Map<string, string>();
    let existingContent: string;

    try {
        existingContent = fs.readFileSync(envPath, "utf-8");
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error;
        }
        log.debug("No existing .env file, creating new one");
        return existingVars;
    }

    existingContent.split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
            const [key, ...valueParts] = trimmed.split("=");
            if (key) {
                existingVars.set(key.trim(), valueParts.join("="));
            }
        }
    });
    return existingVars;
}

function reconcileEnvVariables(
    existingVars: Map<string, string>,
    variables: Record<string, string | null | undefined>,
    secretsDbOnly: boolean,
): void {
    STALE_ENV_SYNC_KEYS.forEach((key) => existingVars.delete(key));
    if (secretsDbOnly) {
        DB_ONLY_SECRET_ENV_KEYS.forEach((key) => existingVars.delete(key));
    }

    Object.entries(variables).forEach(([key, value]) => {
        const isDbOnlySecret = DB_ONLY_SECRET_ENV_KEYS.includes(
            key as (typeof DB_ONLY_SECRET_ENV_KEYS)[number],
        );
        if (secretsDbOnly && isDbOnlySecret) {
            return;
        }
        if (value === null) {
            existingVars.delete(key);
        } else if (value !== undefined) {
            existingVars.set(key, value);
        }
    });
}

function appendCategorizedVariables(
    lines: string[],
    existingVars: Map<string, string>,
    writtenKeys: Set<string>,
): void {
    Object.entries(ENV_CATEGORIES).forEach(([category, keys]) => {
        const categoryVars: string[] = [];
        keys.forEach((key) => {
            if (existingVars.has(key)) {
                categoryVars.push(`${key}=${existingVars.get(key)}`);
                writtenKeys.add(key);
            }
        });
        if (categoryVars.length > 0) {
            lines.push("", `# ${category}`, ...categoryVars);
        }
    });
}

function appendUncategorizedVariables(
    lines: string[],
    existingVars: Map<string, string>,
    writtenKeys: Set<string>,
): void {
    const uncategorized: string[] = [];
    existingVars.forEach((value, key) => {
        if (!writtenKeys.has(key)) {
            uncategorized.push(`${key}=${value}`);
        }
    });
    if (uncategorized.length > 0) {
        lines.push("", "# Other Variables", ...uncategorized);
    }
}

function buildEnvContent(existingVars: Map<string, string>): string {
    const lines = [
        "# soundspan Environment Variables",
        `# Auto-generated on ${new Date().toISOString()}`,
        "",
    ];
    const writtenKeys = new Set<string>();

    appendCategorizedVariables(lines, existingVars, writtenKeys);
    appendUncategorizedVariables(lines, existingVars, writtenKeys);
    lines.push("");
    return lines.join("\n");
}

/**
 * Writes key-value pairs to the configured `.env` file atomically.
 * `null` deletes a key, `undefined` leaves it unchanged, and omitted keys are preserved.
 * Read failures other than a missing file are rethrown before any replacement is attempted.
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

    assertSafeEnvVariables(variables);
    const existingVars = readExistingEnvVariables(envPath);
    reconcileEnvVariables(existingVars, variables, secretsDbOnly);
    atomicWriteFileSecret(envPath, buildEnvContent(existingVars));
    log.debug(`.env file updated with ${existingVars.size} variables`);
}
