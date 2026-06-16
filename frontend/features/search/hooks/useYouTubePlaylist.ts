import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { classifyYouTubeUrl } from "@/lib/youtube-url";
import {
    resolveYouTubeDownloadPoll,
    MAX_CONSECUTIVE_POLL_FAILURES,
} from "@/lib/youtube-download-poll";
import {
    BULK_DOWNLOAD_CONCURRENCY,
    mapLimit,
    summarizeBulkProgress,
    type BulkDownloadProgress,
    type BulkItemStatus,
    type YouTubePlaylistInfo,
} from "@/lib/youtube-bulk-download";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface UseYouTubePlaylistProps {
    query: string;
}

interface UseYouTubePlaylistReturn {
    playlistInfo: YouTubePlaylistInfo | null;
    isLoading: boolean;
    /** Non-null when enumeration failed (private/unavailable/network). */
    error: string | null;
    isDownloading: boolean;
    progress: BulkDownloadProgress | null;
    handleDownloadAll: (format: string, quality: string) => Promise<void>;
    handleCancel: () => void;
}

/** Interval between per-item download job status polls. */
const DOWNLOAD_POLL_INTERVAL_MS = 2000;
/**
 * Per-item poll budget (~30 min at 2s). A job still running past this keeps
 * downloading and importing server-side via the backend watcher; we just stop
 * tying up a fan-out slot waiting on it.
 */
const MAX_ITEM_POLLS = 900;

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start one /api/youtube/download job and poll it to a terminal state.
 * Returns "completed" or "failed" for aggregate accounting; never throws.
 * Tolerates transient poll failures and gives up (as "failed") past the poll
 * budget — the backend's server-side watcher still imports the file.
 */
async function downloadOneToTerminal(
    videoId: string,
    format: string,
    quality: string,
    source: string | undefined,
    sourceKind: "playlist" | "channel",
    isCancelled: () => boolean
): Promise<BulkItemStatus> {
    try {
        const job = await api.downloadYouTube(
            videoId,
            format,
            quality,
            source,
            sourceKind
        );
        if (job.status === "completed") {
            return "completed";
        }

        let failures = 0;
        for (let polls = 0; polls < MAX_ITEM_POLLS; polls++) {
            if (isCancelled()) return "failed";
            await sleep(DOWNLOAD_POLL_INTERVAL_MS);
            try {
                const status = await api.getYouTubeDownloadStatus(job.jobId);
                failures = 0;
                const poll = resolveYouTubeDownloadPoll(status);
                if (poll.done) {
                    return poll.toast === "success" ? "completed" : "failed";
                }
            } catch (pollError) {
                failures += 1;
                if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                    sharedFrontendLogger.error(
                        "Bulk item poll abandoned:",
                        pollError
                    );
                    return "failed";
                }
            }
        }
        return "failed";
    } catch (error) {
        sharedFrontendLogger.error("Bulk item download failed:", error);
        return "failed";
    }
}

/**
 * Companion to useYouTubeUrl for playlist/channel URLs. Enumerates the source
 * via /api/youtube/playlist-info, then fans out the existing per-video
 * download+poll flow with bounded concurrency, exposing aggregate progress.
 */
export function useYouTubePlaylist({
    query,
}: UseYouTubePlaylistProps): UseYouTubePlaylistReturn {
    const [playlistInfo, setPlaylistInfo] =
        useState<YouTubePlaylistInfo | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDownloading, setIsDownloading] = useState(false);
    const [progress, setProgress] = useState<BulkDownloadProgress | null>(null);
    const cancelRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            // Stop an in-flight bulk run and silence late state updates.
            mountedRef.current = false;
            cancelRef.current = true;
        };
    }, []);

    // Enumerate when the query is a playlist/channel URL.
    useEffect(() => {
        const { kind } = classifyYouTubeUrl(query);
        if (kind !== "playlist" && kind !== "channel") {
            setPlaylistInfo(null);
            setError(null);
            return;
        }

        const abortController = new AbortController();

        const fetchInfo = async () => {
            setIsLoading(true);
            setError(null);
            try {
                const info = await api.getYouTubePlaylistInfo(
                    query,
                    abortController.signal
                );
                if (!abortController.signal.aborted) {
                    setPlaylistInfo(info);
                }
            } catch (err: unknown) {
                if (!abortController.signal.aborted) {
                    sharedFrontendLogger.error(
                        "Failed to fetch YouTube playlist info:",
                        err
                    );
                    setPlaylistInfo(null);
                    const e = err as { data?: { error?: string }; message?: string };
                    setError(
                        e?.data?.error ||
                            e?.message ||
                            "Couldn't load this playlist or channel"
                    );
                }
            } finally {
                if (!abortController.signal.aborted) {
                    setIsLoading(false);
                }
            }
        };

        // Small debounce to avoid fetching on every keystroke.
        const timer = setTimeout(fetchInfo, 300);

        return () => {
            clearTimeout(timer);
            abortController.abort();
        };
    }, [query]);

    const handleCancel = useCallback(() => {
        cancelRef.current = true;
    }, []);

    const handleDownloadAll = useCallback(
        async (format: string, quality: string) => {
            const info = playlistInfo;
            if (!info || info.entries.length === 0 || isDownloading) {
                return;
            }

            cancelRef.current = false;
            const statuses: BulkItemStatus[] = info.entries.map(
                () => "pending"
            );
            const sync = () => {
                if (mountedRef.current) {
                    setProgress(summarizeBulkProgress(statuses));
                }
            };

            setIsDownloading(true);
            sync();

            await mapLimit(
                info.entries,
                BULK_DOWNLOAD_CONCURRENCY,
                async (entry, index) => {
                    if (cancelRef.current) {
                        statuses[index] = "failed";
                        sync();
                        return;
                    }
                    statuses[index] = "active";
                    sync();
                    statuses[index] = await downloadOneToTerminal(
                        entry.videoId,
                        format,
                        quality,
                        info.title || info.kind,
                        info.kind,
                        () => cancelRef.current
                    );
                    sync();
                }
            );

            if (!mountedRef.current) return;
            setIsDownloading(false);

            const final = summarizeBulkProgress(statuses);
            if (cancelRef.current) {
                toast.info(
                    `Stopped — ${final.completed} of ${final.total} downloaded`,
                    { description: info.title }
                );
            } else if (final.failed === 0) {
                toast.success(
                    `Downloaded ${final.completed} of ${final.total} — scanning library`,
                    { description: info.title }
                );
            } else {
                toast.warning(
                    `${final.completed}/${final.total} downloaded, ${final.failed} unfinished`,
                    {
                        description:
                            "Unfinished items may still complete in the background.",
                    }
                );
            }
        },
        [playlistInfo, isDownloading]
    );

    return {
        playlistInfo,
        isLoading,
        error,
        isDownloading,
        progress,
        handleDownloadAll,
        handleCancel,
    };
}
