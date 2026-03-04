"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, ListMusic, Loader2, Music, Pause, Play, Plus, Radio, Shuffle } from "lucide-react";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import { createMosaicCandidates, selectMosaicCovers } from "@/utils/mosaicCoverSelection";
import {
    useAudioControls,
    useAudioPlayback,
    useAudioState,
} from "@/lib/audio-context";
import { api, type LikedPlaylistResponse, type LikedPlaylistTrack } from "@/lib/api";
import { queryKeys, useLikedPlaylistQuery } from "@/hooks/useQueries";
import { formatTime } from "@/utils/formatTime";
import { shuffleArray } from "@/utils/shuffle";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { useToast } from "@/lib/toast-context";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { toAudioTrack } from "./likedPlaylistUtils";
import { TrackList, TrackListHeader } from "@/components/track";
import type { TrackRowItem, TrackRowSlots } from "@/components/track";

const EMPTY_TRACKS: LikedPlaylistTrack[] = [];

/**
 * Resolves the best cover-art URL for a liked track by provider.
 */
export function resolveLikedTrackCoverUrl(
    track: LikedPlaylistTrack,
    size: number
): string | null {
    if (!track.album.coverArt) {
        return null;
    }
    if (track.streamSource === "tidal") {
        return api.getTidalBrowseImageUrl(track.album.coverArt);
    }
    if (track.streamSource === "youtube") {
        return api.getBrowseImageUrl(track.album.coverArt);
    }
    return api.getCoverArtUrl(track.album.coverArt, size);
}

function toRowItem(track: LikedPlaylistTrack): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        artistName: track.artist.name,
        duration: track.duration,
        coverArtUrl: resolveLikedTrackCoverUrl(track, 100),
    };
}

interface LikedTrackListProps {
    tracks: LikedPlaylistTrack[];
    likedTrackIds: Set<string>;
    removingTrackId: string | null;
    onPlay: (track: LikedPlaylistTrack) => void;
    onUnlike: (trackId: string) => void;
}

function LikedTrackList({ tracks, likedTrackIds, removingTrackId, onPlay, onUnlike }: LikedTrackListProps) {
    const handlePlay = useCallback(
        (track: LikedPlaylistTrack) => onPlay(track),
        [onPlay],
    );

    const rowSlots = useCallback(
        (track: LikedPlaylistTrack): TrackRowSlots => {
            const isRemote = track.streamSource === "youtube" || track.streamSource === "tidal";
            return {
                titleBadges: isRemote ? (
                    <>{track.streamSource === "tidal" ? <TidalBadge /> : <YouTubeBadge />}</>
                ) : undefined,
                middleColumns: (
                    <p className="hidden truncate text-sm text-gray-400 md:flex items-center">
                        {track.album.title}
                    </p>
                ),
                trailingActions: (
                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <span className="hidden sm:inline text-xs text-gray-500 w-10 text-right tabular-nums">
                            {formatTime(track.duration)}
                        </span>
                        <TrackPreferenceButtons
                            trackId={track.id}
                            mode="up-only"
                            resolveFromQuery={false}
                            signal={likedTrackIds.has(track.id) ? "thumbs_up" : "clear"}
                            isSaving={removingTrackId === track.id}
                            onToggleThumbsUp={() => onUnlike(track.id)}
                            buttonSizeClassName="h-8 w-8"
                            iconSizeClassName="h-4 w-4"
                        />
                        <TrackOverflowMenu
                            track={toAudioTrack(track)}
                            showGoToAlbum={!isRemote}
                            showMatchVibe={!isRemote}
                        />
                    </div>
                ),
            };
        },
        [likedTrackIds, removingTrackId, onUnlike],
    );

    return (
        <div className="w-full">
            <TrackList
                items={tracks}
                toRowItem={toRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                accentColor="#93c5fd"
                preferenceMode={null}
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
 * Renders the MyLikedPlaylistPage component.
 */
export default function MyLikedPlaylistPage() {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, playNow, pause, resume, addTracksToQueue } = useAudioControls();
    const { data, isLoading, isError } = useLikedPlaylistQuery();
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } = usePlayButtonFeedback();

    const likedTracks = data?.tracks ?? EMPTY_TRACKS;
    const likedTrackIds = useMemo(
        () => new Set(likedTracks.map((track) => track.id)),
        [likedTracks]
    );
    const audioTracks = useMemo(
        () => likedTracks.map((track) => toAudioTrack(track)),
        [likedTracks]
    );
    const totalDuration = useMemo(
        () => likedTracks.reduce((sum, track) => sum + (track.duration || 0), 0),
        [likedTracks]
    );
    const providerCounts = useMemo(
        () =>
            likedTracks.reduce(
                (acc, track) => {
                    const source = track.streamSource || "local";
                    if (source === "tidal") acc.tidal += 1;
                    else if (source === "youtube") acc.youtube += 1;
                    else acc.local += 1;
                    return acc;
                },
                { local: 0, tidal: 0, youtube: 0 }
            ),
        [likedTracks]
    );

    const isThisPlaylistPlaying = useMemo(() => {
        if (!currentTrack || !isPlaying || likedTracks.length === 0) {
            return false;
        }
        return likedTrackIds.has(currentTrack.id);
    }, [currentTrack, isPlaying, likedTracks.length, likedTrackIds]);

    const coverUrls = useMemo(() => {
        if (likedTracks.length === 0) return [];
        const candidates = createMosaicCandidates(likedTracks, {
            getId: (t) => t.id,
            getCoverUrl: (t) => t.album.coverArt,
            getArtistKey: (t) => t.artist.name?.toLowerCase(),
            getAlbumKey: (t) => t.album.title?.toLowerCase(),
        });
        return selectMosaicCovers(candidates, { count: 4 })
            .map((r) => {
                const track = likedTracks.find((t) => t.id === r.candidateId);
                if (!track) {
                    return api.getCoverArtUrl(r.coverUrl, 200);
                }
                return resolveLikedTrackCoverUrl(track, 200);
            });
    }, [likedTracks]);

    const unlikeMutation = useMutation({
        mutationFn: (trackId: string) => api.setTrackPreference(trackId, "clear"),
        onMutate: async (trackId: string) => {
            setRemovingTrackId(trackId);
            await queryClient.cancelQueries({ queryKey: queryKeys.likedPlaylist() });
            const previous = queryClient.getQueryData<LikedPlaylistResponse>(
                queryKeys.likedPlaylist()
            );

            queryClient.setQueryData<LikedPlaylistResponse>(
                queryKeys.likedPlaylist(),
                (old) => {
                    if (!old) return old;
                    const nextTracks = old.tracks.filter(
                        (track) => track.id !== trackId
                    );
                    if (nextTracks.length === old.tracks.length) return old;
                    return {
                        ...old,
                        tracks: nextTracks,
                        total: Math.max(0, old.total - 1),
                    };
                }
            );

            return { previous };
        },
        onError: (_error, _trackId, context) => {
            if (context?.previous) {
                queryClient.setQueryData(queryKeys.likedPlaylist(), context.previous);
            }
            toast.error("Failed to update liked tracks");
        },
        onSuccess: (preference) => {
            queryClient.setQueryData(
                ["track-preference", preference.trackId],
                preference
            );
            toast.success("Removed from My Liked");
        },
        onSettled: () => {
            setRemovingTrackId(null);
            queryClient.invalidateQueries({ queryKey: ["library", "liked-playlist"] });
        },
    });

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    const handleAddAllToQueue = () => {
        if (audioTracks.length === 0) return;
        addTracksToQueue(audioTracks);
        toast.success(`Added ${audioTracks.length} tracks to queue`);
    };

    const handlePlaylistSelected = async (playlistId: string) => {
        if (likedTracks.length === 0) return;
        setIsAddingToPlaylist(true);
        try {
            for (const track of likedTracks) {
                await api.addTrackToPlaylist(playlistId, toAddToPlaylistRef({
                    id: track.id,
                    title: track.title,
                    artist: track.artist?.name,
                    album: track.album?.title,
                    duration: track.duration,
                    streamSource: track.streamSource,
                    youtubeVideoId: track.youtubeVideoId,
                    tidalTrackId: track.tidalTrackId,
                    thumbnailUrl: track.album?.coverArt || undefined,
                }));
            }
            toast.success(`Added ${likedTracks.length} tracks to playlist`);
            setShowPlaylistSelector(false);
        } catch (error) {
            sharedFrontendLogger.error("Failed to add tracks to playlist:", error);
            toast.error("Failed to add some tracks to playlist");
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    const handlePlayAll = () => {
        if (audioTracks.length === 0) return;
        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }
        triggerPlayFeedback();
        playTracks(audioTracks, 0);
    };

    const handleShuffle = () => {
        if (audioTracks.length < 2) return;
        playTracks(shuffleArray(audioTracks), 0);
    };

    const handlePlayTrack = (track: LikedPlaylistTrack) => {
        playNow(toAudioTrack(track));
    };

    const handleStartRadio = async () => {
        if (!data?.playlist.id) return;
        try {
            toast.info("Starting playlist radio...");
            const response = await api.getRadioTracks("playlist", data.playlist.id);
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
            <div className="flex min-h-screen items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-white/60" />
            </div>
        );
    }

    if (isError || !data) {
        return (
            <div className="flex min-h-screen items-center justify-center px-6 text-center">
                <p className="text-sm text-white/60">
                    Could not load your liked tracks right now.
                </p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Hero with brand-blue gradient */}
            <div className="relative pt-16 pb-10 px-4 md:px-8">
                <div className="absolute inset-0 pointer-events-none">
                    <div
                        className="absolute inset-0 bg-gradient-to-b from-[#3b82f6]/15 via-blue-900/10 to-transparent"
                        style={{ height: "35vh" }}
                    />
                    <div
                        className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#3b82f6]/8 via-transparent to-transparent"
                        style={{ height: "25vh" }}
                    />
                </div>
                <div className="relative flex items-end gap-6">
                    {/* Cover Art / Icon */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        <CoverMosaic
                            coverUrls={coverUrls}
                            imageSizes="96px"
                            emptyState={
                                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#3b82f6]/20 to-[#1e3a5f]/30">
                                    <Heart className="h-16 w-16 text-[#60a5fa]" />
                                </div>
                            }
                        />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">Playlist</p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {data.playlist.name}
                        </h1>
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            <span>{likedTracks.length} songs</span>
                            <span className="mx-1">&bull;</span>
                            <span>
                                {providerCounts.local} local /{" "}
                                {providerCounts.tidal} TIDAL /{" "}
                                {providerCounts.youtube} YouTube
                            </span>
                            {totalDuration > 0 && (
                                <span>
                                    , {formatTotalDuration(totalDuration)}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {likedTracks.length > 0 && (
                        <button
                            onClick={handlePlayAll}
                            className="flex items-center gap-2 rounded-full bg-[#60a5fa] px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-all hover:bg-[#3b82f6] hover:scale-105"
                        >
                            {showPlaySpinner ? (
                                <Loader2 className="h-5 w-5 animate-spin" />
                            ) : isThisPlaylistPlaying && isPlaying ? (
                                <Pause className="h-5 w-5 fill-current" />
                            ) : (
                                <Play className="h-5 w-5 fill-current ml-0.5" />
                            )}
                            <span>{isThisPlaylistPlaying && isPlaying ? "Pause" : "Play All"}</span>
                        </button>
                    )}
                    {likedTracks.length > 1 && (
                        <button
                            onClick={handleShuffle}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                            aria-label="Shuffle play"
                        >
                            <Shuffle className="h-5 w-5" />
                        </button>
                    )}
                    {likedTracks.length > 0 && (
                        <button
                            onClick={handleAddAllToQueue}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Add all to queue"
                            aria-label="Add all to queue"
                        >
                            <ListMusic className="h-5 w-5" />
                        </button>
                    )}
                    {likedTracks.length > 0 && (
                        <button
                            onClick={() => setShowPlaylistSelector(true)}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Add all to playlist"
                            aria-label="Add all to playlist"
                        >
                            <Plus className="h-5 w-5" />
                        </button>
                    )}
                    {likedTracks.length > 0 && (
                        <button
                            onClick={handleStartRadio}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Start playlist radio"
                            aria-label="Start playlist radio"
                        >
                            <Radio className="h-5 w-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Track List */}
            <div className="px-2 md:px-8 pb-32">
                {likedTracks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
                            <Music className="h-8 w-8 text-white/40" />
                        </div>
                        <h2 className="mb-1 text-lg font-semibold text-white">
                            No liked tracks yet
                        </h2>
                        <p className="text-sm text-white/50">
                            Tap the heart on any song to add it here.
                        </p>
                    </div>
                ) : (
                    <LikedTrackList
                        tracks={likedTracks}
                        likedTrackIds={likedTrackIds}
                        removingTrackId={removingTrackId}
                        onPlay={handlePlayTrack}
                        onUnlike={(trackId) => unlikeMutation.mutate(trackId)}
                    />
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
