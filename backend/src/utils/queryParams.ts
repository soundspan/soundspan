/**
 * Parse a request query value as a base-10 integer, clamped to [min, max].
 *
 * @param value - Request query value to parse.
 * @param fallback - Value returned when the input is non-string or parses to a
 * non-finite value.
 * @param min - Inclusive minimum for a finite parsed value.
 * @param max - Inclusive maximum for a finite parsed value.
 * @returns The fallback for invalid input, or the parsed integer clamped to the
 * inclusive bounds.
 */
export function parseBoundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    if (typeof value !== "string") {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}
