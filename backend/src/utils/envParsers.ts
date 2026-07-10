/**
 * Parses a base-10 integer from an env var, using `fallback` when the value is empty.
 */
export function parseEnvInt(value: string | undefined, fallback: number): number {
    if (typeof value !== "string") {
        return fallback;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return fallback;
    }

    if (!/^-?\d+$/.test(trimmed)) {
        return fallback;
    }

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parses a boolean from an env var, using `defaultValue` when the value is
 * absent or unrecognized.
 *
 * Accepts case-insensitive "true"/"false" (surrounding whitespace ignored);
 * undefined, empty, or any other value returns `defaultValue`.
 */
export function parseEnvBool(
    value: string | undefined,
    defaultValue: boolean
): boolean {
    if (typeof value !== "string") {
        return defaultValue;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }

    return defaultValue;
}

/**
 * Executes isEnvFlagEnabled.
 */
export function isEnvFlagEnabled(value: string | undefined): boolean {
    return value === "true";
}

/**
 * Executes parseEnvCsv.
 */
export function parseEnvCsv(value: string | undefined): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    return value.split(",").map((entry) => entry.trim());
}

/**
 * Parses a finite float from an env var, using `fallback` when the value
 * is absent, empty, or not a finite number.
 */
export function parseEnvFloat(
    value: string | undefined,
    fallback: number
): number {
    if (typeof value !== "string") {
        return fallback;
    }

    const trimmed = value.trim();
    if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return fallback;
    }

    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
}
