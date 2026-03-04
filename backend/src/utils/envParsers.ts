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
