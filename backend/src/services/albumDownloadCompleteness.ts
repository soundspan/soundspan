/** Possible outcomes when comparing delivered and expected album track counts. */
export type DownloadCompleteness = "complete" | "partial" | "unknown";

/** Classify a nonzero provider result against a MusicBrainz track count. */
export function classifyDownloadCompleteness(
    downloaded: number | null,
    expected: number | null,
): DownloadCompleteness {
    if (downloaded === null || expected === null) return "unknown";
    if (!Number.isSafeInteger(downloaded) || !Number.isSafeInteger(expected)) {
        return "unknown";
    }
    if (downloaded <= 0 || expected <= 0) return "unknown";
    return downloaded < expected ? "partial" : "complete";
}
