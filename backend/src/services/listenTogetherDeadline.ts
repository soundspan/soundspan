/** Error raised when bounded Listen Together dependency work exceeds its budget. */
export class ListenTogetherDeadlineError extends Error {
    constructor(operationName: string, timeoutMs: number) {
        super(`${operationName} exceeded ${timeoutMs}ms deadline`);
        this.name = "ListenTogetherDeadlineError";
    }
}

/** Return whether an error represents the local Listen Together deadline. */
export function isListenTogetherDeadlineError(
    error: unknown,
): error is ListenTogetherDeadlineError {
    return error instanceof ListenTogetherDeadlineError;
}

/** Apply bounded exponential backoff with positive jitter. */
export function listenTogetherRetryDelayMs(
    attempt: number,
    baseDelayMs: number,
    maximumDelayMs: number,
    random: () => number = Math.random,
): number {
    const boundedAttempt = Math.max(1, Math.min(16, Math.trunc(attempt)));
    const exponential = Math.min(
        maximumDelayMs,
        baseDelayMs * 2 ** (boundedAttempt - 1),
    );
    const jitter = Math.floor(exponential * 0.35 * random());
    return Math.min(maximumDelayMs, exponential + jitter);
}

/** Wait for a bounded retry delay without keeping the process alive. */
export async function waitForListenTogetherRetry(
    delayMs: number,
): Promise<void> {
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, delayMs));
        timer.unref?.();
    });
}

/** Await one operation for no longer than the supplied deadline. */
export async function withListenTogetherDeadline<T>(
    operation: Promise<T>,
    operationName: string,
    timeoutMs: number,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new ListenTogetherDeadlineError(operationName, timeoutMs));
        }, timeoutMs);
        if (typeof timer.unref === "function") {
            timer.unref();
        }
    });

    try {
        return await Promise.race([operation, deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
