import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import {
    resolveAdaptivePollingInterval,
    resolvePollingEnabled,
} from "@/hooks/pollingCadence";
import type {
    YouTubeDownloadJob,
    YouTubeDownloadJobState,
} from "@/lib/youtube-bulk-download";

const logger = createFrontendLogger("hooks.useActiveYouTubeDownloads");

/** Non-terminal states — these are the jobs the downloads view surfaces. */
const ACTIVE_STATES: readonly YouTubeDownloadJobState[] = [
    "queued",
    "downloading",
    "processing",
];

const YT_DOWNLOADS_POLL_ACTIVE_MS = 2_000;
const YT_DOWNLOADS_POLL_IDLE_MS = 20_000;

export const YT_ACTIVE_DOWNLOADS_QUERY_KEY = ["yt-active-downloads"] as const;

/** Whether a job is still doing work (worth showing in the active view). */
export function isActiveYouTubeJob(job: YouTubeDownloadJob): boolean {
    return ACTIVE_STATES.includes(job.status);
}

export interface UseActiveYouTubeDownloadsReturn {
    /** Active (queued/downloading/processing) jobs only, newest first. */
    jobs: YouTubeDownloadJob[];
    activeCount: number;
    isLoading: boolean;
    refetch: () => Promise<unknown>;
    cancel: (jobId: string) => void;
    cancelAll: () => void;
}

/**
 * Poll the YouTube bulk-download job list for the activity panel. Adaptive
 * cadence: fast while downloads are active, slow when idle. Cancelling routes
 * to the dedicated YouTube cancel endpoint and refreshes the list.
 */
export function useActiveYouTubeDownloads(
    options: { enabled?: boolean } = {}
): UseActiveYouTubeDownloadsReturn {
    const enabled = resolvePollingEnabled(options.enabled);
    const queryClient = useQueryClient();

    const fetchJobs = useCallback(() => api.getYouTubeDownloads(), []);

    const {
        data: allJobs = [],
        isLoading,
        refetch,
    } = useQuery<YouTubeDownloadJob[]>({
        queryKey: YT_ACTIVE_DOWNLOADS_QUERY_KEY,
        queryFn: fetchJobs,
        enabled,
        staleTime: 1_500,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: (query) => {
            const data = query.state.data;
            const hasActive = (data ?? []).some(isActiveYouTubeJob);
            return resolveAdaptivePollingInterval({
                enabled,
                hasActiveItems: hasActive,
                activeIntervalMs: YT_DOWNLOADS_POLL_ACTIVE_MS,
                idleIntervalMs: YT_DOWNLOADS_POLL_IDLE_MS,
            });
        },
    });

    const jobs = allJobs.filter(isActiveYouTubeJob);

    const cancelMutation = useMutation({
        mutationFn: (jobId: string) => api.cancelYouTubeDownload(jobId),
        onError: (error, jobId) =>
            logger.error("Failed to cancel YouTube download", {
                jobId,
                error,
            }),
        onSettled: () =>
            queryClient.invalidateQueries({
                queryKey: YT_ACTIVE_DOWNLOADS_QUERY_KEY,
            }),
    });

    const cancel = useCallback(
        (jobId: string) => cancelMutation.mutate(jobId),
        [cancelMutation]
    );
    const cancelAll = useCallback(() => {
        jobs.forEach((job) => cancelMutation.mutate(job.jobId));
    }, [jobs, cancelMutation]);

    return {
        jobs,
        activeCount: jobs.length,
        isLoading,
        refetch,
        cancel,
        cancelAll,
    };
}
