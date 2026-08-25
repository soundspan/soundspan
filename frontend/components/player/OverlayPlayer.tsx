"use client";

import { useOverlayGestures } from "./hooks/useOverlayGestures";
import { useOverlayPlayerAudio } from "./hooks/useOverlayPlayerAudio";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { resolvePlaybackQualityBadgeFromStreamSource } from "@/hooks/useStreamBitrate";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    RotateCcw,
    RotateCw,
    ChevronDown,
    Music as MusicIcon,
    Shuffle,
    Repeat,
    Repeat1,
    AudioWaveform,
    Radio,
    Loader2,
    RefreshCw,
    Plus,
} from "lucide-react";
import { formatTime, clampTime, formatTimeRemaining } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { toast } from "sonner";
import { SeekSlider } from "./SeekSlider";
import { useFeatures } from "@/lib/features-context";
import { api } from "@/lib/api";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { SyncBadge } from "@/components/player/SyncBadge";
import { useListenTogether } from "@/lib/listen-together-context";
import {
    OVERLAY_ACTIVE_TAB_STORAGE_KEY,
    readMigratingStorageItem,
    writeMigratingStorageItem,
} from "@/lib/storage-migration";
import { TrackPreferenceButtons } from "./TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { OverlayQueueTab } from "./overlay-tabs/OverlayQueueTab";
import { OverlayLyricsTab } from "./overlay-tabs/OverlayLyricsTab";
import { OverlayRelatedTab } from "./overlay-tabs/OverlayRelatedTab";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import type { Track } from "@/lib/audio-state-context";

const OVERLAY_ACTIVE_TAB_KEY = OVERLAY_ACTIVE_TAB_STORAGE_KEY;

function isPlayableTrack(value: unknown): value is Track {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<Track> & {
        artist?: { name?: unknown };
        album?: { title?: unknown };
    };
    return (
        typeof candidate.id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.duration === "number" &&
        Boolean(candidate.artist) &&
        typeof candidate.artist?.name === "string" &&
        Boolean(candidate.album) &&
        typeof candidate.album?.title === "string"
    );
}

/**
 * Renders the OverlayPlayer component.
 */
export function OverlayPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isShuffle,
        repeatMode,
        vibeMode,
        queue,
        currentIndex,
        isPlaying,
        isBuffering,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
        playbackDuration,
        currentTime,
        pause,
        resume,
        next,
        previous,
        returnToPreviousMode,
        seek,
        toggleShuffle,
        toggleRepeat,
        startVibeMode,
        stopVibeMode,
        playTrack,
        playQueueIndex,
        setUpcoming,
        removeFromQueue,
        clearQueue,
        skipForward,
        skipBackward,
    } = useOverlayPlayerAudio();

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const shouldReduceMotion = useReducedMotion();
    const { isInGroup, isHost, syncSetTrack } = useListenTogether();

    // Swipe state for track skipping
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const [isRadioLoading, setIsRadioLoading] = useState(false);
    const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<"queue" | "lyrics" | "related">(
        "queue",
    );
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const { title, subtitle, coverUrl, artistLink, mediaLink } =
        useMediaInfo(768);
    const currentTrackQualityBadge = useMemo(
        () =>
            resolvePlaybackQualityBadgeFromStreamSource(
                currentTrack?.streamSource,
            ),
        [currentTrack?.streamSource],
    );
    // Skip is queue-based: the unified queue can mix tracks and episodes.
    const canSkip = queue.length > 0;
    const {
        swipeOffset,
        overlayDragOffset,
        isOverlayDragActive,
        overlayHeaderHandlers,
        drawerDragOffset,
        isDrawerDragActive,
        drawerHandleHandlers,
        resetDrawerDrag,
        trackSwipeHandlers,
    } = useOverlayGestures({
        canSkip,
        onPrevious: previous,
        onNext: next,
        onCloseOverlay: returnToPreviousMode,
        onCloseDrawer: () => setIsDrawerOpen(false),
    });
    const isTrackMode = playbackType === "track";
    const preferenceTrackId = isTrackMode ? currentTrack?.id : undefined;
    const isDesktopOverlayLayout = canSkip && !isMobileOrTablet;
    // The lyrics tab mounts only while shown, so it owns its own fetch.
    const lyricsLookupTrack = useMemo(
        () =>
            playbackType === "track" && currentTrack?.id
                ? {
                      id: currentTrack.id,
                      artist: currentTrack.artist?.name,
                      title: currentTrack.displayTitle || currentTrack.title,
                      album: currentTrack.album?.title,
                      duration: currentTrack.duration,
                  }
                : null,
        [currentTrack, playbackType],
    );

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
    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    const displayTime = (() => {
        let time = currentTime;

        if (time <= 0) {
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
    const currentMediaId =
        currentTrack?.id ||
        currentAudiobook?.id ||
        currentPodcast?.id ||
        "default";
    const artworkLayoutId = `mobile-player-artwork-${currentMediaId}`;
    const queueTracks = queue;

    const tabPanelHeightClass = "min-h-0 flex-1";

    const handlePlayPause = useCallback(() => {
        if (audioError) {
            clearAudioError();
            resume();
            return;
        }
        if (isBuffering) return;
        if (isPlaying) {
            pause();
        } else {
            resume();
        }
    }, [audioError, clearAudioError, isBuffering, isPlaying, pause, resume]);

    useEffect(() => {
        const savedTab = readMigratingStorageItem(OVERLAY_ACTIVE_TAB_KEY);
        if (
            savedTab === "queue" ||
            savedTab === "lyrics" ||
            savedTab === "related"
        ) {
            setActiveTab(savedTab);
        }
    }, []);

    useEffect(() => {
        writeMigratingStorageItem(OVERLAY_ACTIVE_TAB_KEY, activeTab);
    }, [activeTab]);

    useEffect(() => {
        overlayRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isEditable =
                !!target &&
                (target.isContentEditable ||
                    tag === "input" ||
                    tag === "textarea" ||
                    tag === "select");

            if (isEditable) return;

            if (event.key === "Escape") {
                event.preventDefault();
                returnToPreviousMode();
                return;
            }

            if (event.code === "Space") {
                event.preventDefault();
                handlePlayPause();
                return;
            }

            if (canSkip && event.key === "ArrowLeft") {
                event.preventDefault();
                previous();
                return;
            }

            if (canSkip && event.key === "ArrowRight") {
                event.preventDefault();
                next();
                return;
            }

            if (!canSkip) return;

            const key = event.key.toLowerCase();
            if (key === "q") setActiveTab("queue");
            if (key === "l") setActiveTab("lyrics");
            if (key === "r") setActiveTab("related");
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [canSkip, handlePlayPause, next, previous, returnToPreviousMode]);

    useEffect(() => {
        if (!canSkip) {
            setIsDrawerOpen(false);
            return;
        }
        if (!isMobileOrTablet) {
            setIsDrawerOpen(true);
        }
    }, [
        canSkip,
        isMobileOrTablet,
        currentTrack?.id,
        currentAudiobook?.id,
        currentPodcast?.id,
    ]);

    useEffect(() => {
        if (isDrawerOpen) return;
        resetDrawerDrag();
    }, [isDrawerOpen, resetDrawerDrag]);

    const handleSeek = useCallback(
        (time: number) => {
            seek(time);
        },
        [seek],
    );

    const handlePlayFromQueue = useCallback(
        (index: number) => {
            if (isInGroup) {
                if (!isHost) {
                    toast.info("Only the host can change the current track");
                    return;
                }
                syncSetTrack(index);
                return;
            }
            playQueueIndex(index);
        },
        [isInGroup, isHost, syncSetTrack, playQueueIndex],
    );

    const handleRemoveFromQueue = useCallback(
        (index: number) => {
            removeFromQueue(index);
        },
        [removeFromQueue],
    );

    const handleClearQueue = useCallback(() => {
        clearQueue();
        toast.success("Queue cleared");
    }, [clearQueue]);

    // Handle Vibe toggle
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
                toast.success(`Vibe mode on`, {
                    description: `${result.trackCount} similar tracks queued`,
                    icon: (
                        <AudioWaveform className="w-4 h-4 text-brand-hover" />
                    ),
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
        if (!currentTrack?.artist) return;
        setIsRadioLoading(true);
        try {
            let response: { tracks: unknown[] } | null = null;
            const isRemote =
                currentTrack.streamSource === "tidal" ||
                currentTrack.streamSource === "youtube";
            if (isRemote && currentTrack.artist.name) {
                response = await api.getRadioTracks(
                    "artist-name",
                    currentTrack.artist.name,
                );
            } else if (currentTrack.artist.id) {
                response = await api.getRadioTracks(
                    "artist",
                    currentTrack.artist.id,
                );
            }
            if (!response) {
                toast.error("Artist information is required to start radio");
                return;
            }
            if (response.tracks && response.tracks.length > 0) {
                const filtered = response.tracks.filter(
                    (t): t is Track =>
                        isPlayableTrack(t) && t.id !== currentTrack.id,
                );
                setUpcoming(filtered);
                toast.success(
                    `Playing ${currentTrack.artist.name} Radio (${filtered.length} tracks)`,
                );
            } else {
                toast.error(
                    "Not enough similar music in your library for artist radio",
                );
            }
        } catch {
            toast.error("Failed to start artist radio");
        } finally {
            setIsRadioLoading(false);
        }
    };

    const handleAddToPlaylist = useCallback(
        async (playlistId: string) => {
            if (!currentTrack?.id) return;
            await api.addTrackToPlaylist(
                playlistId,
                toAddToPlaylistRef(currentTrack),
            );
            toast.success(
                `Added "${currentTrack.displayTitle || currentTrack.title}" to playlist`,
            );
        },
        [currentTrack],
    );

    const handleDrawerTabToggle = (tab: "queue" | "lyrics" | "related") => {
        if (!isMobileOrTablet) {
            setActiveTab(tab);
            return;
        }
        if (activeTab === tab) {
            setIsDrawerOpen((prev) => !prev);
            return;
        }
        setActiveTab(tab);
        setIsDrawerOpen(true);
    };

    if (!hasMedia) return null;

    return (
        <motion.div
            ref={overlayRef}
            tabIndex={-1}
            initial={
                shouldReduceMotion
                    ? { opacity: 1, y: 0 }
                    : { opacity: 0, y: 24 }
            }
            animate={{
                opacity: Math.max(0.55, 1 - overlayDragOffset / 360),
                y: overlayDragOffset,
            }}
            transition={
                isOverlayDragActive
                    ? { duration: 0 }
                    : {
                          duration: shouldReduceMotion ? 0 : 0.22,
                          ease: [0.22, 1, 0.36, 1],
                      }
            }
            className={cn(
                "fixed inset-0 bg-gradient-to-b from-[#1a1a2e] via-[#121218] to-[#000000] z-[9999] flex flex-col overflow-hidden",
                !isMobileOrTablet && "bottom-24",
            )}
            onTouchStart={
                isMobileOrTablet ? trackSwipeHandlers.onTouchStart : undefined
            }
            onTouchMove={
                isMobileOrTablet ? trackSwipeHandlers.onTouchMove : undefined
            }
            onTouchEnd={
                isMobileOrTablet ? trackSwipeHandlers.onTouchEnd : undefined
            }
        >
            {/* Header */}
            <div
                className="flex-shrink-0 px-4 pt-3 pb-2"
                style={{ paddingTop: "calc(12px + env(safe-area-inset-top))" }}
                onTouchStart={
                    isMobileOrTablet
                        ? overlayHeaderHandlers.onTouchStart
                        : undefined
                }
                onTouchMove={
                    isMobileOrTablet
                        ? overlayHeaderHandlers.onTouchMove
                        : undefined
                }
                onTouchEnd={
                    isMobileOrTablet
                        ? overlayHeaderHandlers.onTouchEnd
                        : undefined
                }
            >
                <div className="flex items-center justify-between">
                    {isMobileOrTablet ? (
                        <div className="w-11" />
                    ) : (
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                returnToPreviousMode();
                            }}
                            className="text-gray-400 hover:text-white transition-colors p-2 -ml-2 rounded-full hover:bg-white/10"
                            title="Close"
                        >
                            <ChevronDown className="w-7 h-7" />
                        </button>
                    )}
                    {/* Now Playing indicator */}
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 uppercase tracking-widest font-medium">
                            Now Playing
                        </span>
                        <SyncBadge compact />
                    </div>
                    <div className="w-11" /> {/* Spacer for centering */}
                </div>
                {isMobileOrTablet && (
                    <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/25" />
                )}
            </div>

            {/* Main Content - Portrait vs Landscape */}
            <div
                className={cn(
                    "flex-1 min-h-0 px-4 pt-2",
                    isMobileOrTablet
                        ? "overflow-hidden pb-24"
                        : "overflow-hidden pb-6 landscape:px-8",
                )}
                style={isMobileOrTablet ? undefined : { paddingRight: "50%" }}
            >
                <div className="mx-auto flex h-full w-full max-w-5xl flex-col items-center justify-center gap-4 landscape:gap-6">
                    {/* Left Rail: artwork + transport */}
                    <div
                        className={cn(
                            "w-full",
                            isMobileOrTablet
                                ? "max-w-[560px]"
                                : "max-w-[min(40vw,calc(100vh-20rem))]",
                        )}
                    >
                        <div
                            className={cn(
                                "mx-auto aspect-square w-full relative",
                                isMobileOrTablet
                                    ? "max-w-[min(92vw,52vh)]"
                                    : "max-w-[min(40vw,calc(100vh-20rem))]",
                            )}
                            style={{
                                transform: `translateX(${swipeOffset * 0.5}px)`,
                                opacity: 1 - Math.abs(swipeOffset) / 200,
                            }}
                        >
                            <div
                                className={cn(
                                    "absolute inset-0 rounded-2xl blur-2xl opacity-50",
                                    vibeMode
                                        ? "bg-gradient-to-br from-brand/30 via-transparent to-ai/30"
                                        : "bg-gradient-to-br from-brand-hover/20 via-transparent to-ai/20",
                                )}
                            />
                            <motion.div
                                layoutId={artworkLayoutId}
                                transition={{
                                    type: "spring",
                                    stiffness: 320,
                                    damping: 34,
                                }}
                                className="relative h-full w-full overflow-hidden rounded-2xl bg-gradient-to-br from-[#2a2a2a] to-surface-hover shadow-2xl"
                            >
                                {coverUrl ? (
                                    <Image
                                        key={coverUrl}
                                        src={coverUrl}
                                        alt={title}
                                        fill
                                        sizes="360px"
                                        className="object-cover"
                                        priority
                                        unoptimized
                                    />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                        <MusicIcon className="h-24 w-24 text-gray-400" />
                                    </div>
                                )}
                            </motion.div>

                            {canSkip &&
                                isMobileOrTablet &&
                                Math.abs(swipeOffset) > 20 && (
                                    <div
                                        className={cn(
                                            "absolute top-1/2 -translate-y-1/2 text-white/60",
                                            swipeOffset > 0
                                                ? "-left-8"
                                                : "-right-8",
                                        )}
                                    >
                                        {swipeOffset > 0 ? (
                                            <SkipBack className="h-6 w-6" />
                                        ) : (
                                            <SkipForward className="h-6 w-6" />
                                        )}
                                    </div>
                                )}
                        </div>

                        <div
                            className={cn(
                                "mx-auto w-full",
                                isMobileOrTablet
                                    ? "mt-3 p-3"
                                    : "mt-5 max-w-[420px] p-4 landscape:max-w-none",
                            )}
                        >
                            <div
                                className={cn(
                                    "text-center",
                                    isMobileOrTablet ? "mb-4" : "mb-2",
                                )}
                            >
                                <div className="flex min-w-0 items-center justify-center gap-2">
                                    {mediaLink ? (
                                        <Link
                                            href={mediaLink}
                                            prefetch={false}
                                            onClick={returnToPreviousMode}
                                            className="min-w-0 hover:underline"
                                        >
                                            <h1 className="truncate text-xl font-bold text-white">
                                                {title}
                                            </h1>
                                        </Link>
                                    ) : (
                                        <h1 className="truncate text-xl font-bold text-white">
                                            {title}
                                        </h1>
                                    )}
                                </div>
                                {artistLink ? (
                                    <Link
                                        href={artistLink}
                                        prefetch={false}
                                        onClick={returnToPreviousMode}
                                        className="block hover:underline"
                                    >
                                        <p className="mt-1 truncate text-base text-gray-400">
                                            {subtitle}
                                        </p>
                                    </Link>
                                ) : (
                                    <p className="mt-1 truncate text-base text-gray-400">
                                        {subtitle}
                                    </p>
                                )}
                                {currentTrackQualityBadge?.variant ===
                                    "tidal" && (
                                    <div className="mt-1.5 flex justify-center">
                                        <TidalBadge />
                                    </div>
                                )}
                                {currentTrackQualityBadge?.variant ===
                                    "youtube" && (
                                    <div className="mt-1.5 flex justify-center">
                                        <YouTubeBadge />
                                    </div>
                                )}
                            </div>

                            {isMobileOrTablet && (
                                <>
                                    <div className="mb-4">
                                        <SeekSlider
                                            progress={progress}
                                            duration={duration}
                                            currentTime={displayTime}
                                            onSeek={handleSeek}
                                            canSeek={canSeek}
                                            hasMedia={hasMedia}
                                            downloadProgress={downloadProgress}
                                            variant="overlay"
                                            showHandle={false}
                                            className="mb-2"
                                        />
                                        <div className="flex justify-between text-xs font-medium tabular-nums text-gray-400">
                                            <span>
                                                {formatTime(displayTime)}
                                            </span>
                                            <span>
                                                {playbackType === "podcast" ||
                                                playbackType === "audiobook"
                                                    ? formatTimeRemaining(
                                                          Math.max(
                                                              0,
                                                              duration -
                                                                  displayTime,
                                                          ),
                                                      )
                                                    : formatTime(duration)}
                                            </span>
                                        </div>
                                    </div>

                                    {canSkip ? (
                                        <>
                                            {isTrackMode && (
                                                <div className="mb-3 flex items-center justify-center gap-3">
                                                    <TrackPreferenceButtons
                                                        trackId={
                                                            preferenceTrackId
                                                        }
                                                        buttonSizeClassName="h-11 w-11"
                                                        iconSizeClassName="h-6 w-6"
                                                        metadata={buildPreferenceMetadata(
                                                            currentTrack,
                                                        )}
                                                    />

                                                    <button
                                                        onClick={() =>
                                                            setIsPlaylistSelectorOpen(
                                                                true,
                                                            )
                                                        }
                                                        className="flex h-11 w-11 items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                                                        title="Add to playlist"
                                                        aria-label="Add to playlist"
                                                    >
                                                        <Plus className="h-6 w-6" />
                                                    </button>

                                                    {currentTrack?.artist?.id &&
                                                        playbackType ===
                                                            "track" && (
                                                            <button
                                                                onClick={
                                                                    handleStartRadio
                                                                }
                                                                disabled={
                                                                    isRadioLoading
                                                                }
                                                                className="flex h-11 w-11 items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                                                                title="Start artist radio"
                                                                aria-label="Start Radio"
                                                            >
                                                                {isRadioLoading ? (
                                                                    <Loader2 className="h-6 w-6 animate-spin" />
                                                                ) : (
                                                                    <Radio className="h-6 w-6" />
                                                                )}
                                                            </button>
                                                        )}

                                                    {!featuresLoading &&
                                                        vibeEmbeddings && (
                                                            <button
                                                                onClick={
                                                                    handleVibeToggle
                                                                }
                                                                disabled={
                                                                    isVibeLoading
                                                                }
                                                                className={cn(
                                                                    "flex h-11 w-11 items-center justify-center rounded-full transition-colors",
                                                                    vibeMode
                                                                        ? "text-brand-hover bg-white/[0.05]"
                                                                        : "text-gray-400 hover:text-white hover:bg-white/10",
                                                                )}
                                                                title={
                                                                    vibeMode
                                                                        ? "Turn off vibe mode"
                                                                        : "Match this vibe"
                                                                }
                                                                aria-label="Match Vibe"
                                                            >
                                                                {isVibeLoading ? (
                                                                    <Loader2 className="h-6 w-6 animate-spin" />
                                                                ) : (
                                                                    <AudioWaveform className="h-6 w-6" />
                                                                )}
                                                            </button>
                                                        )}
                                                </div>
                                            )}

                                            {/* 7 fixed-size buttons (208px of icons) + ancestor padding
                                        (px-4 + p-3 = 56px) must fit a 320px-class viewport:
                                        gap-2 (6x8=48px) fits with 8px slack; >=375px restores the
                                        roomier gap-4 (6x16=96px, 360px total <= 375). Base class is
                                        the compact gap, so if the arbitrary variant ever failed to
                                        compile the row still fits everywhere. */}
                                            <div className="mb-3 flex items-center justify-center gap-2 min-[375px]:gap-4">
                                                <button
                                                    onClick={toggleShuffle}
                                                    className={cn(
                                                        "transition-colors",
                                                        isShuffle
                                                            ? "text-brand-hover"
                                                            : "text-gray-400 hover:text-white",
                                                    )}
                                                    title="Shuffle"
                                                    aria-label="Shuffle"
                                                >
                                                    <Shuffle className="h-5 w-5" />
                                                </button>

                                                {/* Skip back 15s — a seek, so gated on canSeek like the seek slider
                                            (false while an uncached podcast episode is still caching);
                                            independent of queue length */}
                                                <button
                                                    onClick={() =>
                                                        skipBackward(15)
                                                    }
                                                    className="text-white/85 transition-colors hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                                                    disabled={!canSeek}
                                                    title="Skip back 15 seconds"
                                                    aria-label="Skip back 15 seconds"
                                                >
                                                    <RotateCcw className="h-5 w-5" />
                                                </button>

                                                <button
                                                    onClick={previous}
                                                    className="text-white/85 transition-colors hover:text-white"
                                                    title="Previous"
                                                    aria-label="Previous"
                                                >
                                                    <SkipBack className="h-8 w-8" />
                                                </button>

                                                <button
                                                    onClick={handlePlayPause}
                                                    className={cn(
                                                        "flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full shadow-xl transition-all",
                                                        audioError
                                                            ? "bg-red-500 text-white hover:bg-red-400"
                                                            : isBuffering
                                                              ? "bg-white/80 text-black"
                                                              : "bg-white text-black hover:scale-105",
                                                    )}
                                                    disabled={isBuffering}
                                                    title={
                                                        audioError
                                                            ? "Retry playback"
                                                            : isBuffering
                                                              ? "Buffering..."
                                                              : isPlaying
                                                                ? "Pause"
                                                                : "Play"
                                                    }
                                                    aria-label={
                                                        audioError
                                                            ? "Retry playback"
                                                            : isPlaying
                                                              ? "Pause"
                                                              : "Play"
                                                    }
                                                >
                                                    {audioError ? (
                                                        <RefreshCw className="h-7 w-7" />
                                                    ) : isBuffering ? (
                                                        <Loader2 className="h-7 w-7 animate-spin" />
                                                    ) : isPlaying ? (
                                                        <Pause className="h-7 w-7" />
                                                    ) : (
                                                        <Play className="ml-1 h-7 w-7" />
                                                    )}
                                                </button>

                                                <button
                                                    onClick={next}
                                                    className="text-white/85 transition-colors hover:text-white"
                                                    title="Next"
                                                    aria-label="Next"
                                                >
                                                    <SkipForward className="h-8 w-8" />
                                                </button>

                                                {/* Skip forward 15s — a seek, so gated on canSeek like the seek slider
                                            (false while an uncached podcast episode is still caching);
                                            independent of queue length */}
                                                <button
                                                    onClick={() =>
                                                        skipForward(15)
                                                    }
                                                    className="text-white/85 transition-colors hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                                                    disabled={!canSeek}
                                                    title="Skip forward 15 seconds"
                                                    aria-label="Skip forward 15 seconds"
                                                >
                                                    <RotateCw className="h-5 w-5" />
                                                </button>

                                                <button
                                                    onClick={toggleRepeat}
                                                    className={cn(
                                                        "transition-colors",
                                                        repeatMode !== "off"
                                                            ? "text-brand-hover"
                                                            : "text-gray-400 hover:text-white",
                                                    )}
                                                    title={
                                                        repeatMode === "one"
                                                            ? "Repeat One"
                                                            : repeatMode ===
                                                                "all"
                                                              ? "Repeat All"
                                                              : "Repeat Off"
                                                    }
                                                    aria-label="Repeat"
                                                >
                                                    {repeatMode === "one" ? (
                                                        <Repeat1 className="h-5 w-5" />
                                                    ) : (
                                                        <Repeat className="h-5 w-5" />
                                                    )}
                                                </button>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="mb-3 flex items-center justify-center">
                                            <button
                                                onClick={handlePlayPause}
                                                className={cn(
                                                    "flex h-16 w-16 items-center justify-center rounded-full shadow-xl transition-all",
                                                    audioError
                                                        ? "bg-red-500 text-white hover:bg-red-400"
                                                        : isBuffering
                                                          ? "bg-white/80 text-black"
                                                          : "bg-white text-black hover:scale-105",
                                                )}
                                                disabled={isBuffering}
                                                title={
                                                    isPlaying ? "Pause" : "Play"
                                                }
                                                aria-label={
                                                    isPlaying ? "Pause" : "Play"
                                                }
                                            >
                                                {audioError ? (
                                                    <RefreshCw className="h-7 w-7" />
                                                ) : isBuffering ? (
                                                    <Loader2 className="h-7 w-7 animate-spin" />
                                                ) : isPlaying ? (
                                                    <Pause className="h-7 w-7" />
                                                ) : (
                                                    <Play className="ml-1 h-7 w-7" />
                                                )}
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {canSkip && isMobileOrTablet && !isDrawerOpen && (
                <div
                    className="absolute inset-x-0 bottom-0 z-20 border-t border-white/[0.12] bg-[#0b0d12]/95 px-4 pt-2 backdrop-blur-xl"
                    style={{
                        paddingBottom:
                            "calc(env(safe-area-inset-bottom) + 10px)",
                    }}
                >
                    <div className="mx-auto flex w-full max-w-sm items-center justify-center gap-8 text-sm">
                        <button
                            onClick={() => handleDrawerTabToggle("queue")}
                            className={cn(
                                "border-b pb-0.5 font-medium transition-colors",
                                activeTab === "queue"
                                    ? "border-brand-hover text-brand-hover"
                                    : "border-transparent text-gray-400 hover:text-white",
                            )}
                        >
                            Up Next
                        </button>
                        <button
                            onClick={() => handleDrawerTabToggle("lyrics")}
                            className={cn(
                                "border-b pb-0.5 font-medium transition-colors",
                                activeTab === "lyrics"
                                    ? "border-brand-hover text-brand-hover"
                                    : "border-transparent text-gray-400 hover:text-white",
                            )}
                        >
                            Lyrics
                        </button>
                        <button
                            onClick={() => handleDrawerTabToggle("related")}
                            className={cn(
                                "border-b pb-0.5 font-medium transition-colors",
                                activeTab === "related"
                                    ? "border-brand-hover text-brand-hover"
                                    : "border-transparent text-gray-400 hover:text-white",
                            )}
                        >
                            Related
                        </button>
                    </div>
                </div>
            )}

            {canSkip && (isMobileOrTablet || isDesktopOverlayLayout) && (
                <AnimatePresence>
                    {isDrawerOpen && (
                        <motion.div
                            key="overlay-drawer"
                            initial={
                                shouldReduceMotion
                                    ? { opacity: 1, y: 0 }
                                    : { opacity: 0, y: 28 }
                            }
                            animate={
                                isMobileOrTablet
                                    ? {
                                          opacity: Math.max(
                                              0.62,
                                              1 - drawerDragOffset / 360,
                                          ),
                                          y: drawerDragOffset,
                                      }
                                    : { opacity: 1, y: 0 }
                            }
                            exit={
                                shouldReduceMotion
                                    ? { opacity: 1, y: 0 }
                                    : {
                                          opacity: 0,
                                          y: isMobileOrTablet ? 92 : 28,
                                      }
                            }
                            transition={
                                isMobileOrTablet && isDrawerDragActive
                                    ? { duration: 0 }
                                    : { duration: shouldReduceMotion ? 0 : 0.2 }
                            }
                            className={cn(
                                "absolute z-20",
                                isMobileOrTablet
                                    ? "inset-0 border-t border-white/[0.12] bg-[#0b0d12]/95 backdrop-blur-xl"
                                    : "inset-y-0 right-0 w-[50%] min-w-[340px] py-24 pr-6",
                            )}
                        >
                            <div
                                className={cn(
                                    "flex h-full w-full flex-col",
                                    isMobileOrTablet
                                        ? "mx-auto max-w-none"
                                        : "",
                                )}
                            >
                                {isMobileOrTablet ? (
                                    <div
                                        className="border-b border-white/[0.08] px-3 pb-2"
                                        style={{
                                            paddingTop:
                                                "calc(10px + env(safe-area-inset-top))",
                                        }}
                                    >
                                        <div
                                            className="mb-1 flex items-center gap-3 px-1 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() =>
                                                setIsDrawerOpen(false)
                                            }
                                            onKeyDown={(e) => {
                                                if (
                                                    e.key === "Enter" ||
                                                    e.key === " "
                                                ) {
                                                    e.preventDefault();
                                                    setIsDrawerOpen(false);
                                                }
                                            }}
                                        >
                                            <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-md bg-surface-hover">
                                                {coverUrl ? (
                                                    <Image
                                                        src={coverUrl}
                                                        alt={title}
                                                        fill
                                                        sizes="40px"
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="flex h-full w-full items-center justify-center">
                                                        <MusicIcon className="h-4 w-4 text-gray-400" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium text-white">
                                                    {title}
                                                </p>
                                                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                                                    <p className="min-w-0 truncate text-xs text-gray-400">
                                                        {subtitle}
                                                    </p>
                                                    {currentTrackQualityBadge?.variant ===
                                                        "tidal" && (
                                                        <TidalBadge />
                                                    )}
                                                    {currentTrackQualityBadge?.variant ===
                                                        "youtube" && (
                                                        <YouTubeBadge />
                                                    )}
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handlePlayPause();
                                                }}
                                                className={cn(
                                                    "flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                                                    audioError
                                                        ? "bg-red-500 text-white hover:bg-red-400"
                                                        : "bg-white text-black hover:bg-white/90",
                                                )}
                                                aria-label={
                                                    audioError
                                                        ? "Retry playback"
                                                        : isPlaying
                                                          ? "Pause"
                                                          : "Play"
                                                }
                                                title={
                                                    audioError
                                                        ? "Retry playback"
                                                        : isPlaying
                                                          ? "Pause"
                                                          : "Play"
                                                }
                                            >
                                                {audioError ? (
                                                    <RefreshCw className="h-4 w-4" />
                                                ) : isBuffering ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : isPlaying ? (
                                                    <Pause className="h-4 w-4" />
                                                ) : (
                                                    <Play className="ml-0.5 h-4 w-4" />
                                                )}
                                            </button>
                                        </div>
                                        <div
                                            className="mb-2 flex h-12 w-full items-center justify-center"
                                            onTouchStart={
                                                drawerHandleHandlers.onTouchStart
                                            }
                                            onTouchMove={
                                                drawerHandleHandlers.onTouchMove
                                            }
                                            onTouchEnd={
                                                drawerHandleHandlers.onTouchEnd
                                            }
                                            style={{ touchAction: "none" }}
                                            aria-label="Swipe down to close panel"
                                        >
                                            <div className="h-2 w-24 rounded-full bg-white/70 shadow-[0_0_16px_rgba(255,255,255,0.22)]" />
                                        </div>
                                        <div className="mx-auto flex w-full max-w-xs items-center justify-center gap-6 text-sm">
                                            <button
                                                onClick={() =>
                                                    setActiveTab("queue")
                                                }
                                                className={cn(
                                                    "border-b pb-0.5 font-medium transition-colors",
                                                    activeTab === "queue"
                                                        ? "border-brand-hover text-brand-hover"
                                                        : "border-transparent text-gray-400 hover:text-white",
                                                )}
                                            >
                                                Up Next
                                            </button>
                                            <button
                                                onClick={() =>
                                                    setActiveTab("lyrics")
                                                }
                                                className={cn(
                                                    "border-b pb-0.5 font-medium transition-colors",
                                                    activeTab === "lyrics"
                                                        ? "border-brand-hover text-brand-hover"
                                                        : "border-transparent text-gray-400 hover:text-white",
                                                )}
                                            >
                                                Lyrics
                                            </button>
                                            <button
                                                onClick={() =>
                                                    setActiveTab("related")
                                                }
                                                className={cn(
                                                    "border-b pb-0.5 font-medium transition-colors",
                                                    activeTab === "related"
                                                        ? "border-brand-hover text-brand-hover"
                                                        : "border-transparent text-gray-400 hover:text-white",
                                                )}
                                            >
                                                Related
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-6 px-1 pb-3 text-sm">
                                        <button
                                            onClick={() =>
                                                setActiveTab("queue")
                                            }
                                            className={cn(
                                                "border-b pb-0.5 transition-colors",
                                                activeTab === "queue"
                                                    ? "border-brand-hover text-brand-hover"
                                                    : "border-transparent text-gray-400 hover:text-white",
                                            )}
                                        >
                                            Up Next
                                        </button>
                                        <button
                                            onClick={() =>
                                                setActiveTab("lyrics")
                                            }
                                            className={cn(
                                                "border-b pb-0.5 transition-colors",
                                                activeTab === "lyrics"
                                                    ? "border-brand-hover text-brand-hover"
                                                    : "border-transparent text-gray-400 hover:text-white",
                                            )}
                                        >
                                            Lyrics
                                        </button>
                                        <button
                                            onClick={() =>
                                                setActiveTab("related")
                                            }
                                            className={cn(
                                                "border-b pb-0.5 transition-colors",
                                                activeTab === "related"
                                                    ? "border-brand-hover text-brand-hover"
                                                    : "border-transparent text-gray-400 hover:text-white",
                                            )}
                                        >
                                            Related
                                        </button>
                                    </div>
                                )}

                                <div
                                    className={cn(
                                        "min-h-0 flex-1 overflow-hidden",
                                        tabPanelHeightClass,
                                    )}
                                >
                                    <AnimatePresence
                                        initial={false}
                                        mode="wait"
                                    >
                                        {activeTab === "queue" && (
                                            <OverlayQueueTab
                                                key="queue"
                                                queueTracks={queueTracks}
                                                currentIndex={currentIndex}
                                                onPlayFromQueue={
                                                    handlePlayFromQueue
                                                }
                                                onRemoveFromQueue={
                                                    handleRemoveFromQueue
                                                }
                                                onClearQueue={handleClearQueue}
                                            />
                                        )}

                                        {activeTab === "lyrics" && (
                                            <OverlayLyricsTab
                                                key="lyrics"
                                                lookupTrack={lyricsLookupTrack}
                                                currentTime={displayTime}
                                                isPlaying={isPlaying}
                                                onSeek={handleSeek}
                                            />
                                        )}

                                        {activeTab === "related" && (
                                            <OverlayRelatedTab
                                                key="related"
                                                currentTrack={currentTrack}
                                                isTrackPlayback={
                                                    playbackType === "track"
                                                }
                                                playTrack={playTrack}
                                                onNavigate={
                                                    returnToPreviousMode
                                                }
                                            />
                                        )}
                                    </AnimatePresence>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            )}

            {/* Safe area padding at bottom */}
            <div style={{ height: "env(safe-area-inset-bottom)" }} />

            <PlaylistSelector
                isOpen={isPlaylistSelectorOpen}
                onClose={() => setIsPlaylistSelectorOpen(false)}
                onSelectPlaylist={handleAddToPlaylist}
            />
        </motion.div>
    );
}
