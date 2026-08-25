import { logger } from "./logger";

type TimeoutLogger = Pick<typeof logger, "warn">;
const MIN_POST_ABORT_SETTLE_MS = 30_000;

/** Explicit outcome returned by cancellation-aware timeout callers. */
export type TimeoutResult<T> =
    | { ok: true; value: T }
    | { ok: false; timedOut: true };

/** Options selecting the cancellation-aware discriminated timeout contract. */
export interface TimeoutResultOptions {
    result: true;
    logger?: TimeoutLogger;
}

async function waitForAbortedSettlement<T>(
    operationPromise: Promise<T>,
    settleTimeoutMs: number,
    operationName: string,
    timeoutLogger: TimeoutLogger,
): Promise<void> {
    const settled = Symbol("settled");
    const settleTimedOut = Symbol("settle-timed-out");
    let settleTimeoutId: NodeJS.Timeout | undefined;
    const observedOperation = operationPromise.then(
        () => settled,
        () => settled,
    );
    const settleTimeout = new Promise<typeof settleTimedOut>((resolve) => {
        settleTimeoutId = setTimeout(
            () => resolve(settleTimedOut),
            settleTimeoutMs,
        );
    });
    try {
        const outcome = await Promise.race([observedOperation, settleTimeout]);
        if (outcome === settleTimedOut) {
            timeoutLogger.warn(
                `Aborted operation did not settle within ${settleTimeoutMs}ms: ${operationName}`,
            );
        }
    } finally {
        if (settleTimeoutId) clearTimeout(settleTimeoutId);
    }
}

export function withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    operationName: string,
    options: TimeoutResultOptions,
): Promise<TimeoutResult<T>>;

export function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    operationName: string,
    timeoutLogger?: TimeoutLogger,
): Promise<T | undefined>;

/** Runs an operation until its deadline and aborts timed-out owned work. */
export async function withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    operationName: string,
    loggerOrOptions: TimeoutLogger | TimeoutResultOptions = logger,
): Promise<T | undefined | TimeoutResult<T>> {
    const options = "result" in loggerOrOptions ? loggerOrOptions : undefined;
    const timeoutLogger: TimeoutLogger =
        options?.logger ??
        ("warn" in loggerOrOptions ? loggerOrOptions : logger);
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;
    const timedOut = Symbol("timed-out");
    const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
        timeoutId = setTimeout(() => {
            timeoutLogger.warn(
                `Operation timed out after ${timeoutMs}ms: ${operationName}`,
            );
            controller.abort(new Error(`${operationName} timed out`));
            resolve(timedOut);
        }, timeoutMs);
    });

    try {
        const operationPromise = Promise.resolve().then(() =>
            operation(controller.signal),
        );
        const outcome = await Promise.race([operationPromise, timeoutPromise]);
        if (outcome !== timedOut) {
            return options ? { ok: true, value: outcome as T } : (outcome as T);
        }
        if (options) {
            await waitForAbortedSettlement(
                operationPromise,
                Math.max(timeoutMs, MIN_POST_ABORT_SETTLE_MS),
                operationName,
                timeoutLogger,
            );
        }
        return options ? { ok: false, timedOut: true } : undefined;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}
