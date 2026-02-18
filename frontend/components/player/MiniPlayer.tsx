"use client";

import { useAudio } from "@/lib/audio-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import {
    useStreamBitrate,
    formatLocalQualityBadge,
    formatYtQualityBadge,
} from "@/hooks/useStreamBitrate";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import Image from "next/image";
import { motion } from "framer-motion";
import {
    Play,
    Pause,
    Music as MusicIcon,
    Loader2,
    RefreshCw,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { clampTime } from "@/utils/formatTime";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { SyncBadge } from "@/components/player/SyncBadge";

export function MiniPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        isBuffering,
        currentTime,
        duration: playbackDuration,
        audioError,
        clearAudioError,
        pause,
        resume,
        setPlayerMode,
    } = useAudio();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const { title, subtitle, coverUrl, hasMedia } = useMediaInfo(100);
    const {
        bitrate: streamBitrate,
        codec: streamCodec,
        tidalQuality,
        localQuality,
    } = useStreamBitrate();
    const ytQualityLabel = formatYtQualityBadge(streamCodec, streamBitrate);
    const localQualityLabel = formatLocalQualityBadge(localQuality);
    const currentMediaId = currentTrack?.id || currentAudiobook?.id || currentPodcast?.id || "default";
    const artworkLayoutId = `mobile-player-artwork-${currentMediaId}`;

    // Calculate progress percentage
    const duration = (() => {
        if (playbackType === "podcast" && currentPodcast?.duration) {
            return currentPodcast.duration;
        }
        if (playbackType === "audiobook" && currentAudiobook?.duration) {
            return currentAudiobook.duration;
        }
        return (
            playbackDuration ||
            currentTrack?.duration ||
            currentAudiobook?.duration ||
            currentPodcast?.duration ||
            0
        );
    })();

    // CRITICAL: Clamp currentTime to prevent invalid progress display
    const clampedCurrentTime = clampTime(currentTime, duration);

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (clampedCurrentTime / duration) * 100))
            : 0;

    if (!isMobileOrTablet || !hasMedia) {
        return null;
    }

    return (
        <div
            className="fixed inset-x-0 z-50"
            style={{
                bottom: "calc(56px + env(safe-area-inset-bottom, 0px))",
            }}
        >
            <div className="overflow-hidden border-t border-white/10 bg-black/95 backdrop-blur-sm">
                <div className="relative h-[2px] w-full bg-white/10">
                    <div
                        className="h-full bg-[#60a5fa] transition-all duration-150"
                        style={{ width: `${progress}%` }}
                    />
                </div>

                <div
                    className="flex items-center gap-3 px-3 py-2.5"
                    onClick={() => setPlayerMode("overlay")}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setPlayerMode("overlay");
                        }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label="Open full player"
                >
                    <motion.div
                        layoutId={artworkLayoutId}
                        transition={{ type: "spring", stiffness: 320, damping: 34 }}
                        className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-black/30"
                    >
                        {coverUrl ? (
                            <Image
                                src={coverUrl}
                                alt={title}
                                fill
                                sizes="48px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center">
                                <MusicIcon className="h-5 w-5 text-gray-400" />
                            </div>
                        )}
                    </motion.div>

                    <div className="min-w-0 flex-1">
                        {audioError ? (
                            <>
                                <p className="truncate text-sm font-medium text-red-300">
                                    Playback Error
                                </p>
                                <p className="truncate text-xs text-red-200/70">
                                    Tap retry to reconnect
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="truncate text-sm font-medium text-white">
                                    {title}
                                </p>
                                <div className="mt-0.5 flex items-center gap-1.5">
                                    <p className="truncate text-xs text-gray-300/80">
                                        {subtitle}
                                    </p>
                                    {currentTrack?.streamSource === "tidal" && (
                                        <TidalBadge
                                            quality={tidalQuality}
                                            className="max-w-[45vw] flex-shrink-0 text-[9px] px-1 leading-none"
                                        />
                                    )}
                                    {currentTrack?.streamSource === "youtube" && (
                                        <span
                                            className="max-w-[45vw] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-red-500/20 px-1 py-0.5 text-[9px] font-bold leading-none text-red-400"
                                            title={ytQualityLabel}
                                        >
                                            {ytQualityLabel}
                                        </span>
                                    )}
                                    {!currentTrack?.streamSource && localQuality && (
                                        <span
                                            className="max-w-[45vw] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-bold leading-none text-emerald-400"
                                            title={localQualityLabel || undefined}
                                        >
                                            {localQualityLabel}
                                        </span>
                                    )}
                                    <SyncBadge compact />
                                </div>
                            </>
                        )}
                    </div>

                    <div
                        className="flex flex-shrink-0 items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                        role="group"
                        aria-label="Playback controls"
                    >
                        <button
                            onClick={() => {
                                if (audioError) {
                                    clearAudioError();
                                    resume();
                                } else if (!isBuffering) {
                                    if (isPlaying) {
                                        pause();
                                    } else {
                                        resume();
                                    }
                                }
                            }}
                            className={cn(
                                "h-10 w-10 rounded-full transition shadow-md flex items-center justify-center",
                                audioError
                                    ? "bg-red-500 text-white hover:bg-red-400"
                                    : isBuffering
                                      ? "bg-white/80 text-black"
                                      : "bg-white text-black hover:scale-105"
                            )}
                            aria-label={
                                audioError
                                    ? "Retry playback"
                                    : isBuffering
                                      ? "Buffering..."
                                      : isPlaying
                                        ? "Pause"
                                        : "Play"
                            }
                            title={
                                audioError
                                    ? "Retry playback"
                                    : isBuffering
                                      ? "Buffering..."
                                      : isPlaying
                                        ? "Pause"
                                        : "Play"
                            }
                        >
                            {audioError ? (
                                <RefreshCw className="h-5 w-5" />
                            ) : isBuffering ? (
                                <Loader2 className="h-5 w-5 animate-spin" />
                            ) : isPlaying ? (
                                <Pause className="h-5 w-5" />
                            ) : (
                                <Play className="ml-0.5 h-5 w-5" />
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
