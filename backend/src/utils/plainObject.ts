/** Return whether a value is a non-null object that is not an array. */
export function isPlainObject(
    value: unknown,
): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a plain object value or an empty record for every other input. */
export function asPlainObject(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {};
}
