"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { useAudioState, useAudioPlayback, useAudioControls, Track as AudioTrack } from "@/lib/audio-context";
import { cn } from "@/utils/cn";
import { shuffleArray } from "@/utils/shuffle";
import { formatTime } from "@/utils/formatTime";
import { usePlaylistQuery } from "@/hooks/useQueries";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { TrackOverflowMenu, TrackMenuButton } from "@/components/ui/TrackOverflowMenu";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/lib/toast-context";
import { useDownloadContext } from "@/lib/download-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import {
    Play,
    Pause,
    Trash2,
    Shuffle,
    Eye,
    EyeOff,
    ListMusic,
    Music,
    Volume2,
    RefreshCw,
    AlertCircle,
    X,
    Loader2,
    Radio,
} from "lucide-react";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface Track {
    id: string;
    title: string;
    duration: number;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    album: {
        id?: string;
        title: string;
        coverArt?: string | null;
        artist: {
            id?: string;
            name: string;
        };
    };
}

interface TrackPlaybackMeta {
    isPlayable: boolean;
    reason: string | null;
    message: string | null;
}

interface TrackProviderMeta {
    source: "local" | "tidal" | "youtube" | "unknown";
    label?: string;
    tidalTrackId?: number | null;
    youtubeVideoId?: string | null;
}

interface PlaylistItem {
    id: string;
    type: "track";
    sort: number;
    track: Track | null;
    trackId?: string | null;
    provider?: TrackProviderMeta;
    playback?: TrackPlaybackMeta;
}

interface PendingTrack {
    id: string;
    type: "pending";
    sort: number;
    pending: {
        id: string;
        artist: string;
        title: string;
        album: string;
        previewUrl: string | null;
    };
}

interface PlayablePlaylistItem extends PlaylistItem {
    track: Track;
}

function isPlayableTrackItem(item: PlaylistItem): item is PlayablePlaylistItem {
    return Boolean(item.track && item.playback?.isPlayable !== false);
}

function isLocalPlayableTrackItem(item: PlaylistItem): item is PlayablePlaylistItem {
    if (!isPlayableTrackItem(item)) return false;
    return (item.provider?.source || "local") === "local";
}

function toAudioTrack(item: PlayablePlaylistItem): AudioTrack {
    const track = item.track;
    return {
        id: track.id,
        title: track.title,
        artist: {
            name: track.album.artist.name,
            id: track.album.artist.id,
        },
        album: {
            title: track.album.title,
            coverArt: track.album.coverArt || undefined,
            id: track.album.id,
        },
        duration: track.duration,
        ...(track.streamSource === "tidal"
            ? {
                  streamSource: "tidal" as const,
                  tidalTrackId: track.tidalTrackId,
              }
            : {}),
        ...(track.streamSource === "youtube"
            ? {
                  streamSource: "youtube" as const,
                  youtubeVideoId: track.youtubeVideoId,
              }
            : {}),
    };
}

export default function PlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, playNow, pause, resume } = useAudioControls();
    const queuedTrackIds = useQueuedTrackIds();
    const playlistId = params.id as string;

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isHiding, setIsHiding] = useState(false);
    const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(
        null
    );
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();
    const [retryingTrackId, setRetryingTrackId] = useState<string | null>(null);
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    // Clean up preview audio on unmount
    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
        };
    }, []);

    // Handle Deezer preview playback
    const handlePlayPreview = async (pendingId: string) => {
        // If already playing this preview, stop it
        if (playingPreviewId === pendingId && previewAudioRef.current) {
            previewAudioRef.current.pause();
            setPlayingPreviewId(null);
            return;
        }

        // Stop any currently playing preview
        if (previewAudioRef.current) {
            previewAudioRef.current.pause();
        }

        // Show loading state
        setPlayingPreviewId(pendingId);

        try {
            // Always fetch a fresh preview URL since Deezer URLs expire quickly
            const result = await api.getFreshPreviewUrl(playlistId, pendingId);
            const previewUrl = result.previewUrl;

            // Create and play new audio
            const audio = new Audio(previewUrl);
            audio.volume = 0.5;
            audio.onended = () => setPlayingPreviewId(null);
            audio.onerror = (e) => {
                sharedFrontendLogger.error("Deezer preview playback failed:", e);
                setPlayingPreviewId(null);
                toast.error("Preview playback failed");
            };
            previewAudioRef.current = audio;

            await audio.play();
        } catch (err) {
            sharedFrontendLogger.error("Failed to play Deezer preview:", err);
            setPlayingPreviewId(null);
            toast.error("No preview available");
        }
    };

    // Handle retry download for pending track
    const { downloadsEnabled } = useDownloadContext();
    const handleRetryPendingTrack = async (pendingId: string) => {
        setRetryingTrackId(pendingId);
        try {
            const result = await api.retryPendingTrack(playlistId, pendingId);
            if (result.success) {
                // Use the activity sidebar (Active tab) instead of a toast/modal
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                // If the backend emits a scan/download notification, refresh it
                window.dispatchEvent(new CustomEvent("notifications-changed"));
                // Refresh playlist data after a delay to allow download + scan to complete
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: ["playlist", playlistId],
                    });
                }, 10000); // 10 seconds for download + scan
            } else {
                toast.error(result.message || "Track not found on Soulseek");
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to retry download:", error);
            toast.error("Failed to retry download");
        } finally {
            setRetryingTrackId(null);
        }
    };

    // Handle remove pending track
    const handleRemovePendingTrack = async (pendingId: string) => {
        setRemovingTrackId(pendingId);
        try {
            await api.removePendingTrack(playlistId, pendingId);
            // Refresh playlist data
            queryClient.invalidateQueries({
                queryKey: ["playlist", playlistId],
            });
        } catch (error) {
            sharedFrontendLogger.error("Failed to remove pending track:", error);
        } finally {
            setRemovingTrackId(null);
        }
    };

    // Use React Query hook for playlist
    const { data: playlist, isLoading } = usePlaylistQuery(playlistId);

    // Check if this is a shared playlist
    const isShared = playlist?.isOwner === false;

    const handleToggleHide = async () => {
        if (!playlist) return;
        setIsHiding(true);
        try {
            if (playlist.isHidden) {
                await api.unhidePlaylist(playlistId);
            } else {
                await api.hidePlaylist(playlistId);
            }

            // Update local state immediately
            queryClient.setQueryData(["playlist", playlistId], (old: Record<string, unknown>) => ({
                ...old,
                isHidden: !playlist.isHidden,
            }));

            // Dispatch event to update sidebar and other components
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );

            // Optionally navigate away if hiding
            if (!playlist.isHidden) {
                router.push("/playlists");
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to toggle playlist visibility:", error);
        } finally {
            setIsHiding(false);
        }
    };

    const trackItems = useMemo(
        () => (playlist?.items as PlaylistItem[] | undefined) || [],
        [playlist?.items]
    );

    const playableTrackItems = useMemo(
        () => trackItems.filter((item) => isPlayableTrackItem(item)),
        [trackItems]
    );

    const unplayableTrackItems = useMemo(
        () =>
            trackItems.filter(
                (item) =>
                    item.track === null || item.playback?.isPlayable === false
            ),
        [trackItems]
    );

    const playableTracks = useMemo(
        () => playableTrackItems.map((item) => toAudioTrack(item)),
        [playableTrackItems]
    );

    const trackDisplayIndexByItemId = useMemo(() => {
        const byId = new Map<string, number>();
        trackItems.forEach((item, index) => {
            byId.set(item.id, index + 1);
        });
        return byId;
    }, [trackItems]);

    const providerCounts = useMemo(
        () =>
            trackItems.reduce(
                (acc, item) => {
                    const source = item.provider?.source || "local";
                    if (source === "tidal") acc.tidal += 1;
                    else if (source === "youtube") acc.youtube += 1;
                    else if (source === "local") acc.local += 1;
                    return acc;
                },
                { local: 0, tidal: 0, youtube: 0 }
            ),
        [trackItems]
    );

    // Calculate cover arts from playlist tracks for mosaic (memoized)
    const coverUrls = useMemo(() => {
        if (trackItems.length === 0) return [];

        const uniqueCovers = Array.from(
            new Set(
                trackItems
                    .map((item) => item.track?.album?.coverArt || null)
                    .filter((value): value is string => Boolean(value))
            )
        ).slice(0, 4);

        return uniqueCovers;
    }, [trackItems]);

    const handleRemoveTrack = async (trackId: string) => {
        try {
            await api.removeTrackFromPlaylist(playlistId, trackId);
            // Track disappearing from list is feedback enough
        } catch (error) {
            sharedFrontendLogger.error("Failed to remove track:", error);
        }
    };

    const handleDeletePlaylist = async () => {
        try {
            await api.deletePlaylist(playlistId);

            // Dispatch event to update sidebar
            window.dispatchEvent(
                new CustomEvent("playlist-deleted", { detail: { playlistId } })
            );

            router.push("/playlists");
        } catch (error) {
            sharedFrontendLogger.error("Failed to delete playlist:", error);
        }
    };

    // Check if this playlist is currently playing
    const playlistTrackIds = useMemo(() => {
        return new Set(playableTracks.map((track) => track.id));
    }, [playableTracks]);

    const isThisPlaylistPlaying = useMemo(() => {
        if (!isPlaying || !currentTrack || playableTracks.length === 0)
            return false;
        // Check if current track is in this playlist
        return playlistTrackIds.has(currentTrack.id);
    }, [isPlaying, currentTrack, playlistTrackIds, playableTracks.length]);

    // Calculate total duration - MUST be before early returns
    const totalDuration = useMemo(() => {
        if (trackItems.length === 0) return 0;
        return trackItems.reduce(
            (sum: number, item: PlaylistItem) =>
                sum + (item.track?.duration || 0),
            0
        );
    }, [trackItems]);

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    const handlePlayPlaylist = () => {
        if (trackItems.length === 0) return;

        // If this playlist is playing, toggle pause/resume
        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        if (playableTracks.length === 0) {
            toast.error("No playable tracks in this playlist yet");
            return;
        }

        triggerPlayFeedback();
        playTracks(playableTracks, 0);
    };

    const handlePlayTrack = (itemId: string) => {
        const item = trackItems.find((entry) => entry.id === itemId);
        if (!item) return;
        const fallbackMessage =
            item.playback?.message ||
            "Playback is unavailable for this track right now";

        if (!isPlayableTrackItem(item)) {
            toast.error(fallbackMessage);
            return;
        }

        playNow(toAudioTrack(item));
    };

    const handleStartRadio = async () => {
        try {
            toast.info("Starting playlist radio...");
            const response = await api.getRadioTracks("playlist", playlistId);
            if (response.tracks && response.tracks.length > 0) {
                const tracks = response.tracks.map((t: Record<string, unknown>) => ({
                    id: t.id as string,
                    title: t.title as string,
                    artist: t.artist as { name: string; id?: string },
                    album: t.album as { title: string; coverArt?: string; id?: string },
                    duration: t.duration as number,
                }));
                playTracks(tracks, 0);
                toast.success(`Playing ${tracks.length} radio tracks`);
            } else {
                toast.error("No radio tracks found for this playlist");
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to start playlist radio:", error);
            toast.error("Failed to start playlist radio");
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!playlist) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-500">Playlist not found</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Compact Hero - Spotify Style */}
            <div className="relative bg-gradient-to-b from-[#3d2a1e] via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {coverUrls && coverUrls.length > 0 ? (
                            <div className="grid grid-cols-2 gap-0 w-full h-full">
                                {coverUrls
                                    .slice(0, 4)
                                    .map(
                                        (
                                            url: string | undefined,
                                            index: number
                                        ) => {
                                            if (!url) return null;
                                            const proxiedUrl =
                                                api.getCoverArtUrl(url, 200);
                                            return (
                                                <div
                                                    key={index}
                                                    className="relative bg-[#181818]"
                                                >
                                                    <Image
                                                        src={proxiedUrl}
                                                        alt=""
                                                        fill
                                                        className="object-cover"
                                                        sizes="96px"
                                                        unoptimized
                                                    />
                                                </div>
                                            );
                                        }
                                    )}
                                {Array.from({
                                    length: Math.max(
                                        0,
                                        4 - (coverUrls?.length || 0)
                                    ),
                                }).map((_, index) => (
                                    <div
                                        key={`empty-${index}`}
                                        className="relative bg-[#282828]"
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="w-full h-full bg-[#282828]" />
                        )}
                    </div>

                    {/* Playlist Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">
                            {isShared ? "Public Playlist" : "Playlist"}
                        </p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {playlist.name}
                        </h1>
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            {isShared && playlist.user?.username && (
                                <>
                                    <span className="font-medium text-white">
                                        {playlist.user.username}
                                    </span>
                                    <span className="mx-1">•</span>
                                </>
                            )}
                            <span>{trackItems.length} songs</span>
                            <span className="mx-1">•</span>
                            <span>
                                {providerCounts.local} local /{" "}
                                {providerCounts.tidal} TIDAL /{" "}
                                {providerCounts.youtube} YouTube
                            </span>
                            {totalDuration > 0 && (
                                <>
                                    <span>
                                        , {formatTotalDuration(totalDuration)}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {/* Play Button */}
                    {trackItems.length > 0 && (
                        <button
                            onClick={handlePlayPlaylist}
                            className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#60a5fa] hover:bg-[#3b82f6] hover:scale-105 shadow-lg transition-all font-semibold text-sm text-black"
                        >
                            {showPlaySpinner ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : isThisPlaylistPlaying && isPlaying ? (
                                <Pause className="w-5 h-5 fill-current" />
                            ) : (
                                <Play className="w-5 h-5 fill-current ml-0.5" />
                            )}
                            <span>{isThisPlaylistPlaying && isPlaying ? "Pause" : "Play All"}</span>
                        </button>
                    )}

                    {/* Shuffle Button */}
                    {playableTracks.length > 1 && (
                        <button
                            onClick={() => {
                                if (playableTracks.length === 0) return;
                                // Shuffle the tracks
                                const shuffled = shuffleArray(playableTracks);
                                playTracks(shuffled, 0);
                            }}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    {/* Radio Button */}
                    {trackItems.length > 0 && (
                        <button
                            onClick={handleStartRadio}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Start playlist radio"
                        >
                            <Radio className="w-5 h-5" />
                        </button>
                    )}

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Hide Button */}
                    <button
                        onClick={handleToggleHide}
                        disabled={isHiding}
                        className={cn(
                            "h-8 w-8 rounded-full flex items-center justify-center transition-all",
                            playlist.isHidden
                                ? "text-[#3b82f6] hover:text-[#2563eb]"
                                : "text-white/40 hover:text-white",
                            isHiding && "opacity-50 cursor-not-allowed"
                        )}
                        title={
                            playlist.isHidden
                                ? "Show playlist"
                                : "Hide playlist"
                        }
                    >
                        {playlist.isHidden ? (
                            <Eye className="w-5 h-5" />
                        ) : (
                            <EyeOff className="w-5 h-5" />
                        )}
                    </button>

                    {/* Delete Button */}
                    {playlist.isOwner && (
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="h-8 w-8 rounded-full flex items-center justify-center text-white/40 hover:text-red-400 transition-all"
                            title="Delete Playlist"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-2 md:px-8 pb-32">
                {/* Show failed/pending count if any */}
                {playlist.pendingCount > 0 && (
                    <div className="mb-4 px-4 py-2 bg-red-900/20 border border-red-500/30 rounded-lg flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <span className="text-sm text-red-200">
                            {playlist.pendingCount} track
                            {playlist.pendingCount !== 1 ? "s" : ""} failed to
                            download - will auto-import when available
                        </span>
                    </div>
                )}

                {unplayableTrackItems.length > 0 && (
                    <div className="mb-4 px-4 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-300" />
                        <span className="text-sm text-amber-100">
                            {unplayableTrackItems.length} track
                            {unplayableTrackItems.length !== 1 ? "s are" : " is"}{" "}
                            currently not playable.{" "}
                            {unplayableTrackItems[0]?.playback?.message ||
                                "Open track details or re-import to restore playback."}
                        </span>
                    </div>
                )}

                {trackItems.length > 0 ||
                playlist.pendingTracks?.length > 0 ? (
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span />
                        </div>

                        {/* Track Rows - use mergedItems to show tracks and pending in correct order */}
                        <div>
                            {(playlist.mergedItems || playlist.items || []).map(
                                (
                                    item: PlaylistItem | PendingTrack,
                                    index: number
                                ) => {
                                    // Handle pending/failed tracks
                                    if (item.type === "pending") {
                                        const pending = (item as PendingTrack)
                                            .pending;
                                        const isPreviewPlaying =
                                            playingPreviewId === pending.id;
                                        const isRetrying =
                                            retryingTrackId === pending.id;
                                        const isRemoving =
                                            removingTrackId === pending.id;

                                        return (
                                            <div
                                                key={`pending-${pending.id}`}
                                                className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_120px] gap-4 px-4 py-2 rounded-md opacity-60 hover:opacity-80 group transition-opacity"
                                            >
                                                {/* Track Number - failed icon */}
                                                <div className="flex items-center justify-center">
                                                    <AlertCircle className="w-4 h-4 text-red-400" />
                                                </div>

                                                {/* Title + Artist */}
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden flex items-center justify-center">
                                                        <button
                                                            onClick={() =>
                                                                handlePlayPreview(
                                                                    pending.id
                                                                )
                                                            }
                                                            className="w-full h-full flex items-center justify-center hover:bg-white/10 transition-colors"
                                                            title="Play 30s Deezer preview"
                                                        >
                                                            {isPreviewPlaying ? (
                                                                <Volume2 className="w-5 h-5 text-[#3b82f6] animate-pulse" />
                                                            ) : (
                                                                <Play className="w-5 h-5 text-gray-400 hover:text-white" />
                                                            )}
                                                        </button>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium truncate text-gray-400">
                                                            {pending.title}
                                                        </p>
                                                        <p className="text-xs text-gray-500 truncate">
                                                            {pending.artist}
                                                        </p>
                                                    </div>
                                                </div>

                                                {/* Album (hidden on mobile) */}
                                                <p className="hidden md:flex items-center text-sm text-gray-500 truncate">
                                                    {pending.album}
                                                </p>

                                                {/* Actions: Retry + Remove */}
                                                <div className="flex items-center justify-end gap-1">
                                                    <span className="text-xs text-red-400 mr-2 hidden sm:inline">
                                                        Failed
                                                    </span>
                                                    {/* Retry button */}
                                                    {downloadsEnabled && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRetryPendingTrack(
                                                                pending.id
                                                            );
                                                        }}
                                                        disabled={isRetrying}
                                                        className={cn(
                                                            "p-1.5 rounded-full hover:bg-white/10 transition-all",
                                                            isRetrying
                                                                ? "text-[#3b82f6]"
                                                                : "text-gray-400 hover:text-white"
                                                        )}
                                                        title="Retry download"
                                                    >
                                                        {isRetrying ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            <RefreshCw className="w-4 h-4" />
                                                        )}
                                                    </button>
                                                    )}
                                                    {/* Remove button */}
                                                    {playlist.isOwner && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRemovePendingTrack(
                                                                    pending.id
                                                                );
                                                            }}
                                                            disabled={
                                                                isRemoving
                                                            }
                                                            className="p-1.5 rounded-full hover:bg-white/10 text-gray-400 hover:text-red-400 transition-all"
                                                            title="Remove from playlist"
                                                        >
                                                            {isRemoving ? (
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <X className="w-4 h-4" />
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    }

                                    // Handle regular tracks
                                    const playlistItem = item as PlaylistItem;
                                    const track = playlistItem.track;
                                    const isPlayable =
                                        isPlayableTrackItem(playlistItem);
                                    const isCurrentlyPlaying =
                                        isPlayable &&
                                        currentTrack?.id === track?.id;
                                    const isInQueue =
                                        isPlayable &&
                                        Boolean(track) &&
                                        queuedTrackIds.has(track.id);
                                    const trackDisplayIndex =
                                        trackDisplayIndexByItemId.get(
                                            playlistItem.id
                                        ) ?? index + 1;
                                    const providerSource =
                                        playlistItem.provider?.source ||
                                        track?.streamSource ||
                                        "local";
                                    const fallbackMessage =
                                        playlistItem.playback?.message ||
                                        "Playback is unavailable for this track right now.";
                                    const localTrackId =
                                        typeof playlistItem.trackId ===
                                            "string" &&
                                        playlistItem.trackId.length > 0
                                            ? playlistItem.trackId
                                            : isLocalPlayableTrackItem(
                                                  playlistItem
                                              )
                                            ? track?.id || null
                                            : null;
                                    const canShowLocalActions =
                                        Boolean(localTrackId) &&
                                        isLocalPlayableTrackItem(playlistItem);

                                    return (
                                        <div
                                            key={playlistItem.id}
                                            onClick={() => {
                                                if (isPlayable) {
                                                    handlePlayTrack(
                                                        playlistItem.id
                                                    );
                                                    return;
                                                }
                                                toast.error(fallbackMessage);
                                            }}
                                            className={cn(
                                                "grid grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-2 px-1 md:gap-4 md:px-4 py-2 rounded-md transition-colors group",
                                                isPlayable
                                                    ? "hover:bg-white/5 cursor-pointer"
                                                    : "bg-amber-500/[0.06] hover:bg-amber-500/[0.1] cursor-not-allowed",
                                                isCurrentlyPlaying &&
                                                    "bg-white/10",
                                                isInQueue &&
                                                    !isCurrentlyPlaying &&
                                                    "bg-[#3b82f6]/[0.06]"
                                            )}
                                        >
                                            {/* Track Number / Play Icon */}
                                            <div className="flex items-center justify-center">
                                                {isPlayable ? (
                                                    <>
                                                        <span
                                                            className={cn(
                                                                "text-sm group-hover:hidden",
                                                                isCurrentlyPlaying
                                                                    ? "text-[#3b82f6]"
                                                                    : "text-gray-400"
                                                            )}
                                                        >
                                                            {isCurrentlyPlaying &&
                                                            isPlaying ? (
                                                                <Music className="w-4 h-4 text-[#3b82f6] animate-pulse" />
                                                            ) : (
                                                                trackDisplayIndex
                                                            )}
                                                        </span>
                                                        <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                    </>
                                                ) : (
                                                    <span title={fallbackMessage}>
                                                        <AlertCircle className="w-4 h-4 text-amber-300" />
                                                    </span>
                                                )}
                                            </div>

                                            {/* Title + Artist */}
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                    {track?.album?.coverArt ? (
                                                        <Image
                                                            src={api.getCoverArtUrl(
                                                                track.album
                                                                    .coverArt,
                                                                100
                                                            )}
                                                            alt={
                                                                track.title ||
                                                                "Track cover"
                                                            }
                                                            fill
                                                            sizes="40px"
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Music className="w-5 h-5 text-gray-600" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <p
                                                        className={cn(
                                                            "text-sm font-medium flex items-center gap-2 min-w-0",
                                                            isCurrentlyPlaying
                                                                ? "text-[#3b82f6]"
                                                                : "text-white"
                                                        )}
                                                    >
                                                        <span className="truncate">
                                                            {track?.title ||
                                                                "Unavailable track"}
                                                        </span>
                                                    </p>
                                                    <p className="text-xs text-gray-400 truncate">
                                                        {track?.album?.artist
                                                            ?.name ||
                                                            "Unknown Artist"}
                                                    </p>
                                                    <div className="mt-1 flex items-center gap-1.5">
                                                        {providerSource ===
                                                        "tidal" ? (
                                                            <TidalBadge className="text-[9px] px-1 py-0.5 leading-none" />
                                                        ) : providerSource ===
                                                          "youtube" ? (
                                                            <YouTubeBadge className="text-[9px] px-1 py-0.5 leading-none" />
                                                        ) : providerSource ===
                                                          "local" ? (
                                                            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide bg-gray-700/50 text-gray-200 px-1 py-0.5 rounded">
                                                                Local
                                                            </span>
                                                        ) : (
                                                            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide bg-amber-500/20 text-amber-200 px-1 py-0.5 rounded border border-amber-500/40">
                                                                Unknown source
                                                            </span>
                                                        )}
                                                        {!isPlayable && (
                                                            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide bg-amber-500/20 text-amber-200 px-1 py-0.5 rounded border border-amber-500/40">
                                                                Unplayable
                                                            </span>
                                                        )}
                                                        {isInQueue && (
                                                            <span className="shrink-0 text-[10px] bg-[#3b82f6]/15 text-[#93c5fd] px-1.5 py-0.5 rounded border border-[#3b82f6]/30 font-medium">
                                                                IN QUEUE
                                                            </span>
                                                        )}
                                                    </div>
                                                    {!isPlayable && (
                                                        <p className="text-[11px] text-amber-200/90 truncate mt-1">
                                                            {fallbackMessage}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Album (hidden on mobile) */}
                                            <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                                {track?.album?.title ||
                                                    "Unavailable"}
                                            </p>

                                            {/* Duration + Actions */}
                                            <div className="flex items-center justify-end gap-1">
                                                <span className="hidden sm:inline text-xs text-gray-500 w-10 text-right tabular-nums">
                                                    {track?.duration
                                                        ? formatTime(
                                                              track.duration
                                                          )
                                                        : "--:--"}
                                                </span>
                                                {canShowLocalActions && (
                                                    <>
                                                        <TrackPreferenceButtons
                                                            trackId={localTrackId!}
                                                            mode="both"
                                                            buttonSizeClassName="h-8 w-8"
                                                            iconSizeClassName="h-4 w-4"
                                                        />
                                                        <TrackOverflowMenu
                                                            track={{
                                                                id: localTrackId!,
                                                                title:
                                                                    track?.title ||
                                                                    "Unknown title",
                                                                artist: {
                                                                    name: track
                                                                        ?.album
                                                                        ?.artist
                                                                        ?.name ||
                                                                        "Unknown Artist",
                                                                    id: track
                                                                        ?.album
                                                                        ?.artist
                                                                        ?.id,
                                                                },
                                                                album: {
                                                                    title: track
                                                                        ?.album
                                                                        ?.title ||
                                                                        "Unknown Album",
                                                                    coverArt:
                                                                        track
                                                                            ?.album
                                                                            ?.coverArt ||
                                                                        undefined,
                                                                    id: track
                                                                        ?.album
                                                                        ?.id,
                                                                },
                                                                duration:
                                                                    track?.duration ||
                                                                    0,
                                                            }}
                                                            extraItemsAfter={
                                                                playlist.isOwner ? (
                                                                    <TrackMenuButton
                                                                        onClick={(
                                                                            e
                                                                        ) => {
                                                                            e.stopPropagation();
                                                                            handleRemoveTrack(
                                                                                localTrackId!
                                                                            );
                                                                        }}
                                                                        icon={
                                                                            <Trash2 className="h-4 w-4" />
                                                                        }
                                                                        label="Remove from playlist"
                                                                        className="text-red-400 hover:text-red-300"
                                                                    />
                                                                ) : undefined
                                                            }
                                                        />
                                                    </>
                                                )}
                                                {!isPlayable && (
                                                    <span className="text-[11px] text-amber-200">
                                                        Cannot play
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                }
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <ListMusic className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            No tracks yet
                        </h3>
                        <p className="text-sm text-gray-500">
                            Add some tracks to get started
                        </p>
                    </div>
                )}
            </div>

            {/* Confirm Dialog */}
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDeletePlaylist}
                title="Delete Playlist?"
                message={`Are you sure you want to delete "${playlist.name}"? This action cannot be undone.`}
                confirmText="Delete"
                cancelText="Cancel"
                variant="danger"
            />
        </div>
    );
}
