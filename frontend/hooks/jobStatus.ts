/**
 * Resolves a human-readable failure message from a job's result payload.
 * The `result.error` field is untyped server data (`unknown`); only a
 * non-empty string is used, otherwise a stable fallback is returned.
 */
export function resolveJobFailureMessage(
    result: Record<string, unknown> | undefined,
): string {
    const error = result?.error;
    return typeof error === "string" && error.length > 0
        ? error
        : "Job failed with unknown error";
}
