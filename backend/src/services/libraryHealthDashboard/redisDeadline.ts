const LIBRARY_HEALTH_REDIS_OPERATION_TIMEOUT_MS = 1_500;

/** Bounds one Library Health Redis operation so optional state cannot stall work. */
export async function withLibraryHealthRedisDeadline<T>(
    operation: Promise<T>,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error("Library Health Redis operation timed out")),
            LIBRARY_HEALTH_REDIS_OPERATION_TIMEOUT_MS,
        );
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
