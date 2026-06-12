/**
 * Pure poll-policy logic for YouTube download jobs.
 *
 * The useYouTubeUrl hook polls GET /api/youtube/download/:jobId every ~2s;
 * this helper decides — from a job status snapshot — whether polling should
 * stop, which toast to surface, and what progress to display. Kept free of
 * React/api imports so it is unit-testable with the node:test harness.
 */

/** Lifecycle states reported by the backend download job proxy. */
export type YouTubeDownloadJobState =
    | "queued"
    | "downloading"
    | "processing"
    | "completed"
    | "failed";

/** Decision derived from a single download job status poll. */
export interface YouTubeDownloadPollResult {
    /** True when the job reached a terminal state and polling should stop. */
    done: boolean;
    /** Toast to surface when the poll terminates, if any. */
    toast: "success" | "error" | null;
    /** Progress percentage (0-100) to display, or null when unknown. */
    progressPct: number | null;
}

function clampProgress(value: number | null | undefined): number | null {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return null;
    }
    return Math.min(100, Math.max(0, value));
}

/**
 * Map a download job status snapshot to a polling decision.
 * Unknown states are treated as still in progress so a sidecar that adds
 * states later does not strand the UI with a spurious error.
 */
export function resolveYouTubeDownloadPoll(job: {
    status: YouTubeDownloadJobState;
    progressPct?: number | null;
}): YouTubeDownloadPollResult {
    switch (job.status) {
        case "completed":
            return { done: true, toast: "success", progressPct: 100 };
        case "failed":
            return { done: true, toast: "error", progressPct: null };
        case "queued":
            return {
                done: false,
                toast: null,
                progressPct: clampProgress(job.progressPct) ?? 0,
            };
        case "downloading":
        case "processing":
            return {
                done: false,
                toast: null,
                progressPct: clampProgress(job.progressPct),
            };
        default:
            return { done: false, toast: null, progressPct: null };
    }
}
