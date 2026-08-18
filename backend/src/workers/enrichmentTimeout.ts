/**
 * Timeout wrapper to prevent operations from hanging indefinitely
 * If an operation takes longer than the timeout, it will fail and move to the next item
 */
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() =>
        clearTimeout(timer),
    );
}

/**
 * Filter tags to only include mood-relevant ones
 */
