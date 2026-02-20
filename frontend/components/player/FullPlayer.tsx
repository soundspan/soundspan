"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import {
    useStreamBitrate,
    formatLocalQualityBadge,
    formatYtQualityBadge,
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
} from "lucide-react";
import { useMemo } from "react";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { cn } from "@/utils/cn";
import { formatTime, clampTime, formatTimeRemaining } from "@/utils/formatTime";
import { SeekSlider } from "./SeekSlider";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { SyncBadge } from "@/components/player/SyncBadge";
import { TrackPreferenceButtons } from "./TrackPreferenceButtons";

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
        seek,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
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
        bitrate: streamBitrate,
        codec: streamCodec,
        tidalQuality,
        localQuality,
    } = useStreamBitrate();
    const ytQualityLabel = formatYtQualityBadge(streamCodec, streamBitrate);
    const localQualityLabel = formatLocalQualityBadge(localQuality);

    // Determine if seeking is allowed
    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value) / 100;
        setVolume(newVolume);
    };

    return (
        <div className="relative flex-shrink-0">
            <div className="bg-black border-t border-white/[0.08] h-24">
                {/* Subtle top glow */}
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                <div className="flex items-center h-full px-6 gap-4">
                    {/* Artwork & Info */}
                    <div className="flex items-center gap-3 w-80">
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                prefetch={false}
                                className="relative w-14 h-14 flex-shrink-0 group"
                            >
                                <div className="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent rounded-full blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-full overflow-hidden shadow-lg flex items-center justify-center">
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
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-full overflow-hidden shadow-lg flex items-center justify-center">
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
                            {/* Quality & status badges */}
                            <div className="flex items-center gap-1.5 flex-wrap mt-1">
                            {/* TIDAL streaming indicator */}
                            {currentTrack?.streamSource === "tidal" && (
                                <TidalBadge quality={tidalQuality} className="inline-flex items-center" />
                            )}
                            {/* YouTube Music stream quality badge */}
                            {currentTrack?.streamSource === "youtube" && (
                                <span
                                    className="inline-flex max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400"
                                    title={ytQualityLabel}
                                >
                                    {ytQualityLabel}
                                </span>
                            )}
                            {/* Local track quality badge */}
                            {!currentTrack?.streamSource && localQuality && (
                                <span
                                    className="inline-flex max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400"
                                    title={localQualityLabel || undefined}
                                >
                                    {localQualityLabel}
                                </span>
                            )}
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
                        <TrackPreferenceButtons
                            trackId={preferenceTrackId}
                            buttonSizeClassName="h-11 w-11"
                            iconSizeClassName="h-6 w-6"
                        />
                    </div>

                    {/* Controls */}
                    <div className="flex-1 min-w-0 flex flex-col items-center gap-2 px-2">
                        {/* Buttons */}
                        <div className="flex items-center gap-5" role="group" aria-label="Playback controls">
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
                                <Shuffle className="w-4 h-4" />
                            </button>

                            <button
                                onClick={previous}
                                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Previous track"
                                title="Previous track"
                            >
                                <SkipBack className="w-5 h-5" />
                            </button>

                            <button
                                onClick={handlePlayPauseClick}
                                className={cn(
                                    "w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 relative group",
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
                                    <RefreshCw className="w-5 h-5 relative z-10" />
                                ) : isBuffering ? (
                                    <Loader2 className="w-5 h-5 animate-spin relative z-10" />
                                ) : isPlaying ? (
                                    <Pause className="w-5 h-5 relative z-10" />
                                ) : (
                                    <Play className="w-5 h-5 ml-0.5 relative z-10" />
                                )}
                            </button>

                            <button
                                onClick={next}
                                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Next track"
                                title="Next track"
                            >
                                <SkipForward className="w-5 h-5" />
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
                                    <Repeat1 className="w-4 h-4" />
                                ) : (
                                    <Repeat className="w-4 h-4" />
                                )}
                            </button>

                        </div>

                        {/* Progress Bar */}
                        <div className="w-full flex items-center gap-3">
                            <span
                                className={cn(
                                    "text-xs text-right font-medium tabular-nums",
                                    hasMedia
                                        ? "text-gray-400"
                                        : "text-gray-600",
                                    duration >= 3600 ? "w-12" : "w-9"
                                )}
                            >
                                {formatTime(displayTime)}
                            </span>
                            <SeekSlider
                                progress={progress}
                                duration={duration}
                                currentTime={displayTime}
                                onSeek={handleSeek}
                                canSeek={canSeek}
                                hasMedia={hasMedia}
                                downloadProgress={downloadProgress}
                                variant="default"
                                className="flex-1"
                            />
                            <span
                                className={cn(
                                    "text-xs font-medium tabular-nums",
                                    hasMedia
                                        ? "text-gray-400"
                                        : "text-gray-600",
                                    duration >= 3600 ? "w-12" : "w-9"
                                )}
                            >
                                {playbackType === "podcast" ||
                                playbackType === "audiobook"
                                    ? formatTimeRemaining(
                                          Math.max(0, duration - displayTime)
                                      )
                                    : formatTime(duration)}
                            </span>
                        </div>
                    </div>

                    {/* Right Controls */}
                    <div className="flex w-80 items-center justify-end gap-3">
                        <div className="flex w-48 items-center gap-2.5">
                            <button
                                onClick={toggleMute}
                                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110"
                                aria-label={volume === 0 ? "Unmute" : "Mute"}
                            >
                                {isMuted || volume === 0 ? (
                                    <VolumeX className="w-5 h-5" />
                                ) : (
                                    <Volume2 className="w-5 h-5" />
                                )}
                            </button>

                            <div className="relative flex-1">
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
                                    className="w-full h-1 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-white/30 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                                />
                            </div>
                        </div>

                        {/* Keyboard Shortcuts Info */}
                        <KeyboardShortcutsTooltip />

                        <button
                            onClick={() => setPlayerMode("overlay")}
                            className={cn(
                                "transition-all duration-200 border-l border-white/[0.08] pl-2",
                                hasMedia
                                    ? "text-gray-400 hover:text-white hover:scale-110"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            disabled={!hasMedia}
                            aria-label="Open overlay player"
                            title="Open overlay player"
                        >
                            <ChevronUp className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
