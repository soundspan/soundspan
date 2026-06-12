import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { extractYouTubeVideoId } from "@/lib/youtube-url";
import { resolveYouTubeDownloadPoll } from "@/lib/youtube-download-poll";
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
        const videoId = extractYouTubeVideoId(query);
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
                pollTimerRef.current = setInterval(async () => {
                    try {
                        const status = await api.getYouTubeDownloadStatus(
                            job.jobId
                        );
                        const poll = resolveYouTubeDownloadPoll(status);

                        if (poll.progressPct !== null) {
                            setDownloadProgress(poll.progressPct);
                        }
                        if (!poll.done) return;

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
                        sharedFrontendLogger.error(
                            "YouTube download status poll failed:",
                            pollError
                        );
                        finishWithError("Lost track of the download");
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
