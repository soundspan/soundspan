export interface LyricsCachePolicyInput {
    syncedLyrics: string | null;
    plainLyrics: string | null;
    source: string;
}

export const LYRICS_QUERY_STALE_TIME = 1000 * 60 * 60 * 24 * 7; // 7 days
export const LYRICS_EMPTY_RESULT_STALE_TIME = 15_000; // 15 seconds
export const LYRICS_QUERY_GC_TIME = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Keep verified lyrics aggressively cached, but refresh "none" responses quickly.
 * This avoids long-lived false negatives when upstream lookup paths are transiently slow.
 */
export function resolveLyricsQueryStaleTime(
    data?: LyricsCachePolicyInput
): number {
    if (data?.source === "none" && !data.syncedLyrics && !data.plainLyrics) {
        return LYRICS_EMPTY_RESULT_STALE_TIME;
    }
    return LYRICS_QUERY_STALE_TIME;
}
