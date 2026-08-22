/**
 * Pure orchestration helpers for bulk YouTube playlist/channel downloads.
 *
 * The useYouTubePlaylist hook fans out one existing /api/youtube/download job
 * per playlist entry. These helpers — a bounded-concurrency async pool and an
 * aggregate-progress summarizer — are kept free of React/api imports so they
 * are unit-testable with the node:test harness.
 */

/** A single enumerable video within a playlist/channel. */
export interface YouTubePlaylistEntry {
    videoId: string;
    title: string;
    uploader: string;
    duration: number | null;
}

/**
 * Bounded enumeration of a YouTube playlist or channel
 * (GET /api/youtube/playlist-info). `entries` is capped server-side;
 * `truncated` is true when the source holds more videos than were returned.
 */
export interface YouTubePlaylistInfo {
    kind: "playlist" | "channel";
    playlistId: string | null;
    channel: string | null;
    sourceUrl: string;
    title: string;
    uploader: string;
    totalCount: number | null;
    truncated: boolean;
    count: number;
    entries: YouTubePlaylistEntry[];
}

/** Lifecycle states reported by the backend YouTube download job proxy. */
export type YouTubeDownloadJobState =
    | "queued"
    | "downloading"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";

/**
 * A YouTube download job as returned by GET /api/youtube/downloads and the
 * single-job status endpoint. `source` groups a bulk run by playlist/channel.
 */
export interface YouTubeDownloadJob {
    jobId: string;
    videoId: string;
    status: YouTubeDownloadJobState;
    progressPct: number;
    filePath: string | null;
    title: string;
    error: string | null;
    alreadyExisted: boolean;
    source: string | null;
    createdAt: number | null;
}

/**
 * A YouTube job rendered as an activity-panel download row. Structurally a
 * superset-compatible subset of DownloadHistoryItem (the shared list shape),
 * tagged `currentSource: "youtube"` so the tab can color it. `ytSidecarJob`
 * routes cancel to the sidecar endpoint — library DownloadJob rows also carry
 * `currentSource: "youtube"` but cancel through the regular downloads API.
 */
export interface YouTubeDownloadListItem {
    id: string;
    subject: string;
    type: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    metadata: {
        currentSource: "youtube";
        ytSidecarJob: true;
        statusText: string;
        progressPct: number;
        ytSource: string | null;
    };
}

/**
 * Map a YouTube download job into an activity-panel list row. `nowIso` is the
 * fallback timestamp when the job has no createdAt (passed in to keep this
 * pure/testable).
 */
export function youtubeJobToDownloadItem(
    job: YouTubeDownloadJob,
    nowIso: string,
): YouTubeDownloadListItem {
    const pct = Math.max(0, Math.min(100, Math.round(job.progressPct || 0)));
    const createdAt = job.createdAt
        ? new Date(job.createdAt * 1000).toISOString()
        : nowIso;
    return {
        id: job.jobId,
        subject: job.title || job.videoId,
        type: "track",
        status: job.status,
        createdAt,
        updatedAt: createdAt,
        metadata: {
            currentSource: "youtube",
            ytSidecarJob: true,
            statusText: job.source ? `${pct}% · ${job.source}` : `${pct}%`,
            progressPct: pct,
            ytSource: job.source,
        },
    };
}

/**
 * Max simultaneous per-video download jobs the bulk UI starts from one
 * browser. The sidecar independently queues downloads at its own (smaller)
 * concurrency; this bounds how many jobs are started and polled at once so a
 * large playlist does not fire hundreds of requests in a burst.
 */
export const BULK_DOWNLOAD_CONCURRENCY = 3;

/** Per-item lifecycle within a bulk run. */
export type BulkItemStatus = "pending" | "active" | "completed" | "failed";

/** Aggregate snapshot of a bulk download run, by item count. */
export interface BulkDownloadProgress {
    total: number;
    completed: number;
    failed: number;
    active: number;
    pending: number;
    /** Completion percentage (0-100) over terminal (completed+failed) items. */
    pct: number;
    /** True once every item reached a terminal state. */
    done: boolean;
}

/** Summarize per-item statuses into an aggregate progress snapshot. */
export function summarizeBulkProgress(
    statuses: BulkItemStatus[],
): BulkDownloadProgress {
    const total = statuses.length;
    let completed = 0;
    let failed = 0;
    let active = 0;
    let pending = 0;
    for (const status of statuses) {
        if (status === "completed") completed++;
        else if (status === "failed") failed++;
        else if (status === "active") active++;
        else pending++;
    }
    const terminal = completed + failed;
    return {
        total,
        completed,
        failed,
        active,
        pending,
        pct: total === 0 ? 0 : Math.round((terminal / total) * 100),
        done: total > 0 && terminal === total,
    };
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once, resolving
 * when all items have settled. A worker that throws does NOT reject the pool —
 * callers are expected to capture per-item outcomes inside the worker — so one
 * failed download never aborts the rest of the playlist.
 */
export async function mapLimit<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const max = Math.max(1, limit);
    let cursor = 0;

    async function runner(): Promise<void> {
        while (cursor < items.length) {
            const index = cursor++;
            try {
                await worker(items[index], index);
            } catch {
                // Swallow: per-item failures are the worker's responsibility
                // to record; the pool must keep draining the queue.
            }
        }
    }

    const runners = Array.from({ length: Math.min(max, items.length) }, () =>
        runner(),
    );
    await Promise.all(runners);
}
