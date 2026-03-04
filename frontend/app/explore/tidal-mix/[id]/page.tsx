"use client";

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
    ArrowLeft,
    Play,
    Pause,
    Music2,
    ListMusic,
    Shuffle,
    Plus,
    Heart,
    Loader2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAudioState, type Track } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { useCollectionLikeAll } from "@/hooks/useCollectionLikeAll";
import type { LikeableTrack } from "@/hooks/useCollectionLikeAll";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { shuffleArray } from "@/utils/shuffle";
import { cn } from "@/utils/cn";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { TrackList, TrackListHeader } from "@/components/track";
import type { TrackRowItem, TrackRowSlots, OverflowConfig } from "@/components/track";

// -- Types -------------------------------------------------------------------

interface TidalBrowseTrack {
    trackId: number;
    title: string;
    artist: string;
    artists: string[];
    album: string;
    duration: number;
    isrc: string | null;
    thumbnailUrl: string | null;
}

interface TidalBrowseMix {
    id: string;
    title: string;
    trackCount: number;
    thumbnailUrl: string | null;
    tracks: TidalBrowseTrack[];
}

// -- Helpers -----------------------------------------------------------------

function browseTrackToQueueTrack(t: TidalBrowseTrack): Track {
    return {
        id: `tidal:${t.trackId}`,
        title: t.title,
        artist: { name: t.artist },
        album: { title: t.album, coverArt: t.thumbnailUrl || undefined },
        duration: t.duration,
        streamSource: "tidal",
        tidalTrackId: t.trackId,
    };
}

function decodeRouteId(id: string): string {
    try {
        return decodeURIComponent(id);
    } catch {
        return id;
    }
}

function browseToRowItem(track: TidalBrowseTrack): TrackRowItem {
    return {
        id: `tidal:${track.trackId}`,
        title: track.title,
        artistName: track.artist,
        duration: track.duration,
        coverArtUrl: track.thumbnailUrl ? api.getTidalBrowseImageUrl(track.thumbnailUrl) : null,
    };
}

function BrowseTrackList({ tracks, onPlayTrack }: { tracks: TidalBrowseTrack[]; onPlayTrack: (index: number) => void }) {
    const handlePlay = useCallback(
        (_track: TidalBrowseTrack, index: number) => {
            if (tracks[index]?.trackId) {
                onPlayTrack(index);
            }
        },
        [tracks, onPlayTrack],
    );

    const rowSlots = useCallback(
        (track: TidalBrowseTrack): TrackRowSlots => ({
            titleBadges: <TidalBadge />,
            middleColumns: (
                <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                    {track.album}
                </p>
            ),
            rowClassName: !track.trackId ? "opacity-60 cursor-not-allowed" : undefined,
        }),
        [],
    );

    const rowOverflow = useCallback(
        (track: TidalBrowseTrack): OverflowConfig | null => {
            if (!track.trackId) return null;
            return {
                track: browseTrackToQueueTrack(track),
                showGoToArtist: false,
                showGoToAlbum: false,
                showMatchVibe: false,
                showStartRadio: false,
            };
        },
        [],
    );

    return (
        <div className="w-full">
            <TrackList
                items={tracks}
                toRowItem={browseToRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowOverflow={rowOverflow}
                rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                accentColor="#00BFFF"
                preferenceMode="up-only"
                header={
                    <TrackListHeader
                        className="grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4 mb-2"
                        columns={[
                            { label: "#", className: "text-center" },
                            { label: "Title" },
                            { label: "Album" },
                            { label: "" },
                        ]}
                    />
                }
            />
        </div>
    );
}

/**
 * Renders the TidalMixDetailPage component.
 */
export default function TidalMixDetailPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <GradientSpinner size="lg" />
                </div>
            }
        >
            <TidalMixDetailPageContent />
        </Suspense>
    );
}

function TidalMixDetailPageContent() {
    const params = useParams();
    const router = useRouter();
    const { toast } = useToast();
    const mixId = decodeRouteId(params.id as string);

    // Audio context
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, playNow, addTracksToQueue, pause, resume } = useAudioControls();

    // State
    const [mix, setMix] = useState<TidalBrowseMix | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } = usePlayButtonFeedback();

    // Fetch mix data
    useEffect(() => {
        let isActive = true;

        async function fetchMix() {
            setIsLoading(true);
            setError(null);
            setMix(null);

            try {
                const data = await api.getTidalBrowseMix(mixId);
                if (isActive) {
                    setMix(data);
                }
            } catch (fetchError) {
                const message =
                    fetchError instanceof Error
                        ? fetchError.message
                        : "Failed to load mix";
                if (isActive) {
                    setError(message);
                }
            } finally {
                if (isActive) {
                    setIsLoading(false);
                }
            }
        }

        fetchMix();

        return () => {
            isActive = false;
        };
    }, [mixId]);

    // Check if the current queue is this browse mix
    const isThisMixPlaying =
        currentTrack?.id?.startsWith("tidal:") &&
        mix?.tracks.some((t) => `tidal:${t.trackId}` === currentTrack?.id);

    // Play entire mix
    const handlePlayAll = (startIndex: number = 0) => {
        if (!mix) return;
        const tracks = mix.tracks
            .filter((t) => t.trackId)
            .map(browseTrackToQueueTrack);
        if (tracks.length === 0) {
            toast.error("No playable tracks in this mix");
            return;
        }
        playTracks(tracks, startIndex);
    };

    // Toggle play/pause for header button
    const handleTogglePlay = () => {
        if (isThisMixPlaying && isPlaying) {
            pause();
        } else if (isThisMixPlaying) {
            resume();
        } else {
            triggerPlayFeedback();
            handlePlayAll(0);
        }
    };

    // Likeable tracks for Like All
    const likeableTracks: LikeableTrack[] = useMemo(
        () => (mix?.tracks || [])
            .filter((t) => t.trackId)
            .map((t) => ({
                id: `tidal:${t.trackId}`,
                title: t.title,
                artist: t.artist,
                album: t.album,
                duration: t.duration,
                thumbnailUrl: t.thumbnailUrl || undefined,
            })),
        [mix?.tracks]
    );
    const { isAllLiked, isApplying: isApplyingLikeAll, toggleLikeAll } = useCollectionLikeAll(likeableTracks);

    // Add all to queue
    const handleAddToQueue = () => {
        if (!mix) return;
        const tracks = mix.tracks
            .filter((t) => t.trackId)
            .map(browseTrackToQueueTrack);
        if (tracks.length === 0) return;
        addTracksToQueue(tracks);
        toast.success(`Added ${tracks.length} tracks to queue`);
    };

    // Shuffle play
    const handleShuffle = () => {
        if (!mix) return;
        const tracks = mix.tracks
            .filter((t) => t.trackId)
            .map(browseTrackToQueueTrack);
        if (tracks.length < 2) return;
        playTracks(shuffleArray(tracks), 0);
    };

    // Add all to playlist
    const handlePlaylistSelected = async (targetPlaylistId: string) => {
        if (!mix?.tracks.length) return;
        setIsAddingToPlaylist(true);
        try {
            for (const track of mix.tracks) {
                if (!track.trackId) continue;
                await api.addTrackToPlaylist(targetPlaylistId, toAddToPlaylistRef({
                    id: `tidal:${track.trackId}`,
                    title: track.title,
                    artist: track.artist,
                    album: track.album,
                    duration: track.duration,
                    streamSource: "tidal",
                    tidalTrackId: track.trackId,
                    thumbnailUrl: track.thumbnailUrl || undefined,
                }));
            }
            toast.success(`Added ${mix.tracks.length} tracks to playlist`);
            setShowPlaylistSelector(false);
        } catch (addError) {
            sharedFrontendLogger.error("Failed to add tracks to playlist:", addError);
            toast.error("Failed to add some tracks to playlist");
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    // Play a specific track -- insert next in queue and play immediately
    const handlePlayTrack = (index: number) => {
        if (!mix) return;
        const track = mix.tracks[index];
        if (!track?.trackId) return;

        // If clicking the currently playing track, toggle
        if (currentTrack?.id === `tidal:${track.trackId}`) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        // Insert next in queue and play immediately
        playNow(browseTrackToQueueTrack(track));
    };

    // Total duration
    const totalDuration = mix?.tracks.reduce(
        (sum, track) => sum + track.duration,
        0
    ) || 0;

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error || !mix) {
        return (
            <div className="min-h-screen relative">
                <div className="absolute inset-0 pointer-events-none">
                    <div
                        className="absolute inset-0 bg-gradient-to-b from-[#00BFFF]/15 via-[#00BFFF]/10 to-transparent"
                        style={{ height: "35vh" }}
                    />
                </div>
                <div className="relative px-4 md:px-8 py-6">
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-8"
                    >
                        <ArrowLeft className="w-5 h-5" />
                        Back
                    </button>
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music2 className="w-8 h-8 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-2">
                            Mix not found
                        </h3>
                        <p className="text-sm text-gray-400 mb-6 max-w-sm">
                            {error || "This mix may be private or no longer available."}
                        </p>
                        <button
                            onClick={() => router.push("/explore")}
                            className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                        >
                            Explore playlists
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Hero Section */}
            <div className="relative bg-gradient-to-b from-[#00BFFF]/20 via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="relative w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {mix.thumbnailUrl ? (
                            <Image
                                src={api.getTidalBrowseImageUrl(mix.thumbnailUrl)}
                                alt={mix.title}
                                fill
                                sizes="(max-width: 768px) 140px, 192px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#00BFFF]/30 to-[#00BFFF]/10">
                                <Music2 className="w-16 h-16 text-gray-600" />
                            </div>
                        )}
                    </div>

                    {/* Mix Info */}
                    <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 mb-1">
                            <svg viewBox="0 0 12 8" className="w-4 h-4 text-[#00BFFF]" fill="currentColor">
                                <path d="M2 0 L4 2 L2 4 L0 2Z" />
                                <path d="M6 0 L8 2 L6 4 L4 2Z" />
                                <path d="M10 0 L12 2 L10 4 L8 2Z" />
                                <path d="M6 4 L8 6 L6 8 L4 6Z" />
                            </svg>
                            <p className="text-xs font-medium text-white/90">
                                TIDAL Mix
                            </p>
                        </div>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {mix.title}
                        </h1>
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            <span>{mix.trackCount} songs</span>
                            {totalDuration > 0 && (
                                <span>, {formatTotalDuration(totalDuration)}</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {/* Play Button (cyan) */}
                    <button
                        onClick={handleTogglePlay}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#00BFFF] hover:bg-[#00BFFF]/80 hover:scale-105 shadow-lg transition-all font-semibold text-sm text-white"
                    >
                        {showPlaySpinner ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                        ) : isThisMixPlaying && isPlaying ? (
                            <Pause className="w-5 h-5 fill-current" />
                        ) : (
                            <Play className="w-5 h-5 fill-current ml-0.5" />
                        )}
                        <span>{isThisMixPlaying && isPlaying ? "Pause" : "Play All"}</span>
                    </button>

                    {/* Shuffle */}
                    {mix && mix.tracks.length > 1 && (
                        <button
                            onClick={handleShuffle}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    {/* Add to Queue */}
                    <button
                        onClick={handleAddToQueue}
                        className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title="Add all to queue"
                    >
                        <ListMusic className="w-5 h-5" />
                    </button>

                    {/* Add to Playlist */}
                    <button
                        onClick={() => setShowPlaylistSelector(true)}
                        className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title="Add all to playlist"
                    >
                        <Plus className="w-5 h-5" />
                    </button>

                    {/* Like All */}
                    {likeableTracks.length > 0 && (
                        <button
                            onClick={toggleLikeAll}
                            disabled={isApplyingLikeAll}
                            className={cn(
                                "h-8 w-8 rounded-full flex items-center justify-center transition-all",
                                isApplyingLikeAll
                                    ? "cursor-not-allowed text-white/35"
                                    : isAllLiked
                                        ? "text-[#3b82f6] hover:bg-white/10"
                                        : "text-white/60 hover:bg-white/10 hover:text-white"
                            )}
                            title={isAllLiked ? "Unlike all tracks" : "Like all tracks"}
                        >
                            {isApplyingLikeAll ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Heart className={cn("h-4 w-4", isAllLiked && "fill-current")} />
                            )}
                        </button>
                    )}

                    <div className="flex-1" />

                    {/* Back button */}
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        <span className="hidden sm:inline">Back</span>
                    </button>
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-2 md:px-8 pb-32">
                {mix.tracks.length > 0 ? (
                    <BrowseTrackList
                        tracks={mix.tracks}
                        onPlayTrack={handlePlayTrack}
                    />
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <Music2 className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            No tracks found
                        </h3>
                        <p className="text-sm text-gray-500">
                            This mix appears to be empty
                        </p>
                    </div>
                )}
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => setShowPlaylistSelector(false)}
                onSelectPlaylist={handlePlaylistSelected}
                isLoading={isAddingToPlaylist}
                loadingMessage="Adding tracks..."
            />
        </div>
    );
}
