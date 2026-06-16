import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { extractYouTubeVideoId, classifyYouTubeUrl } from "@/lib/youtube-url";
import {
    resolveYouTubeDownloadPoll,
    shouldAbandonYouTubeDownloadPolling,
} from "@/lib/youtube-download-poll";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface UseYouTubeUrlProps {
    query: string;
}

export interface YtVideoInfo {
    videoId: string;
    title: string;
    uploader: string;
    duration: number;
    thumbnail: string | null;
    uploadDate: string;
    audioFormat?: "mp4" | "webm";
}

interface UseYouTubeUrlReturn {
    videoInfo: YtVideoInfo | null;
    isLoading: boolean;
    isDownloading: boolean;
    /** Download progress percentage (0-100), or null when unknown/idle. */
    downloadProgress: number | null;
    handlePlay: () => void;
    handleDownload: (format: string, quality: string) => Promise<void>;
}

/** Interval between download job status polls. */
const DOWNLOAD_POLL_INTERVAL_MS = 2000;

export function useYouTubeUrl({
    query,
}: UseYouTubeUrlProps): UseYouTubeUrlReturn {
    const [videoInfo, setVideoInfo] = useState<YtVideoInfo | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState<number | null>(
        null
    );
    const abortRef = useRef<AbortController | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // True once a poll observed a terminal state (or polling was abandoned).
    // Checked again after every await so an overlapping in-flight poll cannot
    // handle the same terminal state twice (double toasts).
    const pollSettledRef = useRef(false);
    // Consecutive failed status polls; isolated failures are tolerated.
    const pollFailuresRef = useRef(0);
    const { playTracks } = useAudioControls();

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    // Stop any in-flight status polling when the component unmounts.
    useEffect(() => stopPolling, [stopPolling]);

    // Fetch video info when query is a YouTube URL
    useEffect(() => {
        // Playlist/channel URLs are handled by useYouTubePlaylist; skip the
        // single-video preview for them. A watch URL opened from inside a
        // real playlist classifies as "playlist" so the bulk card takes over,
        // while an RD* mix falls back to its focused single video here.
        const kind = classifyYouTubeUrl(query).kind;
        const videoId =
            kind === "playlist" || kind === "channel"
                ? null
                : extractYouTubeVideoId(query);
        if (!videoId) {
            setVideoInfo(null);
            return;
        }

        const abortController = new AbortController();
        abortRef.current = abortController;

        const fetchInfo = async () => {
            setIsLoading(true);
            try {
                const info = await api.getYouTubeVideoInfo(
                    query,
                    abortController.signal
                );
                if (!abortController.signal.aborted) {
                    setVideoInfo(info);
                }
            } catch (error) {
                if (!abortController.signal.aborted) {
                    sharedFrontendLogger.error(
                        "Failed to fetch YouTube video info:",
                        error
                    );
                    setVideoInfo(null);
                }
            } finally {
                if (!abortController.signal.aborted) {
                    setIsLoading(false);
                }
            }
        };

        // Small debounce to avoid fetching on every keystroke
        const timer = setTimeout(fetchInfo, 300);

        return () => {
            clearTimeout(timer);
            abortController.abort();
        };
    }, [query]);

    const handlePlay = useCallback(() => {
        if (!videoInfo) return;

        const track: Track = {
            id: `yt-${videoInfo.videoId}`,
            title: videoInfo.title,
            artist: { name: videoInfo.uploader },
            album: {
                title: "YouTube",
                coverArt: videoInfo.thumbnail || undefined,
            },
            duration: videoInfo.duration,
            streamSource: "youtube-direct",
            youtubeVideoId: videoInfo.videoId,
            youtubeAudioFormat: videoInfo.audioFormat,
        };

        playTracks([track], 0);
    }, [videoInfo, playTracks]);

    const handleDownload = useCallback(
        async (format: string, quality: string) => {
            if (!videoInfo) return;

            stopPolling();
            // Settle any in-flight poll from a previous job so it cannot
            // surface toasts for a download we are no longer tracking.
            pollSettledRef.current = true;
            setIsDownloading(true);
            setDownloadProgress(null);
            const { title } = videoInfo;

            const finishWithError = (message: string) => {
                stopPolling();
                setIsDownloading(false);
                setDownloadProgress(null);
                toast.error(message, { description: title });
            };

            try {
                const job = await api.downloadYouTube(
                    videoInfo.videoId,
                    format,
                    quality
                );

                if (job.status === "completed") {
                    // Idempotency hit — the file already exists on disk and
                    // the backend has queued a library scan to make sure it
                    // is imported.
                    setIsDownloading(false);
                    toast.info("Already downloaded — scanning library", {
                        description: title,
                    });
                    return;
                }

                setDownloadProgress(0);
                pollSettledRef.current = false;
                pollFailuresRef.current = 0;
                pollTimerRef.current = setInterval(async () => {
                    if (pollSettledRef.current) return;
                    try {
                        const status = await api.getYouTubeDownloadStatus(
                            job.jobId
                        );
                        if (pollSettledRef.current) return;
                        pollFailuresRef.current = 0;
                        const poll = resolveYouTubeDownloadPoll(status);

                        if (poll.progressPct !== null) {
                            setDownloadProgress(poll.progressPct);
                        }
                        if (!poll.done) return;

                        pollSettledRef.current = true;
                        stopPolling();
                        setIsDownloading(false);
                        setDownloadProgress(null);

                        if (poll.toast === "success") {
                            toast.success("Added to library — scanning", {
                                description: title,
                            });
                        } else {
                            toast.error(status.error || "Download failed", {
                                description: title,
                            });
                        }
                    } catch (pollError) {
                        if (pollSettledRef.current) return;
                        pollFailuresRef.current += 1;
                        sharedFrontendLogger.error(
                            "YouTube download status poll failed:",
                            pollError
                        );
                        // Tolerate transient failures (backend redeploy,
                        // network blip) — the download continues server-side
                        // and the backend job watcher imports it on finish.
                        if (
                            !shouldAbandonYouTubeDownloadPolling(
                                pollFailuresRef.current
                            )
                        ) {
                            return;
                        }
                        pollSettledRef.current = true;
                        stopPolling();
                        setIsDownloading(false);
                        setDownloadProgress(null);
                        toast.info(
                            "Lost download progress — the download continues in the background",
                            { description: title }
                        );
                    }
                }, DOWNLOAD_POLL_INTERVAL_MS);
            } catch (error) {
                sharedFrontendLogger.error("YouTube download error:", error);
                finishWithError(
                    error instanceof Error
                        ? error.message
                        : "Failed to download"
                );
            }
        },
        [videoInfo, stopPolling]
    );

    return {
        videoInfo,
        isLoading,
        isDownloading,
        downloadProgress,
        handlePlay,
        handleDownload,
    };
}
