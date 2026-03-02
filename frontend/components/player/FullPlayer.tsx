"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import {
    useStreamBitrate,
} from "@/hooks/useStreamBitrate";
import Image from "next/image";
import Link from "next/link";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
    ChevronUp,
    Music as MusicIcon,
    Shuffle,
    Repeat,
    Repeat1,
    Loader2,
    AudioWaveform,
    RefreshCw,
    Radio,
} from "lucide-react";
import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/utils/cn";
import { formatTime, clampTime } from "@/utils/formatTime";
import { SeekSlider } from "./SeekSlider";
import { SyncBadge } from "@/components/player/SyncBadge";
import { TrackPreferenceButtons } from "./TrackPreferenceButtons";
import { PlaybackQualityBadgeWithStats } from "./PlaybackQualityBadgeWithStats";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { useFeatures } from "@/lib/features-context";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { APP_VERSION } from "@/lib/version";

/**
 * FullPlayer - UI-only component for desktop bottom player
 * Does NOT manage audio element - that's handled by AudioElement component
 */
export function FullPlayer() {
    // Use split contexts to avoid re-rendering on every currentTime update
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        vibeMode,
        vibeSourceFeatures,
        queue,
        currentIndex,
        playerMode,
    } = useAudioState();

    const {
        isPlaying,
        isBuffering,
        currentTime,
        duration: playbackDuration,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
    } = useAudioPlayback();

    const {
        pause,
        resume,
        next,
        previous,
        setPlayerMode,
        returnToPreviousMode,
        seek,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
        startVibeMode,
        stopVibeMode,
        setUpcoming,
    } = useAudioControls();
    const preferenceTrackId =
        playbackType === "track" ? currentTrack?.id : undefined;

    // Get current track's audio features for vibe comparison
    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;

    // Calculate vibe match score (simplified version - compares key audio features)
    const vibeMatchScore = useMemo(() => {
        if (!vibeMode || !vibeSourceFeatures || !currentTrackFeatures) return null;

        // Compare key features: energy, valence, danceability, arousal
        const features = ['energy', 'valence', 'danceability', 'arousal'] as const;
        const scores: number[] = [];

        for (const key of features) {
            const sourceVal = vibeSourceFeatures[key as keyof typeof vibeSourceFeatures];
            const currentVal = currentTrackFeatures[key as keyof typeof currentTrackFeatures];

            if (typeof sourceVal === 'number' && typeof currentVal === 'number') {
                const diff = Math.abs(sourceVal - currentVal);
                scores.push(1 - diff);
            }
        }

        if (scores.length === 0) return null;
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        return Math.round(avgScore * 100);
    }, [vibeMode, vibeSourceFeatures, currentTrackFeatures]);

    const duration = (() => {
        // Prefer canonical durations for long-form media to avoid stale/misreported playbackDuration.
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



    // For audiobooks/podcasts, show saved progress even before playback starts
    // This provides immediate visual feedback of where the user left off
    const displayTime = (() => {
        let time = currentTime;

        // If we're actively playing or have seeked, use the live currentTime
        if (time <= 0) {
            // Otherwise, show saved progress for audiobooks/podcasts
            if (
                playbackType === "audiobook" &&
                currentAudiobook?.progress?.currentTime
            ) {
                time = currentAudiobook.progress.currentTime;
            } else if (
                playbackType === "podcast" &&
                currentPodcast?.progress?.currentTime
            ) {
                time = currentPodcast.progress.currentTime;
            }
        }

        // CRITICAL: Clamp to duration to prevent display of invalid times
        return clampTime(time, duration);
    })();

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (displayTime / duration) * 100))
            : 0;

    const handleSeek = (time: number) => {
        seek(time);
    };

    const handlePlayPauseClick = () => {
        if (audioError) {
            clearAudioError();
            resume();
            return;
        }

        if (isBuffering) return;
        if (isPlaying) {
            pause();
            return;
        }
        resume();
    };

    const { title, subtitle, coverUrl, artistLink, mediaLink, hasMedia } = useMediaInfo(100);
    const {
        qualityBadge,
    } = useStreamBitrate();

    const { vibeEmbeddings, showVersion, loading: featuresLoading } = useFeatures();
    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const [isRadioLoading, setIsRadioLoading] = useState(false);

    const handleVibeToggle = async () => {
        if (!currentTrack?.id) return;
        if (vibeMode) {
            stopVibeMode();
            toast.success("Vibe mode off");
            return;
        }
        setIsVibeLoading(true);
        try {
            const result = await startVibeMode();
            if (result.success && result.trackCount > 0) {
                toast.success("Vibe mode on", {
                    description: `${result.trackCount} similar tracks queued`,
                    icon: <AudioWaveform className="w-4 h-4 text-[#60a5fa]" />,
                });
            } else {
                toast.error("Couldn't find matching tracks");
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to start vibe match:", error);
            toast.error("Failed to match vibe");
        } finally {
            setIsVibeLoading(false);
        }
    };

    const handleStartRadio = async () => {
        if (!currentTrack?.artist?.id) return;
        setIsRadioLoading(true);
        try {
            const response = await api.getRadioTracks("artist", currentTrack.artist.id);
            if (response.tracks && response.tracks.length > 0) {
                const filtered = response.tracks.filter(
                    (t: { id: string }) => t.id !== currentTrack.id
                );
                setUpcoming(filtered);
                toast.success(
                    `Playing ${currentTrack.artist.name} Radio (${filtered.length} tracks)`
                );
            } else {
                toast.error("Not enough similar music in your library for artist radio");
            }
        } catch {
            toast.error("Failed to start artist radio");
        } finally {
            setIsRadioLoading(false);
        }
    };

    // Determine if seeking is allowed
    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value) / 100;
        setVolume(newVolume);
    };

    // Volume popup state
    const [showVolumePopup, setShowVolumePopup] = useState(false);
    const volumePopupRef = useRef<HTMLDivElement>(null);
    const volumeHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleVolumeMouseEnter = useCallback(() => {
        if (volumeHoverTimeoutRef.current) {
            clearTimeout(volumeHoverTimeoutRef.current);
            volumeHoverTimeoutRef.current = null;
        }
        setShowVolumePopup(true);
    }, []);

    const handleVolumeMouseLeave = useCallback(() => {
        volumeHoverTimeoutRef.current = setTimeout(() => {
            setShowVolumePopup(false);
        }, 300);
    }, []);

    // Click on open space toggles overlay player on/off
    const handleBarClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        // Only trigger on the bar container divs themselves, not any child interactive elements
        if (target.closest("button, a, input, span, p, h4, img, svg, [role='slider'], [data-seek-zone]")) return;
        if (!hasMedia) return;
        if (playerMode === "overlay") {
            returnToPreviousMode();
        } else {
            setPlayerMode("overlay");
        }
    }, [hasMedia, playerMode, setPlayerMode, returnToPreviousMode]);

    // Close volume popup on outside click
    useEffect(() => {
        if (!showVolumePopup) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (volumePopupRef.current && !volumePopupRef.current.contains(e.target as Node)) {
                setShowVolumePopup(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [showVolumePopup]);

    return (
        <div className="relative flex-shrink-0">
            <div className="relative bg-black border-t border-white/[0.08] h-24">
                {/* Desktop-wide progress tracker — z above overlay (z-[9999]) so handle isn't covered.
                    pb-5 creates a generous invisible hit zone below the 4px track so the seekbar
                    is easy to grab; the hit zone also blocks handleBarClick from toggling overlay. */}
                <div className="absolute inset-x-0 top-0 z-[10000]" data-seek-zone>
                    <SeekSlider
                        progress={progress}
                        duration={duration}
                        currentTime={displayTime}
                        onSeek={handleSeek}
                        canSeek={canSeek}
                        hasMedia={hasMedia}
                        downloadProgress={downloadProgress}
                        variant="default"
                        alwaysShowHandle
                        handleClassName="w-2.5 h-2.5 shadow-xl shadow-black/50"
                        className="h-1 rounded-none"
                        hitZoneClassName="pb-5"
                    />
                </div>
                {/* Subtle top glow */}
                <div className="absolute top-1 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent pointer-events-none" />
                <div
                    className={cn("grid grid-cols-[1fr_auto_1fr] items-center h-full px-6 pt-1", hasMedia && "cursor-pointer")}
                    onClick={handleBarClick}
                >
                    {/* Artwork & Info — left-aligned, expands rightward */}
                    <div className="flex items-center gap-3 min-w-0 mr-4">
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                prefetch={false}
                                className="relative w-14 h-14 flex-shrink-0 group"
                            >
                                <div className="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent rounded-lg blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-lg overflow-hidden shadow-lg flex items-center justify-center">
                                    {coverUrl ? (
                                        <Image
                                            key={coverUrl}
                                            src={coverUrl}
                                            alt={title}
                                            fill
                                            sizes="56px"
                                            className="object-cover"
                                            priority
                                            unoptimized
                                        />
                                    ) : (
                                        <MusicIcon className="w-6 h-6 text-gray-500" />
                                    )}
                                </div>
                            </Link>
                        ) : (
                            <div className="relative w-14 h-14 flex-shrink-0">
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-lg overflow-hidden shadow-lg flex items-center justify-center">
                                    <MusicIcon className="w-6 h-6 text-gray-500" />
                                </div>
                            </div>
                        )}
                        <div className="flex-1 min-w-0">
                            {mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    prefetch={false}
                                    className="block hover:underline"
                                >
                                    <h4 className="text-white font-semibold truncate text-sm">
                                        {title}
                                    </h4>
                                </Link>
                            ) : (
                                <h4 className="text-white font-semibold truncate text-sm">
                                    {title}
                                </h4>
                            )}
                            {artistLink ? (
                                <Link
                                    href={artistLink}
                                    prefetch={false}
                                    className="block hover:underline"
                                >
                                    <p className="text-xs text-gray-400 truncate">
                                        {subtitle}
                                    </p>
                                </Link>
                            ) : mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    prefetch={false}
                                    className="block hover:underline"
                                >
                                    <p className="text-xs text-gray-400 truncate">
                                        {subtitle}
                                    </p>
                                </Link>
                            ) : (
                                <p className="text-xs text-gray-400 truncate">
                                    {subtitle}
                                </p>
                            )}
                            {/* Status badges */}
                            <div className="flex items-center gap-1.5 flex-wrap mt-1">
                            {/* Vibe match score when in vibe mode */}
                            {vibeMode && vibeMatchScore !== null && (
                                <span
                                    className={cn(
                                        "inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded",
                                        vibeMatchScore >= 80
                                            ? "bg-green-500/20 text-green-400"
                                            : vibeMatchScore >= 60
                                            ? "bg-brand/20 text-brand"
                                            : "bg-orange-500/20 text-orange-400"
                                    )}
                                >
                                    <AudioWaveform className="w-2.5 h-2.5" />
                                    {vibeMatchScore}% match
                                </span>
                            )}
                            {/* Listen Together sync indicator */}
                            <SyncBadge />
                            </div>
                        </div>
                    </div>

                    {/* Controls — truly centered column */}
                    <div className="flex items-center justify-center gap-4">
                        {/* Buttons */}
                        <div className="flex items-center gap-6" role="group" aria-label="Playback controls">
                            {/* Shuffle */}
                            <button
                                onClick={toggleShuffle}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    isShuffle
                                        ? "text-green-500 hover:text-green-400"
                                        : "text-gray-400 hover:text-white"
                                )}
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Shuffle"
                                aria-pressed={isShuffle}
                                title="Shuffle"
                            >
                                <Shuffle className="w-[18px] h-[18px]" />
                            </button>

                            <button
                                onClick={previous}
                                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Previous track"
                                title="Previous track"
                            >
                                <SkipBack className="w-6 h-6" />
                            </button>

                            <button
                                onClick={handlePlayPauseClick}
                                className={cn(
                                    "w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 relative group",
                                    audioError
                                        ? "bg-red-500 text-white hover:scale-110 hover:bg-red-400"
                                        : hasMedia && !isBuffering
                                        ? "bg-white text-black hover:scale-110 shadow-lg shadow-white/20 hover:shadow-white/30"
                                        : isBuffering
                                        ? "bg-white/80 text-black"
                                        : "bg-gray-700 text-gray-500 cursor-not-allowed"
                                )}
                                disabled={!hasMedia || isBuffering}
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
                                {hasMedia && !isBuffering && !audioError && (
                                    <div className="absolute inset-0 rounded-full bg-white blur-md opacity-0 group-hover:opacity-50 transition-opacity duration-200" />
                                )}
                                {audioError ? (
                                    <RefreshCw className="w-6 h-6 relative z-10" />
                                ) : isBuffering ? (
                                    <Loader2 className="w-6 h-6 animate-spin relative z-10" />
                                ) : isPlaying ? (
                                    <Pause className="w-6 h-6 relative z-10" />
                                ) : (
                                    <Play className="w-6 h-6 ml-0.5 relative z-10" />
                                )}
                            </button>

                            <button
                                onClick={next}
                                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Next track"
                                title="Next track"
                            >
                                <SkipForward className="w-6 h-6" />
                            </button>

                            {/* Repeat */}
                            <button
                                onClick={toggleRepeat}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    repeatMode !== "off"
                                        ? "text-green-500 hover:text-green-400"
                                        : "text-gray-400 hover:text-white"
                                )}
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label={
                                    repeatMode === "off"
                                        ? "Repeat off"
                                        : repeatMode === "all"
                                        ? "Repeat all"
                                        : "Repeat one"
                                }
                                aria-pressed={repeatMode !== "off"}
                                title={
                                    repeatMode === "off"
                                        ? "Repeat: Off"
                                        : repeatMode === "all"
                                        ? "Repeat: All (loop queue)"
                                        : "Repeat: One (play current track twice)"
                                }
                            >
                                {repeatMode === "one" ? (
                                    <Repeat1 className="w-[18px] h-[18px]" />
                                ) : (
                                    <Repeat className="w-[18px] h-[18px]" />
                                )}
                            </button>

                        </div>
                    </div>

                    {/* Right Controls — right-aligned */}
                    <div className="flex items-center justify-end ml-4 gap-4">
                        {/* Quality badge — centered in space between controls and time */}
                        <div className="flex-1 flex justify-center">
                            {qualityBadge && (
                                <PlaybackQualityBadgeWithStats
                                    badge={qualityBadge}
                                    size="full"
                                />
                            )}
                        </div>

                        {/* Timer */}
                        <span
                            className={cn(
                                "text-sm font-medium tabular-nums whitespace-nowrap",
                                hasMedia ? "text-gray-300" : "text-gray-600"
                            )}
                        >
                            {formatTime(displayTime)}{" / "}
                            {formatTime(duration)}
                        </span>

                        {/* Icon group: radio, vibe, heart, 3-dot, volume, chevron — equally spaced, vertically centered */}
                        <div className="flex items-center gap-2.5">
                            {/* Radio */}
                            {currentTrack?.artist?.id && playbackType === "track" && (
                                <button
                                    onClick={handleStartRadio}
                                    disabled={isRadioLoading}
                                    className="flex items-center justify-center w-8 h-8 text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                    title="Start artist radio"
                                    aria-label="Start Radio"
                                >
                                    {isRadioLoading ? (
                                        <Loader2 className="w-[18px] h-[18px] animate-spin" />
                                    ) : (
                                        <Radio className="w-[18px] h-[18px]" />
                                    )}
                                </button>
                            )}

                            {/* Vibe */}
                            {!featuresLoading && vibeEmbeddings && (
                                <button
                                    onClick={handleVibeToggle}
                                    disabled={isVibeLoading}
                                    className={cn(
                                        "flex items-center justify-center w-8 h-8 transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                        vibeMode
                                            ? "text-[#60a5fa] hover:text-[#60a5fa]"
                                            : "text-gray-400 hover:text-white"
                                    )}
                                    title={vibeMode ? "Turn off vibe mode" : "Match this vibe"}
                                    aria-label="Match Vibe"
                                >
                                    {isVibeLoading ? (
                                        <Loader2 className="w-[18px] h-[18px] animate-spin" />
                                    ) : (
                                        <AudioWaveform className="w-[18px] h-[18px]" />
                                    )}
                                </button>
                            )}

                            {/* Heart */}
                            <TrackPreferenceButtons
                                trackId={preferenceTrackId}
                                buttonSizeClassName="h-8 w-8"
                                iconSizeClassName="h-[18px] w-[18px]"
                            />

                            {/* 3-dot context menu for current track */}
                            {currentTrack && playbackType === "track" && (
                                <TrackOverflowMenu
                                    track={currentTrack}
                                    showPlayNext={false}
                                    triggerClassName="!opacity-100 text-gray-400 hover:text-white"
                                    menuClassName="bottom-full top-auto mb-1 mt-0 z-[10001]"
                                />
                            )}

                            {/* Volume icon + vertical popup */}
                            <div
                                ref={volumePopupRef}
                                className="relative z-[10000] flex items-center justify-center"
                                onMouseEnter={handleVolumeMouseEnter}
                                onMouseLeave={handleVolumeMouseLeave}
                            >
                                <button
                                    onClick={toggleMute}
                                    className="flex items-center justify-center w-8 h-8 text-gray-400 hover:text-white transition-all duration-200 hover:scale-110"
                                    aria-label={volume === 0 ? "Unmute" : "Mute"}
                                >
                                    {isMuted || volume === 0 ? (
                                        <VolumeX className="w-[18px] h-[18px]" />
                                    ) : (
                                        <Volume2 className="w-[18px] h-[18px]" />
                                    )}
                                </button>

                                {/* Vertical volume slider popup */}
                                <div
                                    className={cn(
                                        "absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-4 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl transition-all duration-200",
                                        showVolumePopup ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"
                                    )}
                                >
                                    <div className="flex flex-col items-center gap-2 h-28">
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            value={volume * 100}
                                            onChange={handleVolumeChange}
                                            aria-label="Volume"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={Math.round(volume * 100)}
                                            aria-valuetext={`${Math.round(volume * 100)} percent`}
                                            style={{
                                                background: `linear-gradient(to right, #fff ${volume * 100}%, rgba(255,255,255,0.15) ${volume * 100}%)`
                                            }}
                                            className="w-1 h-full rounded-full appearance-none cursor-pointer origin-center -rotate-0 [writing-mode:vertical-lr] [direction:rtl] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-white/30"
                                        />
                                        <span className="text-[10px] text-gray-400 tabular-nums">
                                            {Math.round(volume * 100)}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <button
                                onClick={() => setPlayerMode("overlay")}
                                className={cn(
                                    "flex items-center justify-center w-8 h-8 transition-all duration-200",
                                    hasMedia
                                        ? "text-gray-400 hover:text-white hover:scale-110"
                                        : "text-gray-600 cursor-not-allowed"
                                )}
                                disabled={!hasMedia}
                                aria-label="Open overlay player"
                                title="Open overlay player"
                            >
                                <ChevronUp className="w-[18px] h-[18px]" />
                            </button>
                        </div>
                    </div>
                </div>
                {/* Version badge — absolutely positioned bottom-right, doesn't affect layout */}
                {showVersion && (
                    <span className="absolute bottom-1 right-2 text-[9px] text-white/20 pointer-events-none select-none">
                        {APP_VERSION}
                    </span>
                )}
            </div>
        </div>
    );
}
