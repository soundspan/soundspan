"use client";

import { useAudio } from "@/lib/audio-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { useLyrics } from "@/hooks/useLyrics";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    ChevronDown,
    Music as MusicIcon,
    ListMusic,
    Shuffle,
    Repeat,
    Repeat1,
    AudioWaveform,
    Loader2,
    RefreshCw,
    Trash2,
    X,
} from "lucide-react";
import { formatTime, clampTime, formatTimeRemaining } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { toast } from "sonner";
import { SeekSlider } from "./SeekSlider";
import { useFeatures } from "@/lib/features-context";
import { SyncedLyrics } from "./SyncedLyrics";
import { api } from "@/lib/api";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { SyncBadge } from "@/components/player/SyncBadge";
import { useListenTogether } from "@/lib/listen-together-context";
import { getArtistHref } from "@/utils/artistRoute";
import {
    OVERLAY_ACTIVE_TAB_STORAGE_KEY,
    readMigratingStorageItem,
    writeMigratingStorageItem,
} from "@/lib/storage-migration";

const OVERLAY_ACTIVE_TAB_KEY = OVERLAY_ACTIVE_TAB_STORAGE_KEY;

interface RelatedTrack {
    id?: string;
    title: string;
    artist?: string;
    similarity?: number;
    inLibrary?: boolean;
    matchConfidence?: number;
    duration?: number;
    filePath?: string;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    lastFmUrl?: string;
    album?: {
        id?: string;
        title?: string;
        coverArt?: string;
        coverUrl?: string;
        artist?: { id?: string; name?: string; mbid?: string };
    };
}

interface RelatedArtist {
    name: string;
    mbid?: string;
    image?: string;
}

interface RelatedAlbum {
    id: string;
    title: string;
    year?: number;
    coverArt?: string | null;
}

interface RelatedStreamMatch {
    streamSource: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    title?: string;
    artist?: string;
    duration?: number;
}

export function OverlayPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        isBuffering,
        currentTime,
        canSeek,
        downloadProgress,
        isShuffle,
        repeatMode,
        vibeMode,
        audioError,
        clearAudioError,
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
        duration: playbackDuration,
        queue,
        currentIndex,
        playTrack,
        playTracks,
        removeFromQueue,
        clearQueue,
    } = useAudio();

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const shouldReduceMotion = useReducedMotion();
    const { isInGroup, isHost, syncSetTrack } = useListenTogether();

    // Swipe state for track skipping
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const touchStartX = useRef<number | null>(null);
    const overlayCloseTouchStartY = useRef<number | null>(null);
    const overlayCloseTouchStartX = useRef<number | null>(null);
    const overlayCloseTouchStartTime = useRef<number | null>(null);
    const drawerTouchStartY = useRef<number | null>(null);
    const drawerTouchStartX = useRef<number | null>(null);
    const drawerTouchStartTime = useRef<number | null>(null);
    const queueListRef = useRef<HTMLDivElement | null>(null);
    const wasQueueTabVisibleRef = useRef(false);
    const previousQueueIndexRef = useRef<number | null>(null);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [overlayDragOffset, setOverlayDragOffset] = useState(0);
    const [isOverlayDragActive, setIsOverlayDragActive] = useState(false);
    const [drawerDragOffset, setDrawerDragOffset] = useState(0);
    const [isDrawerDragActive, setIsDrawerDragActive] = useState(false);
    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<"queue" | "lyrics" | "related">("queue");
    const [relatedStreamMatches, setRelatedStreamMatches] = useState<Record<string, RelatedStreamMatch>>({});
    const [matchingRelatedTrackKey, setMatchingRelatedTrackKey] = useState<string | null>(null);
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const { title, subtitle, coverUrl, artistLink, mediaLink } = useMediaInfo(500);
    const canSkip = playbackType === "track";
    const isDesktopOverlayLayout = canSkip && !isMobileOrTablet;
    const isTabPanelVisible = canSkip && (isDesktopOverlayLayout || isDrawerOpen);
    const lyricsTrackId =
        isTabPanelVisible && activeTab === "lyrics" && playbackType === "track"
            ? currentTrack?.id
            : undefined;
    const lyricsLookupMetadata =
        lyricsTrackId && currentTrack
            ? {
                  artist: currentTrack.artist?.name,
                  title: currentTrack.displayTitle || currentTrack.title,
                  album: currentTrack.album?.title,
                  duration: currentTrack.duration,
              }
            : undefined;

    // Lyrics query — only fetch when the lyrics panel is shown
    const {
        data: lyricsData,
        isLoading: isLyricsLoading,
        isError: isLyricsError,
    } = useLyrics(lyricsTrackId, lyricsLookupMetadata);

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
    const currentMediaId = currentTrack?.id || currentAudiobook?.id || currentPodcast?.id || "default";
    const artworkLayoutId = `mobile-player-artwork-${currentMediaId}`;
    const queueTracks = canSkip ? queue : [];
    const isQueueTabVisible = isTabPanelVisible && activeTab === "queue";

    const {
        data: relatedTrackData,
        isLoading: isRelatedTracksLoading,
    } = useQuery({
        queryKey: ["player-related-tracks", currentTrack?.id],
        queryFn: async () => {
            if (!currentTrack?.id) return [];
            const response = await api.getSimilarTracks(currentTrack.id, 12);
            return response.recommendations || [];
        },
        enabled:
            isTabPanelVisible &&
            activeTab === "related" &&
            playbackType === "track" &&
            !!currentTrack?.id,
        staleTime: 5 * 60 * 1000,
    });

    const {
        data: relatedArtistsData,
        isLoading: isRelatedArtistsLoading,
    } = useQuery({
        queryKey: ["player-related-artists", currentTrack?.artist?.name, currentTrack?.artist?.mbid],
        queryFn: async () => {
            if (!currentTrack?.artist?.name) return [];
            const response = await api.discoverSimilarArtists(
                currentTrack.artist.name,
                currentTrack.artist.mbid || "",
                8
            );
            return response.similarArtists || [];
        },
        enabled:
            isTabPanelVisible &&
            activeTab === "related" &&
            playbackType === "track" &&
            !!currentTrack?.artist?.name,
        staleTime: 30 * 60 * 1000,
    });

    const {
        data: moreFromArtistData,
        isLoading: isMoreFromArtistLoading,
    } = useQuery({
        queryKey: ["player-related-albums", currentTrack?.artist?.id],
        queryFn: async () => {
            if (!currentTrack?.artist?.id) return [];
            const response = await api.getAlbums({
                artistId: currentTrack.artist.id,
                limit: 8,
                sortBy: "recent",
            });
            return response.albums || [];
        },
        enabled:
            isTabPanelVisible &&
            activeTab === "related" &&
            playbackType === "track" &&
            !!currentTrack?.artist?.id,
        staleTime: 10 * 60 * 1000,
    });
    const relatedTracks = useMemo<RelatedTrack[]>(
        () =>
            Array.isArray(relatedTrackData)
                ? (relatedTrackData as RelatedTrack[])
                : [],
        [relatedTrackData]
    );
    const relatedArtists = useMemo<RelatedArtist[]>(
        () =>
            Array.isArray(relatedArtistsData)
                ? (relatedArtistsData as RelatedArtist[])
                : [],
        [relatedArtistsData]
    );
    const moreFromArtist = useMemo<RelatedAlbum[]>(
        () =>
            Array.isArray(moreFromArtistData)
                ? (moreFromArtistData as RelatedAlbum[])
                : [],
        [moreFromArtistData]
    );
    const tabPanelHeightClass = "min-h-0 flex-1";
    const sortedRelatedTracks = useMemo(() => {
        if (!relatedTracks.length) return [];
        return [...relatedTracks].sort((a, b) => {
            const scoreA =
                (a.inLibrary ? 1000 : 0) +
                (Number.isFinite(a.matchConfidence) ? a.matchConfidence : 0) * 2 +
                (Number.isFinite(a.similarity) ? a.similarity * 100 : 0);
            const scoreB =
                (b.inLibrary ? 1000 : 0) +
                (Number.isFinite(b.matchConfidence) ? b.matchConfidence : 0) * 2 +
                (Number.isFinite(b.similarity) ? b.similarity * 100 : 0);
            return scoreB - scoreA;
        });
    }, [relatedTracks]);
    const visibleRelatedTracks = useMemo(() => sortedRelatedTracks.slice(0, 8), [sortedRelatedTracks]);
    const tabTransitionProps = shouldReduceMotion
        ? {
              initial: { opacity: 1, y: 0 },
              animate: { opacity: 1, y: 0 },
              exit: { opacity: 1, y: 0 },
              transition: { duration: 0 },
          }
        : {
              initial: { opacity: 0, y: 8 },
              animate: { opacity: 1, y: 0 },
              exit: { opacity: 0, y: -8 },
              transition: { duration: 0.18 },
          };
    const getRelatedTrackKey = useCallback((track: RelatedTrack) => {
        if (track.id) return `lib:${track.id}`;
        const normalizedArtist = (track.artist || track.album?.artist?.name || "unknown")
            .trim()
            .toLowerCase();
        const normalizedTitle = (track.title || "unknown").trim().toLowerCase();
        return `ext:${normalizedArtist}::${normalizedTitle}`;
    }, []);

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

    const scrollQueueToCurrentTrack = useCallback(
        (behavior: ScrollBehavior) => {
        const listElement = queueListRef.current;
        if (!listElement || queueTracks.length === 0) return;

        const targetIndex =
            currentIndex >= 0 && currentIndex < queueTracks.length
                ? currentIndex
                : 0;
        const target = listElement.querySelector<HTMLElement>(
            `[data-queue-index="${targetIndex}"]`
        );
        if (!target) return;

        const targetTop =
            target.offsetTop -
            listElement.clientHeight / 2 +
            target.clientHeight / 2;

        listElement.scrollTo({
            top: Math.max(0, targetTop),
            behavior,
        });
        },
        [currentIndex, queueTracks.length]
    );

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
    }, [canSkip, isMobileOrTablet, currentTrack?.id, currentAudiobook?.id, currentPodcast?.id]);

    useEffect(() => {
        if (isDrawerOpen) return;
        setDrawerDragOffset(0);
        setIsDrawerDragActive(false);
        drawerTouchStartY.current = null;
        drawerTouchStartX.current = null;
        drawerTouchStartTime.current = null;
    }, [isDrawerOpen]);

    useEffect(() => {
        const wasQueueVisible = wasQueueTabVisibleRef.current;
        const previousIndex = previousQueueIndexRef.current;
        const becameVisible = isQueueTabVisible && !wasQueueVisible;
        const trackChangedWhileVisible =
            isQueueTabVisible &&
            wasQueueVisible &&
            previousIndex !== null &&
            currentIndex !== previousIndex;

        wasQueueTabVisibleRef.current = isQueueTabVisible;
        previousQueueIndexRef.current = currentIndex;

        if (!isQueueTabVisible || queueTracks.length === 0) return;
        if (!becameVisible && !trackChangedWhileVisible) return;

        const behavior: ScrollBehavior =
            becameVisible || shouldReduceMotion ? "auto" : "smooth";

        let frameA = 0;
        let frameB = 0;

        frameA = window.requestAnimationFrame(() => {
            frameB = window.requestAnimationFrame(() => {
                scrollQueueToCurrentTrack(behavior);
            });
        });

        return () => {
            if (frameA) window.cancelAnimationFrame(frameA);
            if (frameB) window.cancelAnimationFrame(frameB);
        };
    }, [
        isQueueTabVisible,
        queueTracks.length,
        currentIndex,
        scrollQueueToCurrentTrack,
        shouldReduceMotion,
    ]);

    useEffect(() => {
        if (!isTabPanelVisible || activeTab !== "related" || playbackType !== "track") return;

        const missingTracks = visibleRelatedTracks.filter((track) => {
            if (track.inLibrary) return false;
            const hasArtist = !!(track.artist || track.album?.artist?.name);
            if (!track.title || !hasArtist) return false;
            return !relatedStreamMatches[getRelatedTrackKey(track)];
        });
        if (missingTracks.length === 0) return;

        let cancelled = false;

        const hydrateMissingRelatedStreams = async () => {
            const payload = missingTracks.map((track) => ({
                artist: track.artist || track.album?.artist?.name || "",
                title: track.title,
                albumTitle: track.album?.title,
                duration: track.duration,
            }));
            const foundMatches: Record<string, RelatedStreamMatch> = {};

            let tidalMatches: Array<
                { id: number; title: string; artist: string; duration: number; isrc?: string } | null
            > = [];
            try {
                const tidalResponse = await api.matchTidalBatch(payload);
                tidalMatches = Array.isArray(tidalResponse.matches) ? tidalResponse.matches : [];
            } catch {
                tidalMatches = [];
            }

            const ytPayload: Array<{
                artist: string;
                title: string;
                albumTitle?: string;
                duration?: number;
            }> = [];
            const ytTrackKeys: string[] = [];

            missingTracks.forEach((track, index) => {
                const trackKey = getRelatedTrackKey(track);
                const tidalMatch = tidalMatches[index];
                if (tidalMatch?.id) {
                    foundMatches[trackKey] = {
                        streamSource: "tidal",
                        tidalTrackId: tidalMatch.id,
                        title: tidalMatch.title,
                        artist: tidalMatch.artist,
                        duration: tidalMatch.duration,
                    };
                    return;
                }
                ytPayload.push(payload[index]);
                ytTrackKeys.push(trackKey);
            });

            if (ytPayload.length > 0) {
                try {
                    const ytResponse = await api.matchYtMusicBatch(ytPayload);
                    const ytMatches = Array.isArray(ytResponse.matches) ? ytResponse.matches : [];
                    ytTrackKeys.forEach((trackKey, index) => {
                        const ytMatch = ytMatches[index];
                        if (!ytMatch?.videoId) return;
                        foundMatches[trackKey] = {
                            streamSource: "youtube",
                            youtubeVideoId: ytMatch.videoId,
                            title: ytMatch.title,
                            duration: ytMatch.duration,
                        };
                    });
                } catch {
                    // Ignore YT matching failures; rows still fall back to info links.
                }
            }

            if (cancelled || Object.keys(foundMatches).length === 0) return;
            setRelatedStreamMatches((prev) => ({ ...prev, ...foundMatches }));
        };

        hydrateMissingRelatedStreams();

        return () => {
            cancelled = true;
        };
    }, [
        activeTab,
        getRelatedTrackKey,
        isTabPanelVisible,
        playbackType,
        relatedStreamMatches,
        visibleRelatedTracks,
    ]);

    const handleSeek = (time: number) => {
        seek(time);
    };

    const handlePlayFromQueue = (index: number) => {
        if (isInGroup) {
            if (!isHost) {
                toast.info("Only the host can change the current track");
                return;
            }
            syncSetTrack(index);
            return;
        }
        playTracks(queue, index);
    };

    const handleRemoveFromQueue = (index: number) => {
        removeFromQueue(index);
    };

    const handleClearQueue = () => {
        clearQueue();
        toast.success("Queue cleared");
    };

    const playRelatedTrack = useCallback(
        async (track: RelatedTrack) => {
            const artistName = track.album?.artist?.name || track.artist || "Unknown artist";

            if (track.inLibrary && track.id) {
                playTrack({
                    id: track.id,
                    title: track.title,
                    artist: {
                        id: track.album?.artist?.id,
                        mbid: track.album?.artist?.mbid,
                        name: artistName,
                    },
                    album: {
                        id: track.album?.id,
                        title: track.album?.title || "Unknown album",
                        coverArt: track.album?.coverArt || track.album?.coverUrl,
                    },
                    duration: track.duration || 0,
                    filePath: track.filePath,
                    streamSource: track.streamSource,
                    tidalTrackId: track.tidalTrackId,
                    youtubeVideoId: track.youtubeVideoId,
                });
                return;
            }

            const trackKey = getRelatedTrackKey(track);
            setMatchingRelatedTrackKey(trackKey);

            try {
                const existingMatch = relatedStreamMatches[trackKey];
                let resolvedMatch = existingMatch;

                if (!resolvedMatch) {
                    const searchableArtist = (track.artist || track.album?.artist?.name || "").trim();
                    const searchableTitle = (track.title || "").trim();

                    if (searchableArtist && searchableTitle) {
                        try {
                            const tidalResponse = await api.matchTidalTrack(
                                searchableArtist,
                                searchableTitle,
                                track.album?.title,
                                track.duration
                            );
                            if (tidalResponse.match?.id) {
                                resolvedMatch = {
                                    streamSource: "tidal",
                                    tidalTrackId: tidalResponse.match.id,
                                    title: tidalResponse.match.title,
                                    artist: tidalResponse.match.artist,
                                    duration: tidalResponse.match.duration,
                                };
                            }
                        } catch {
                            // Ignore TIDAL single-match failures and try YT.
                        }

                        if (!resolvedMatch) {
                            try {
                                const ytResponse = await api.matchYtMusicTrack(
                                    searchableArtist,
                                    searchableTitle,
                                    track.album?.title,
                                    track.duration
                                );
                                if (ytResponse.match?.videoId) {
                                    resolvedMatch = {
                                        streamSource: "youtube",
                                        youtubeVideoId: ytResponse.match.videoId,
                                        title: ytResponse.match.title,
                                        duration: ytResponse.match.duration,
                                    };
                                }
                            } catch {
                                // Ignore YT single-match failures and fall through to info.
                            }
                        }
                    }
                }

                if (resolvedMatch) {
                    setRelatedStreamMatches((prev) => ({ ...prev, [trackKey]: resolvedMatch }));
                    playTrack({
                        id:
                            resolvedMatch.streamSource === "tidal"
                                ? `related-tidal-${resolvedMatch.tidalTrackId}`
                                : `related-yt-${resolvedMatch.youtubeVideoId}`,
                        title: track.title,
                        artist: { name: artistName },
                        album: {
                            title: track.album?.title || "Related Tracks",
                            coverArt: track.album?.coverArt || track.album?.coverUrl,
                        },
                        duration: resolvedMatch.duration || track.duration || 0,
                        streamSource: resolvedMatch.streamSource,
                        tidalTrackId: resolvedMatch.tidalTrackId,
                        youtubeVideoId: resolvedMatch.youtubeVideoId,
                    });
                    return;
                }

                if (track.lastFmUrl) {
                    window.open(track.lastFmUrl, "_blank", "noopener,noreferrer");
                    return;
                }

                toast.error("No playable stream found for this related track yet");
            } finally {
                setMatchingRelatedTrackKey(null);
            }
        },
        [getRelatedTrackKey, playTrack, relatedStreamMatches]
    );

    // Swipe handlers for track skipping
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (touchStartX.current === null) return;
        const deltaX = e.touches[0].clientX - touchStartX.current;
        setSwipeOffset(Math.max(-100, Math.min(100, deltaX)));
    };

    const handleTouchEnd = () => {
        if (touchStartX.current === null) return;

        if (canSkip) {
            if (swipeOffset > 60) {
                previous();
            } else if (swipeOffset < -60) {
                next();
            }
        }

        setSwipeOffset(0);
        touchStartX.current = null;
    };

    const handleDrawerHandleTouchStart = (e: React.TouchEvent) => {
        drawerTouchStartY.current = e.touches[0].clientY;
        drawerTouchStartX.current = e.touches[0].clientX;
        drawerTouchStartTime.current = Date.now();
        setDrawerDragOffset(0);
        setIsDrawerDragActive(true);
        e.stopPropagation();
    };

    const handleDrawerHandleTouchMove = (e: React.TouchEvent) => {
        if (drawerTouchStartY.current === null || drawerTouchStartX.current === null) return;

        const deltaY = e.touches[0].clientY - drawerTouchStartY.current;
        const deltaX = Math.abs(e.touches[0].clientX - drawerTouchStartX.current);

        if (deltaY > 0 && deltaY > deltaX * 0.9) {
            setDrawerDragOffset(Math.min(240, deltaY));
            e.preventDefault();
        } else if (deltaY <= 0) {
            setDrawerDragOffset(0);
        }
        e.stopPropagation();
    };

    const handleDrawerHandleTouchEnd = (e: React.TouchEvent) => {
        if (drawerTouchStartY.current === null || drawerTouchStartX.current === null) {
            setDrawerDragOffset(0);
            setIsDrawerDragActive(false);
            return;
        }

        const endY = e.changedTouches[0].clientY;
        const endX = e.changedTouches[0].clientX;
        const deltaY = endY - drawerTouchStartY.current;
        const deltaX = Math.abs(endX - drawerTouchStartX.current);
        const elapsedMs = Math.max(1, Date.now() - (drawerTouchStartTime.current ?? Date.now()));
        const velocityY = deltaY / elapsedMs;
        const isVerticalSwipe = deltaY > 0 && deltaY > deltaX * 1.2;
        const isDistanceClose = deltaY > 44;
        const isVelocityClose = deltaY > 20 && velocityY > 0.25;

        if (isVerticalSwipe && (isDistanceClose || isVelocityClose)) {
            setDrawerDragOffset((prev) => Math.max(prev, 140));
            setIsDrawerDragActive(false);
            setIsDrawerOpen(false);
        } else {
            setDrawerDragOffset(0);
            setIsDrawerDragActive(false);
        }
        drawerTouchStartY.current = null;
        drawerTouchStartX.current = null;
        drawerTouchStartTime.current = null;
        e.stopPropagation();
    };

    const handleOverlayHeaderTouchStart = (e: React.TouchEvent) => {
        overlayCloseTouchStartY.current = e.touches[0].clientY;
        overlayCloseTouchStartX.current = e.touches[0].clientX;
        overlayCloseTouchStartTime.current = Date.now();
        setOverlayDragOffset(0);
        setIsOverlayDragActive(true);
        e.stopPropagation();
    };

    const handleOverlayHeaderTouchMove = (e: React.TouchEvent) => {
        if (overlayCloseTouchStartY.current === null || overlayCloseTouchStartX.current === null) return;
        const deltaY = e.touches[0].clientY - overlayCloseTouchStartY.current;
        const deltaX = Math.abs(e.touches[0].clientX - overlayCloseTouchStartX.current);

        if (deltaY > 0 && deltaY > deltaX * 0.9) {
            setOverlayDragOffset(Math.min(220, deltaY));
            e.preventDefault();
        } else if (deltaY <= 0) {
            setOverlayDragOffset(0);
        }
        e.stopPropagation();
    };

    const handleOverlayHeaderTouchEnd = (e: React.TouchEvent) => {
        if (overlayCloseTouchStartY.current === null || overlayCloseTouchStartX.current === null) {
            setOverlayDragOffset(0);
            setIsOverlayDragActive(false);
            return;
        }

        const endY = e.changedTouches[0].clientY;
        const endX = e.changedTouches[0].clientX;
        const deltaY = endY - overlayCloseTouchStartY.current;
        const deltaX = Math.abs(endX - overlayCloseTouchStartX.current);
        const elapsedMs = Math.max(1, Date.now() - (overlayCloseTouchStartTime.current ?? Date.now()));
        const velocityY = deltaY / elapsedMs;
        const isVerticalSwipe = deltaY > 0 && deltaY > deltaX * 1.2;
        const isDistanceClose = deltaY > 44;
        const isVelocityClose = deltaY > 20 && velocityY > 0.25;

        if (isVerticalSwipe && (isDistanceClose || isVelocityClose)) {
            setOverlayDragOffset((prev) => Math.max(prev, 140));
            setIsOverlayDragActive(false);
            e.preventDefault();
            returnToPreviousMode();
        } else {
            setOverlayDragOffset(0);
            setIsOverlayDragActive(false);
        }
        overlayCloseTouchStartY.current = null;
        overlayCloseTouchStartX.current = null;
        overlayCloseTouchStartTime.current = null;
        e.stopPropagation();
    };

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
                    icon: <AudioWaveform className="w-4 h-4 text-[#60a5fa]" />,
                });
            } else {
                toast.error("Couldn't find matching tracks");
            }
        } catch (error) {
            console.error("Failed to start vibe match:", error);
            toast.error("Failed to match vibe");
        } finally {
            setIsVibeLoading(false);
        }
    };

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
            initial={shouldReduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
            animate={{ opacity: Math.max(0.55, 1 - overlayDragOffset / 360), y: overlayDragOffset }}
            transition={
                isOverlayDragActive
                    ? { duration: 0 }
                    : { duration: shouldReduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }
            }
            className="fixed inset-0 bg-gradient-to-b from-[#1a1a2e] via-[#121218] to-[#000000] z-[9999] flex flex-col overflow-hidden"
            onTouchStart={isMobileOrTablet ? handleTouchStart : undefined}
            onTouchMove={isMobileOrTablet ? handleTouchMove : undefined}
            onTouchEnd={isMobileOrTablet ? handleTouchEnd : undefined}
        >
            {/* Header */}
            <div
                className="flex-shrink-0 px-4 pt-3 pb-2"
                style={{ paddingTop: "calc(12px + env(safe-area-inset-top))" }}
                onTouchStart={isMobileOrTablet ? handleOverlayHeaderTouchStart : undefined}
                onTouchMove={isMobileOrTablet ? handleOverlayHeaderTouchMove : undefined}
                onTouchEnd={isMobileOrTablet ? handleOverlayHeaderTouchEnd : undefined}
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
                        <span className="text-xs text-gray-500 uppercase tracking-widest font-medium">
                            Now Playing
                        </span>
                        <SyncBadge compact />
                    </div>
                    <div className="w-11" /> {/* Spacer for centering */}
                </div>
                {isMobileOrTablet && <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/25" />}
            </div>

            {/* Main Content - Portrait vs Landscape */}
            <div
                className={cn(
                    "flex-1 min-h-0 px-4 pt-2",
                    isMobileOrTablet
                        ? "overflow-hidden pb-24"
                        : "overflow-hidden pb-6 landscape:px-8"
                )}
                style={
                    isMobileOrTablet
                        ? undefined
                        : { paddingRight: "clamp(340px, 37vw, 560px)" }
                }
            >
                <div
                    className="mx-auto flex h-full w-full max-w-5xl flex-col items-center justify-center gap-4 landscape:gap-6"
                >
                    {/* Left Rail: artwork + transport */}
                    <div className="w-full max-w-[560px]">
                        <div
                            className={cn(
                                "mx-auto aspect-square w-full relative",
                                isMobileOrTablet
                                    ? "max-w-[min(92vw,52vh)]"
                                    : "max-w-[360px] landscape:max-w-none"
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
                                        ? "bg-gradient-to-br from-brand/30 via-transparent to-purple-500/30"
                                        : "bg-gradient-to-br from-[#60a5fa]/20 via-transparent to-[#a855f7]/20"
                                )}
                            />
                            <motion.div
                                layoutId={artworkLayoutId}
                                transition={{ type: "spring", stiffness: 320, damping: 34 }}
                                className="relative h-full w-full overflow-hidden rounded-2xl bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] shadow-2xl"
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
                                        <MusicIcon className="h-24 w-24 text-gray-600" />
                                    </div>
                                )}
                            </motion.div>

                            {canSkip && isMobileOrTablet && Math.abs(swipeOffset) > 20 && (
                                <div
                                    className={cn(
                                        "absolute top-1/2 -translate-y-1/2 text-white/60",
                                        swipeOffset > 0 ? "-left-8" : "-right-8"
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
                                    : "mt-5 max-w-[420px] p-4 landscape:max-w-none"
                            )}
                        >
                            <div
                                className={cn(
                                    "text-center landscape:text-left",
                                    isMobileOrTablet ? "mb-4" : "mb-5"
                                )}
                            >
                                <div
                                    className={cn(
                                        "flex min-w-0 items-center gap-2",
                                        isMobileOrTablet
                                            ? "justify-center landscape:justify-start"
                                            : "justify-start"
                                    )}
                                >
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
                                    {!isMobileOrTablet && currentTrack?.streamSource === "tidal" && (
                                        <TidalBadge />
                                    )}
                                    {!isMobileOrTablet && currentTrack?.streamSource === "youtube" && (
                                        <YouTubeBadge />
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
                                {isMobileOrTablet && currentTrack?.streamSource === "tidal" && (
                                    <div className="mt-1 flex justify-center landscape:justify-start">
                                        <TidalBadge />
                                    </div>
                                )}
                                {isMobileOrTablet && currentTrack?.streamSource === "youtube" && (
                                    <div className="mt-1 flex justify-center landscape:justify-start">
                                        <YouTubeBadge />
                                    </div>
                                )}
                            </div>

                            <div className={cn(isMobileOrTablet ? "mb-4" : "mb-5")}>
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
                                <div className="flex justify-between text-xs font-medium tabular-nums text-gray-500">
                                    <span>{formatTime(displayTime)}</span>
                                    <span>
                                        {playbackType === "podcast" || playbackType === "audiobook"
                                            ? formatTimeRemaining(Math.max(0, duration - displayTime))
                                            : formatTime(duration)}
                                    </span>
                                </div>
                            </div>

                            {canSkip ? (
                                <div className="mb-3 flex items-center justify-between px-2">
                                    <button
                                        onClick={toggleShuffle}
                                        className={cn(
                                            "transition-colors",
                                            isShuffle
                                                ? "text-[#60a5fa]"
                                                : "text-gray-500 hover:text-white"
                                        )}
                                        title="Shuffle"
                                        aria-label="Shuffle"
                                    >
                                        <Shuffle className="h-5 w-5" />
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
                                            "flex h-16 w-16 items-center justify-center rounded-full shadow-xl transition-all",
                                            audioError
                                                ? "bg-red-500 text-white hover:bg-red-400"
                                                : isBuffering
                                                  ? "bg-white/80 text-black"
                                                  : "bg-white text-black hover:scale-105"
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

                                    <button
                                        onClick={toggleRepeat}
                                        className={cn(
                                            "transition-colors",
                                            repeatMode !== "off"
                                                ? "text-[#60a5fa]"
                                                : "text-gray-500 hover:text-white"
                                        )}
                                        title={
                                            repeatMode === "one"
                                                ? "Repeat One"
                                                : repeatMode === "all"
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
                                                  : "bg-white text-black hover:scale-105"
                                        )}
                                        disabled={isBuffering}
                                        title={isPlaying ? "Pause" : "Play"}
                                        aria-label={isPlaying ? "Pause" : "Play"}
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

                            {!featuresLoading && vibeEmbeddings && canSkip && (
                                <div className="flex items-center justify-center">
                                    <button
                                        onClick={handleVibeToggle}
                                        disabled={isVibeLoading}
                                        className={cn(
                                            "inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-sm transition-colors",
                                            vibeMode
                                                ? "bg-white/[0.03] text-[#60a5fa]"
                                                : "text-gray-300 hover:text-white"
                                        )}
                                        title={vibeMode ? "Turn off vibe mode" : "Match this vibe"}
                                    >
                                        {isVibeLoading ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <AudioWaveform className="h-4 w-4" />
                                        )}
                                        <span>{vibeMode ? "Vibe On" : "Match Vibe"}</span>
                                    </button>
                                </div>
                            )}

                        </div>
                    </div>
                </div>
            </div>

            {canSkip && isMobileOrTablet && !isDrawerOpen && (
                <div
                    className="absolute inset-x-0 bottom-0 z-20 border-t border-white/[0.12] bg-[#0b0d12]/95 px-4 pt-2 backdrop-blur-xl"
                    style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
                >
                    <div className="mx-auto flex w-full max-w-sm items-center justify-center gap-8 text-sm">
                        <button
                            onClick={() => handleDrawerTabToggle("queue")}
                            className={cn(
                                "border-b pb-0.5 font-medium transition-colors",
                                activeTab === "queue"
                                    ? "border-[#60a5fa] text-[#60a5fa]"
                                    : "border-transparent text-gray-400 hover:text-white"
                            )}
                        >
                            Up Next
                        </button>
                        <button
                            onClick={() => handleDrawerTabToggle("lyrics")}
                            className={cn(
                                "border-b pb-0.5 font-medium transition-colors",
                                activeTab === "lyrics"
                                    ? "border-[#60a5fa] text-[#60a5fa]"
                                    : "border-transparent text-gray-400 hover:text-white"
                            )}
                        >
                            Lyrics
                        </button>
                        <button
                            onClick={() => handleDrawerTabToggle("related")}
                            className={cn(
                                "border-b pb-0.5 font-medium transition-colors",
                                activeTab === "related"
                                    ? "border-[#60a5fa] text-[#60a5fa]"
                                    : "border-transparent text-gray-400 hover:text-white"
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
                            initial={shouldReduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 28 }}
                            animate={
                                isMobileOrTablet
                                    ? {
                                          opacity: Math.max(0.62, 1 - drawerDragOffset / 360),
                                          y: drawerDragOffset,
                                      }
                                    : { opacity: 1, y: 0 }
                            }
                            exit={
                                shouldReduceMotion
                                    ? { opacity: 1, y: 0 }
                                    : { opacity: 0, y: isMobileOrTablet ? 92 : 28 }
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
                                    : "inset-y-0 right-0 w-[37%] min-w-[340px] max-w-[560px] py-24 pr-6"
                            )}
                        >
                            <div
                                className={cn(
                                    "flex h-full w-full flex-col",
                                    isMobileOrTablet ? "mx-auto max-w-none" : ""
                                )}
                            >
                                {isMobileOrTablet ? (
                                    <div
                                        className="border-b border-white/[0.08] px-3 pb-2"
                                        style={{ paddingTop: "calc(10px + env(safe-area-inset-top))" }}
                                    >
                                        <div
                                            className="mb-1 flex items-center gap-3 px-1 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => setIsDrawerOpen(false)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" || e.key === " ") {
                                                    e.preventDefault();
                                                    setIsDrawerOpen(false);
                                                }
                                            }}
                                        >
                                            <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-md bg-[#1a1a1a]">
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
                                                        <MusicIcon className="h-4 w-4 text-gray-500" />
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
                                                    {currentTrack?.streamSource === "tidal" && (
                                                        <TidalBadge className="text-[9px] px-1 py-0.5 leading-none" />
                                                    )}
                                                    {currentTrack?.streamSource === "youtube" && (
                                                        <YouTubeBadge className="text-[9px] px-1 py-0.5 leading-none" />
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
                                                        : "bg-white text-black hover:bg-white/90"
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
                                            onTouchStart={handleDrawerHandleTouchStart}
                                            onTouchMove={handleDrawerHandleTouchMove}
                                            onTouchEnd={handleDrawerHandleTouchEnd}
                                            style={{ touchAction: "none" }}
                                            aria-label="Swipe down to close panel"
                                        >
                                            <div className="h-2 w-24 rounded-full bg-white/70 shadow-[0_0_16px_rgba(255,255,255,0.22)]" />
                                        </div>
                                        <div className="mx-auto flex w-full max-w-xs items-center justify-center gap-6 text-sm">
                                            <button
                                                onClick={() => setActiveTab("queue")}
                                                className={cn(
                                                    "border-b pb-0.5 font-medium transition-colors",
                                                    activeTab === "queue"
                                                        ? "border-[#60a5fa] text-[#60a5fa]"
                                                        : "border-transparent text-gray-400 hover:text-white"
                                                )}
                                            >
                                                Up Next
                                            </button>
                                            <button
                                                onClick={() => setActiveTab("lyrics")}
                                                className={cn(
                                                    "border-b pb-0.5 font-medium transition-colors",
                                                    activeTab === "lyrics"
                                                        ? "border-[#60a5fa] text-[#60a5fa]"
                                                        : "border-transparent text-gray-400 hover:text-white"
                                                )}
                                            >
                                                Lyrics
                                            </button>
                                            <button
                                                onClick={() => setActiveTab("related")}
                                                className={cn(
                                                    "border-b pb-0.5 font-medium transition-colors",
                                                    activeTab === "related"
                                                        ? "border-[#60a5fa] text-[#60a5fa]"
                                                        : "border-transparent text-gray-400 hover:text-white"
                                                )}
                                            >
                                                Related
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-6 px-1 pb-3 text-sm">
                                        <button
                                            onClick={() => setActiveTab("queue")}
                                            className={cn(
                                                "border-b pb-0.5 transition-colors",
                                                activeTab === "queue"
                                                    ? "border-[#60a5fa] text-[#60a5fa]"
                                                    : "border-transparent text-gray-400 hover:text-white"
                                            )}
                                        >
                                            Up Next
                                        </button>
                                        <button
                                            onClick={() => setActiveTab("lyrics")}
                                            className={cn(
                                                "border-b pb-0.5 transition-colors",
                                                activeTab === "lyrics"
                                                    ? "border-[#60a5fa] text-[#60a5fa]"
                                                    : "border-transparent text-gray-400 hover:text-white"
                                            )}
                                        >
                                            Lyrics
                                        </button>
                                        <button
                                            onClick={() => setActiveTab("related")}
                                            className={cn(
                                                "border-b pb-0.5 transition-colors",
                                                activeTab === "related"
                                                    ? "border-[#60a5fa] text-[#60a5fa]"
                                                    : "border-transparent text-gray-400 hover:text-white"
                                            )}
                                        >
                                            Related
                                        </button>
                                    </div>
                                )}

                                <div className={cn("min-h-0 flex-1 overflow-hidden", tabPanelHeightClass)}>
                                    <AnimatePresence initial={false} mode="wait">
                                        {activeTab === "queue" && (
                                            <motion.section
                                                key="queue"
                                                {...tabTransitionProps}
                                                className="h-full overflow-hidden flex flex-col"
                                            >
                                                <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-2">
                                                    <div className="flex items-center gap-2">
                                                        <ListMusic className="h-4 w-4 text-[#60a5fa]" />
                                                        <h2 className="text-sm font-semibold text-white">
                                                            Up Next
                                                        </h2>
                                                    </div>
                                                    <div className="flex items-center gap-3">
                                                        {queueTracks.length > 0 && (
                                                            <button
                                                                type="button"
                                                                onClick={handleClearQueue}
                                                                className="inline-flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-white"
                                                                title="Clear queue"
                                                                aria-label="Clear queue"
                                                            >
                                                                <Trash2 className="h-3 w-3" />
                                                                Clear Queue
                                                            </button>
                                                        )}
                                                        <span className="text-xs text-gray-400">
                                                            {queueTracks.length} tracks
                                                        </span>
                                                    </div>
                                                </div>

                                                {queueTracks.length === 0 ? (
                                                    <div className="flex min-h-0 flex-1 items-center justify-center px-4">
                                                        <p className="text-sm text-gray-500">
                                                            No tracks in queue.
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <div
                                                        ref={queueListRef}
                                                        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
                                                    >
                                                        {queueTracks.map((track, queueIndex) => {
                                                            const isCurrentTrack = queueIndex === currentIndex;
                                                            const isPlayedTrack = queueIndex < currentIndex;
                                                            return (
                                                                <div
                                                                    key={`${track.id}-${queueIndex}`}
                                                                    data-queue-index={queueIndex}
                                                                    className={cn(
                                                                        "mb-1.5 flex items-center gap-2 px-2 py-2 transition-colors",
                                                                        isCurrentTrack
                                                                            ? "rounded-md border border-[#60a5fa]/35 bg-[#60a5fa]/10"
                                                                            : isPlayedTrack
                                                                              ? "rounded-md bg-white/[0.03] hover:bg-white/[0.06]"
                                                                              : "hover:bg-white/[0.06]"
                                                                    )}
                                                                >
                                                                    <span
                                                                        className={cn(
                                                                            "w-5 flex-shrink-0 text-center text-[11px] tabular-nums",
                                                                            isCurrentTrack
                                                                                ? "text-[#60a5fa]"
                                                                                : "text-gray-500"
                                                                        )}
                                                                    >
                                                                        {queueIndex + 1}
                                                                    </span>
                                                                    <button
                                                                        onClick={() => {
                                                                            if (!isCurrentTrack) {
                                                                                handlePlayFromQueue(queueIndex);
                                                                            }
                                                                        }}
                                                                        className={cn(
                                                                            "flex min-w-0 flex-1 items-center gap-3 text-left",
                                                                            isCurrentTrack && "cursor-default"
                                                                        )}
                                                                        title={
                                                                            isCurrentTrack
                                                                                ? "Now playing"
                                                                                : "Play this track now"
                                                                        }
                                                                    >
                                                                        <div className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded bg-[#1a1a1a]">
                                                                            {track.album?.coverArt ? (
                                                                                <Image
                                                                                    src={api.getCoverArtUrl(
                                                                                        track.album.coverArt,
                                                                                        100
                                                                                    )}
                                                                                    alt={track.album.title}
                                                                                    fill
                                                                                    sizes="44px"
                                                                                    className="object-cover"
                                                                                    unoptimized
                                                                                />
                                                                            ) : (
                                                                                <div className="flex h-full w-full items-center justify-center">
                                                                                    <MusicIcon className="h-4 w-4 text-gray-600" />
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                        <div className="min-w-0">
                                                                            <div className="flex min-w-0 items-center gap-1.5">
                                                                                <p
                                                                                    className={cn(
                                                                                        "min-w-0 truncate text-sm",
                                                                                        isCurrentTrack
                                                                                            ? "text-[#60a5fa]"
                                                                                            : "text-white"
                                                                                    )}
                                                                                >
                                                                                    {track.displayTitle ?? track.title}
                                                                                </p>
                                                                                {track.streamSource === "tidal" && (
                                                                                    <TidalBadge className="text-[9px] px-1 py-0.5 leading-none" />
                                                                                )}
                                                                                {track.streamSource === "youtube" && (
                                                                                    <YouTubeBadge
                                                                                        className="text-[9px] px-1 py-0.5 leading-none"
                                                                                    />
                                                                                )}
                                                                            </div>
                                                                            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                                                                                <p className="min-w-0 truncate text-xs text-gray-400">
                                                                                    {track.artist?.name ||
                                                                                        "Unknown artist"}
                                                                                </p>
                                                                                {isCurrentTrack && (
                                                                                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#60a5fa]/40 bg-[#60a5fa]/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#60a5fa]">
                                                                                        <span className="inline-flex items-end gap-0.5">
                                                                                            <span className="h-2 w-0.5 animate-bounce rounded-full bg-[#60a5fa] [animation-delay:-0.2s]" />
                                                                                            <span className="h-2.5 w-0.5 animate-bounce rounded-full bg-[#60a5fa]" />
                                                                                            <span className="h-1.5 w-0.5 animate-bounce rounded-full bg-[#60a5fa] [animation-delay:-0.35s]" />
                                                                                        </span>
                                                                                        Playing
                                                                                    </span>
                                                                                )}
                                                                                {isPlayedTrack && !isCurrentTrack && (
                                                                                    <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-gray-400">
                                                                                        Played
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    </button>

                                                                    <span
                                                                        className={cn(
                                                                            "text-[11px] tabular-nums",
                                                                            isCurrentTrack
                                                                                ? "text-[#60a5fa]"
                                                                                : "text-gray-500"
                                                                        )}
                                                                    >
                                                                        {formatTime(track.duration || 0)}
                                                                    </span>
                                                                    {!isCurrentTrack && (
                                                                        <button
                                                                            onClick={() =>
                                                                                handleRemoveFromQueue(queueIndex)
                                                                            }
                                                                            className="p-1 text-gray-500 transition-colors hover:text-red-300"
                                                                            title="Remove from queue"
                                                                            aria-label="Remove from queue"
                                                                        >
                                                                            <X className="h-4 w-4" />
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </motion.section>
                                        )}

                                        {activeTab === "lyrics" && (
                                            <motion.section
                                                key="lyrics"
                                                {...tabTransitionProps}
                                                className="h-full overflow-hidden"
                                            >
                                                {isLyricsLoading ? (
                                                    <div className="flex h-full items-center justify-center gap-2 text-gray-400">
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                        <span className="text-sm">Loading lyrics...</span>
                                                    </div>
                                                ) : isLyricsError ? (
                                                    <div className="flex h-full items-center justify-center px-4">
                                                        <p className="text-center text-sm text-gray-500">
                                                            Failed to load lyrics
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <SyncedLyrics
                                                        syncedLyrics={lyricsData?.syncedLyrics ?? null}
                                                        plainLyrics={lyricsData?.plainLyrics ?? null}
                                                        currentTime={displayTime}
                                                        isPlaying={isPlaying}
                                                        onSeek={handleSeek}
                                                        className="h-full"
                                                    />
                                                )}
                                            </motion.section>
                                        )}

                                        {activeTab === "related" && (
                                            <motion.section
                                                key="related"
                                                {...tabTransitionProps}
                                                className="h-full space-y-5 overflow-y-auto px-4 py-3"
                                            >
                                                <section>
                                                    <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-400">
                                                        Similar Songs
                                                    </h3>
                                                    {isRelatedTracksLoading ? (
                                                        <p className="text-sm text-gray-500">Loading...</p>
                                                    ) : sortedRelatedTracks.length > 0 ? (
                                                        <div className="space-y-1.5">
                                                            {visibleRelatedTracks.map((track, idx) => {
                                                                const trackKey = getRelatedTrackKey(track);
                                                                const streamMatch = relatedStreamMatches[trackKey];
                                                                const isMatchingTrack =
                                                                    matchingRelatedTrackKey === trackKey;
                                                                const isInLibrary = !!track.inLibrary;
                                                                return (
                                                                    <button
                                                                        key={`${track.id || track.title}-${idx}`}
                                                                        type="button"
                                                                        onClick={() => playRelatedTrack(track)}
                                                                        className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[0.06]"
                                                                    >
                                                                    <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-[#1a1a1a]">
                                                                        {isInLibrary &&
                                                                        (track.album?.coverArt ||
                                                                            track.album?.coverUrl) ? (
                                                                            <Image
                                                                                src={api.getCoverArtUrl(
                                                                                    track.album.coverArt ||
                                                                                        track.album.coverUrl,
                                                                                    100
                                                                                )}
                                                                                alt={track.album?.title || track.title}
                                                                                fill
                                                                                sizes="40px"
                                                                                className="object-cover"
                                                                                unoptimized
                                                                            />
                                                                        ) : (
                                                                            <div className="flex h-full w-full items-center justify-center">
                                                                                <MusicIcon className="h-4 w-4 text-gray-600" />
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <div className="min-w-0 flex-1 pr-2">
                                                                        <p className="truncate text-sm text-gray-200 group-hover:text-white">
                                                                            {track.title}
                                                                        </p>
                                                                        <p className="truncate text-xs text-gray-500">
                                                                            {isInLibrary
                                                                                ? track.album?.artist?.name ||
                                                                                  track.artist ||
                                                                                  "Unknown artist"
                                                                                : track.artist ||
                                                                                  "Unknown artist"}
                                                                        </p>
                                                                    </div>
                                                                    <div className="flex shrink-0 items-center gap-1">
                                                                        {isInLibrary ? (
                                                                            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                                                                                In Library
                                                                            </span>
                                                                        ) : isMatchingTrack ? (
                                                                            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-gray-300">
                                                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                                                Matching
                                                                            </span>
                                                                        ) : streamMatch?.streamSource === "tidal" ? (
                                                                            <span className="rounded-full border border-[#00BFFF]/40 bg-[#00BFFF]/15 px-2 py-0.5 text-[10px] text-[#00BFFF]">
                                                                                TIDAL
                                                                            </span>
                                                                        ) : streamMatch?.streamSource === "youtube" ? (
                                                                            <span className="rounded-full border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] text-red-300">
                                                                                YT MUSIC
                                                                            </span>
                                                                        ) : track.lastFmUrl ? (
                                                                            <span className="rounded-full border border-white/20 bg-white/[0.04] px-2 py-0.5 text-[10px] text-gray-300">
                                                                                Info
                                                                            </span>
                                                                        ) : (
                                                                            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-gray-400">
                                                                                Search
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </button>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : (
                                                        <p className="text-sm text-gray-500">
                                                            No similar songs found.
                                                        </p>
                                                    )}
                                                </section>

                                                <section>
                                                    <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-400">
                                                        Similar Artists
                                                    </h3>
                                                    {isRelatedArtistsLoading ? (
                                                        <p className="text-sm text-gray-500">Loading...</p>
                                                    ) : relatedArtists.length > 0 ? (
                                                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                                            {relatedArtists.slice(0, 9).map((artist, idx) => {
                                                                const artistHref =
                                                                    getArtistHref(
                                                                        {
                                                                            mbid: artist.mbid,
                                                                            name: artist.name,
                                                                        },
                                                                        {
                                                                            preferLibraryId: false,
                                                                        }
                                                                    ) ||
                                                                    `/artist/${encodeURIComponent(
                                                                        artist.name
                                                                    )}`;
                                                                const artistId =
                                                                    artist.mbid ||
                                                                    encodeURIComponent(artist.name);
                                                                return (
                                                                    <Link
                                                                        key={`${artistId}-${idx}`}
                                                                        href={artistHref}
                                                                        onClick={returnToPreviousMode}
                                                                        className="group p-1.5 transition-colors hover:bg-white/[0.06]"
                                                                    >
                                                                        <div className="mb-2 relative mx-auto h-12 w-12 overflow-hidden rounded-full bg-[#1a1a1a]">
                                                                            {artist.image ? (
                                                                                <Image
                                                                                    src={artist.image}
                                                                                    alt={artist.name}
                                                                                    fill
                                                                                    sizes="48px"
                                                                                    className="object-cover"
                                                                                    unoptimized
                                                                                />
                                                                            ) : (
                                                                                <div className="flex h-full w-full items-center justify-center">
                                                                                    <MusicIcon className="h-4 w-4 text-gray-600" />
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                        <p className="truncate text-center text-xs text-gray-200 group-hover:text-white">
                                                                            {artist.name}
                                                                        </p>
                                                                    </Link>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : (
                                                        <p className="text-sm text-gray-500">
                                                            No similar artists found.
                                                        </p>
                                                    )}
                                                </section>

                                                <section>
                                                    <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-400">
                                                        More From This Artist
                                                    </h3>
                                                    {isMoreFromArtistLoading ? (
                                                        <p className="text-sm text-gray-500">Loading...</p>
                                                    ) : moreFromArtist.length > 0 ? (
                                                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                                            {moreFromArtist.slice(0, 6).map((album) => (
                                                                <Link
                                                                    key={album.id}
                                                                    href={`/album/${album.id}`}
                                                                    onClick={returnToPreviousMode}
                                                                    className="group p-1.5 transition-colors hover:bg-white/[0.06]"
                                                                >
                                                                    <div className="relative mb-2 aspect-square w-full overflow-hidden rounded bg-[#1a1a1a]">
                                                                        {album.coverArt ? (
                                                                            <Image
                                                                                src={api.getCoverArtUrl(
                                                                                    album.coverArt,
                                                                                    200
                                                                                )}
                                                                                alt={album.title}
                                                                                fill
                                                                                sizes="140px"
                                                                                className="object-cover"
                                                                                unoptimized
                                                                            />
                                                                        ) : (
                                                                            <div className="flex h-full w-full items-center justify-center">
                                                                                <MusicIcon className="h-5 w-5 text-gray-600" />
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <p className="truncate text-xs text-gray-200 group-hover:text-white">
                                                                        {album.title}
                                                                    </p>
                                                                    {album.year && (
                                                                        <p className="text-[11px] text-gray-500">
                                                                            {album.year}
                                                                        </p>
                                                                    )}
                                                                </Link>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <p className="text-sm text-gray-500">No albums found.</p>
                                                    )}
                                                </section>
                                            </motion.section>
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
        </motion.div>
    );
}
