import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { extractYouTubeVideoId } from "@/lib/youtube-url";
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
}

interface UseYouTubeUrlReturn {
    videoInfo: YtVideoInfo | null;
    isLoading: boolean;
    isDownloading: boolean;
    handlePlay: () => void;
    handleDownload: (format: string, quality: string) => Promise<void>;
}

export function useYouTubeUrl({
    query,
}: UseYouTubeUrlProps): UseYouTubeUrlReturn {
    const [videoInfo, setVideoInfo] = useState<YtVideoInfo | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const { playTracks } = useAudioControls();

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
                const info = await api.getYouTubeVideoInfo(query);
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
        };

        playTracks([track], 0);
    }, [videoInfo, playTracks]);

    const handleDownload = useCallback(
        async (format: string, quality: string) => {
            if (!videoInfo) return;

            setIsDownloading(true);
            try {
                const result = await api.downloadYouTube(
                    videoInfo.videoId,
                    format,
                    quality
                );

                if (result.alreadyExisted) {
                    toast.info("Already in your library", {
                        description: videoInfo.title,
                    });
                } else {
                    toast.success("Download complete", {
                        description: `${videoInfo.title} saved as ${format.toUpperCase()}`,
                    });
                }

                // Open activity panel like Soulseek does
                if (typeof window !== "undefined") {
                    window.dispatchEvent(
                        new CustomEvent("set-activity-panel-tab", {
                            detail: { tab: "active" },
                        })
                    );
                    window.dispatchEvent(
                        new CustomEvent("open-activity-panel")
                    );
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                }
            } catch (error) {
                sharedFrontendLogger.error("YouTube download error:", error);
                const message =
                    error instanceof Error
                        ? error.message
                        : "Failed to download";
                toast.error(message);
            } finally {
                setIsDownloading(false);
            }
        },
        [videoInfo]
    );

    return {
        videoInfo,
        isLoading,
        isDownloading,
        handlePlay,
        handleDownload,
    };
}
