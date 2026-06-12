"use client";

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
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
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackList, TrackListHeader } from "@/components/track";
import type { TrackRowItem, TrackRowSlots, OverflowConfig } from "@/components/track";

// ── Types ──────────────────────────────────────────────────────

interface YtMusicBrowseTrack {
    videoId: string;
    title: string;
    artist: string;
    artists: string[];
    album: string;
    duration: number; // seconds
    thumbnailUrl: string | null;
}

interface YtMusicBrowsePlaylist {
    id: string;
    title: string;
    description: string;
    trackCount: number;
    thumbnailUrl: string | null;
    tracks: YtMusicBrowseTrack[];
    source: string;
}

interface YtMusicSongResponse {
    videoId?: string;
    title?: string;
    artist?: string;
    artists?: Array<string | { name?: string }>;
    album?: string | { title?: string; name?: string };
    duration?: number;
    duration_seconds?: number;
    thumbnailUrl?: string | null;
    thumbnails?: Array<{ url?: string }>;
}

// ── Helpers ────────────────────────────────────────────────────

function browseTrackToQueueTrack(t: YtMusicBrowseTrack): Track {
    return {
        id: `yt:${t.videoId}`,
        title: t.title,
        artist: { name: t.artist },
        album: { title: t.album, coverArt: t.thumbnailUrl || undefined },
        duration: t.duration,
        streamSource: "youtube",
        youtubeVideoId: t.videoId,
    };
}

function decodeRouteId(id: string): string {
    try {
        return decodeURIComponent(id);
    } catch {
        return id;
    }
}

function isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybeError = error as { status?: number; message?: string };
    if (maybeError.status === 404) return true;
    if (typeof maybeError.message === "string") {
        return maybeError.message.toLowerCase().includes("not found");
    }
    return false;
}

function resolveSongArtist(song: YtMusicSongResponse): string {
    if (typeof song.artist === "string" && song.artist.trim()) {
        return song.artist.trim();
    }

    if (Array.isArray(song.artists)) {
        for (const artist of song.artists) {
            if (typeof artist === "string" && artist.trim()) {
                return artist.trim();
            }
            if (
                artist &&
                typeof artist === "object" &&
                typeof artist.name === "string" &&
                artist.name.trim()
            ) {
                return artist.name.trim();
            }
        }
    }

    return "Unknown Artist";
}

function resolveSongAlbum(song: YtMusicSongResponse): string {
    if (typeof song.album === "string" && song.album.trim()) {
        return song.album.trim();
    }
    if (
        song.album &&
        typeof song.album === "object" &&
        typeof song.album.title === "string" &&
        song.album.title.trim()
    ) {
        return song.album.title.trim();
    }
    if (
        song.album &&
        typeof song.album === "object" &&
        typeof song.album.name === "string" &&
        song.album.name.trim()
    ) {
        return song.album.name.trim();
    }
    return "Single";
}

function resolveSongDuration(song: YtMusicSongResponse): number {
    if (typeof song.duration_seconds === "number" && song.duration_seconds > 0) {
        return Math.floor(song.duration_seconds);
    }
    if (typeof song.duration === "number" && song.duration > 0) {
        return Math.floor(song.duration);
    }
    return 0;
}

function resolveSongThumbnail(song: YtMusicSongResponse): string | null {
    if (typeof song.thumbnailUrl === "string" && song.thumbnailUrl.trim()) {
        return song.thumbnailUrl;
    }

    if (Array.isArray(song.thumbnails)) {
        for (const thumbnail of song.thumbnails) {
            if (typeof thumbnail?.url === "string" && thumbnail.url.trim()) {
                return thumbnail.url;
            }
        }
    }

    return null;
}

function buildSingleTrackPlaylist(
    song: YtMusicSongResponse,
    fallbackVideoId: string
): YtMusicBrowsePlaylist {
    const videoId =
        typeof song.videoId === "string" && song.videoId.trim()
            ? song.videoId.trim()
            : fallbackVideoId;
    const title =
        typeof song.title === "string" && song.title.trim()
            ? song.title.trim()
            : "YouTube Music Track";
    const artist = resolveSongArtist(song);
    const album = resolveSongAlbum(song);
    const duration = resolveSongDuration(song);
    const thumbnailUrl = resolveSongThumbnail(song);

    return {
        id: videoId,
        title,
        description: `Chart track by ${artist}`,
        trackCount: 1,
        thumbnailUrl,
        tracks: [
            {
                videoId,
                title,
                artist,
                artists: [artist],
                album,
                duration,
                thumbnailUrl,
            },
        ],
        source: "ytmusic",
    };
}

function browseToRowItem(track: YtMusicBrowseTrack): TrackRowItem {
    return {
        id: `yt:${track.videoId}`,
        title: track.title,
        artistName: track.artist,
        duration: track.duration,
        coverArtUrl: track.thumbnailUrl ? api.getBrowseImageUrl(track.thumbnailUrl) : null,
    };
}

function BrowseTrackList({ tracks, onPlayTrack }: { tracks: YtMusicBrowseTrack[]; onPlayTrack: (index: number) => void }) {
    const handlePlay = useCallback(
        (_track: YtMusicBrowseTrack, index: number) => {
            if (tracks[index]?.videoId) {
                onPlayTrack(index);
            }
        },
        [tracks, onPlayTrack],
    );

    const rowSlots = useCallback(
        (track: YtMusicBrowseTrack): TrackRowSlots => ({
            titleBadges: <YouTubeBadge />,
            middleColumns: (
                <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                    {track.album}
                </p>
            ),
            rowClassName: !track.videoId ? "opacity-60 cursor-not-allowed" : undefined,
        }),
        [],
    );

    const rowOverflow = useCallback(
        (track: YtMusicBrowseTrack): OverflowConfig | null => {
            if (!track.videoId) return null;
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
                accentColor="#ef4444"
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
 * Renders the YtMusicPlaylistDetailPage component.
 */
export default function YtMusicPlaylistDetailPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <GradientSpinner size="lg" />
                </div>
            }
        >
            <YtMusicPlaylistDetailPageContent />
        </Suspense>
    );
}

function YtMusicPlaylistDetailPageContent() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const playlistId = decodeRouteId(params.id as string);
    const isAlbumType =
        searchParams.get("type") === "album" ||
        playlistId.startsWith("MPREb_");

    // Audio context
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, playNow, addTracksToQueue, pause, resume } = useAudioControls();

    // State
    const [playlist, setPlaylist] = useState<YtMusicBrowsePlaylist | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } = usePlayButtonFeedback();

    // Fetch playlist data
    useEffect(() => {
        let isActive = true;

        async function fetchPlaylist() {
            setIsLoading(true);
            setError(null);
            setPlaylist(null);

            try {
                const endpoint = isAlbumType
                    ? `/browse/ytmusic/album/${encodeURIComponent(playlistId)}`
                    : `/browse/ytmusic/playlist/${encodeURIComponent(playlistId)}`;
                const data = await api.get<YtMusicBrowsePlaylist>(endpoint);
                if (isActive) {
                    setPlaylist(data);
                }
            } catch (playlistError) {
                if (isNotFoundError(playlistError)) {
                    try {
                        const song = await api.getYtMusicSong(playlistId);
                        if (isActive) {
                            setPlaylist(
                                buildSingleTrackPlaylist(
                                    song as YtMusicSongResponse,
                                    playlistId
                                )
                            );
                        }
                        return;
                    } catch {
                        // Fall through and surface the original playlist error below.
                    }
                }

                const message =
                    playlistError instanceof Error
                        ? playlistError.message
                        : "Failed to load playlist";
                if (isActive) {
                    setError(message);
                }
            } finally {
                if (isActive) {
                    setIsLoading(false);
                }
            }
        }

        fetchPlaylist();

        return () => {
            isActive = false;
        };
    }, [playlistId, isAlbumType]);

    // Check if the current queue is this browse playlist
    const isThisPlaylistPlaying =
        currentTrack?.id?.startsWith("yt:") &&
        playlist?.tracks.some((t) => `yt:${t.videoId}` === currentTrack?.id);

    // Play entire playlist
    const handlePlayAll = (startIndex: number = 0) => {
        if (!playlist) return;
        const tracks = playlist.tracks
            .filter((t) => t.videoId)
            .map(browseTrackToQueueTrack);
        if (tracks.length === 0) {
            toast.error("No playable tracks in this playlist");
            return;
        }
        playTracks(tracks, startIndex);
    };

    // Toggle play/pause for header button
    const handleTogglePlay = () => {
        if (isThisPlaylistPlaying && isPlaying) {
            pause();
        } else if (isThisPlaylistPlaying) {
            resume();
        } else {
            triggerPlayFeedback();
            handlePlayAll(0);
        }
    };

    // Likeable tracks for Like All
    const likeableTracks: LikeableTrack[] = useMemo(
        () => (playlist?.tracks || [])
            .filter((t) => t.videoId)
            .map((t) => ({
                id: `yt:${t.videoId}`,
                title: t.title,
                artist: t.artist,
                album: t.album,
                duration: t.duration,
                thumbnailUrl: t.thumbnailUrl || undefined,
            })),
        [playlist?.tracks]
    );
    const { isAllLiked, isApplying: isApplyingLikeAll, toggleLikeAll } = useCollectionLikeAll(likeableTracks);

    // Add all to queue
    const handleAddToQueue = () => {
        if (!playlist) return;
        const tracks = playlist.tracks
            .filter((t) => t.videoId)
            .map(browseTrackToQueueTrack);
        if (tracks.length === 0) return;
        addTracksToQueue(tracks);
        toast.success(`Added ${tracks.length} tracks to queue`);
    };

    // Shuffle play
    const handleShuffle = () => {
        if (!playlist) return;
        const tracks = playlist.tracks
            .filter((t) => t.videoId)
            .map(browseTrackToQueueTrack);
        if (tracks.length < 2) return;
        playTracks(shuffleArray(tracks), 0);
    };

    // Add all to playlist
    const handlePlaylistSelected = async (playlistId: string) => {
        if (!playlist?.tracks.length) return;
        setIsAddingToPlaylist(true);
        try {
            for (const track of playlist.tracks) {
                if (!track.videoId) continue;
                await api.addTrackToPlaylist(playlistId, toAddToPlaylistRef({
                    id: `yt:${track.videoId}`,
                    title: track.title,
                    artist: track.artist,
                    album: track.album,
                    duration: track.duration,
                    streamSource: "youtube",
                    youtubeVideoId: track.videoId,
                    thumbnailUrl: track.thumbnailUrl || undefined,
                }));
            }
            toast.success(`Added ${playlist.tracks.length} tracks to playlist`);
            setShowPlaylistSelector(false);
        } catch (error) {
            sharedFrontendLogger.error("Failed to add tracks to playlist:", error);
            toast.error("Failed to add some tracks to playlist");
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    // Play a specific track — insert next in queue and play immediately
    const handlePlayTrack = (index: number) => {
        if (!playlist) return;
        const track = playlist.tracks[index];
        if (!track?.videoId) return;

        // If clicking the currently playing track, toggle
        if (currentTrack?.id === `yt:${track.videoId}`) {
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
    const totalDuration = playlist?.tracks.reduce(
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

    if (error || !playlist) {
        return (
            <div className="min-h-screen relative">
                <div className="absolute inset-0 pointer-events-none">
                    <div
                        className="absolute inset-0 bg-gradient-to-b from-red-600/15 via-red-900/10 to-transparent"
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
                            Playlist not found
                        </h3>
                        <p className="text-sm text-gray-400 mb-6 max-w-sm">
                            {error || "This playlist may be private or no longer available."}
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
            <div className="relative bg-gradient-to-b from-red-600/20 via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="relative w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {playlist.thumbnailUrl ? (
                            <Image
                                src={api.getBrowseImageUrl(playlist.thumbnailUrl)}
                                alt={playlist.title}
                                fill
                                sizes="(max-width: 768px) 140px, 192px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-red-500/30 to-red-500/10">
                                <Music2 className="w-16 h-16 text-gray-600" />
                            </div>
                        )}
                    </div>

                    {/* Playlist Info */}
                    <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 mb-1">
                            <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-500" fill="currentColor">
                                <path d="M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15V9l5.2 3-5.2 3z" />
                            </svg>
                            <p className="text-xs font-medium text-white/90">
                                YouTube Music Playlist
                            </p>
                        </div>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {playlist.title}
                        </h1>
                        {playlist.description && (
                            <p className="text-sm text-gray-400 line-clamp-2 mb-2">
                                {playlist.description}
                            </p>
                        )}
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            <span>{playlist.trackCount} songs</span>
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
                    {/* Play Button (red) */}
                    <button
                        onClick={handleTogglePlay}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-500 hover:bg-red-400 hover:scale-105 shadow-lg transition-all font-semibold text-sm text-white"
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

                    {/* Shuffle */}
                    {playlist && playlist.tracks.length > 1 && (
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
                {playlist.tracks.length > 0 ? (
                    <BrowseTrackList
                        tracks={playlist.tracks}
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
                            This playlist appears to be empty
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
