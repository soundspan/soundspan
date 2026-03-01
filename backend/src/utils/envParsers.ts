/**
 * Parses a base-10 integer from an env var, using `fallback` when the value is empty.
 */
export function parseEnvInt(value: string | undefined, fallback: number): number {
    const source =
        typeof value === "string" && value.length > 0
            ? value
            : String(fallback);
    return Number.parseInt(source, 10);
}

export function isEnvFlagEnabled(value: string | undefined): boolean {
    return value === "true";
}

export function parseEnvCsv(value: string | undefined): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    return value.split(",").map((entry) => entry.trim());
}
