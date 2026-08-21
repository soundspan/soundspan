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

/** Await one operation within a shared absolute deadline and caller signal. */
export async function withListenTogetherDeadlineAt<T>(
    operation: Promise<T>,
    operationName: string,
    deadlineAtMs: number,
    signal: AbortSignal,
): Promise<T> {
    // A dependency may not support cancellation. Observe its late outcome
    // before checking the caller lifetime so abandonment cannot leak rejection.
    void operation.catch(() => undefined);
    signal.throwIfAborted();
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        throw new ListenTogetherDeadlineError(operationName, 0);
    }
    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        return await Promise.race([
            withListenTogetherDeadline(operation, operationName, remainingMs),
            aborted,
        ]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}
