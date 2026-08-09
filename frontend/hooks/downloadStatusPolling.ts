/**
 * Resolves the next download-status polling delay from the current job counts.
 */
export function resolveDownloadPollDelayMs(
    activeCount: number,
    totalCount: number
): number {
    if (activeCount > 0) {
        return 5_000;
    }

    return totalCount > 0 ? 10_000 : 30_000;
}

/**
 * Resolves exponential download-status retry backoff capped at two minutes.
 */
export function resolveDownloadErrorBackoffMs(
    baseIntervalMs: number,
    errorCount: number
): number {
    return Math.min(baseIntervalMs * 2 ** errorCount, 120_000);
}
