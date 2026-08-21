/** Stable error returned by Listen Together domain operations. */
export class GroupError extends Error {
    constructor(
        public readonly code:
            | "NOT_FOUND"
            | "NOT_MEMBER"
            | "NOT_ALLOWED"
            | "INVALID"
            | "CONFLICT"
            | "UNAVAILABLE",
        message: string,
        public readonly retryable: boolean = code === "CONFLICT" ||
            code === "UNAVAILABLE",
    ) {
        super(message);
        this.name = "GroupError";
    }
}

/**
 * Resolve the client-safe message for a failed group operation: GroupError
 * messages are stable domain strings; anything else gets the fallback.
 */
export function groupErrorMessage(failure: unknown, fallback: string): string {
    return failure instanceof GroupError ? failure.message : fallback;
}
