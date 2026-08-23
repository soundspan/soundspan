import { logger } from "./logger";

type TimeoutLogger = Pick<typeof logger, "warn">;

/** Runs an operation until its deadline and returns undefined on timeout. */
export async function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    operationName: string,
    timeoutLogger: TimeoutLogger = logger,
): Promise<T | undefined> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => {
            timeoutLogger.warn(
                `Operation timed out after ${timeoutMs}ms: ${operationName}`,
            );
            resolve(undefined);
        }, timeoutMs);
    });

    try {
        return await Promise.race([operation(), timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}
