"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, Loader2, Music, Pause, Play, Radio, Shuffle } from "lucide-react";
import {
    useAudioControls,
    useAudioPlayback,
    useAudioState,
    type Track as AudioTrack,
} from "@/lib/audio-context";
import { api, type LikedPlaylistResponse, type LikedPlaylistTrack } from "@/lib/api";
import { queryKeys, useLikedPlaylistQuery } from "@/hooks/useQueries";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { shuffleArray } from "@/utils/shuffle";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { useToast } from "@/lib/toast-context";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

const EMPTY_TRACKS: LikedPlaylistTrack[] = [];

function toAudioTrack(track: LikedPlaylistTrack): AudioTrack {
    return {
        id: track.id,
        title: track.title,
        artist: {
            id: track.artist.id,
            name: track.artist.name,
        },
        album: {
            id: track.album.id,
            title: track.album.title,
            coverArt: track.album.coverArt,
        },
        duration: track.duration,
        filePath: track.filePath || undefined,
    };
}

export default function MyLikedPlaylistPage() {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, playNow, pause, resume } = useAudioControls();
    const { data, isLoading, isError } = useLikedPlaylistQuery();
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);

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

    const isThisPlaylistPlaying = useMemo(() => {
        if (!currentTrack || !isPlaying || likedTracks.length === 0) {
            return false;
        }
        return likedTrackIds.has(currentTrack.id);
    }, [currentTrack, isPlaying, likedTracks.length, likedTrackIds]);

    const coverUrls = useMemo(() => {
        const withCovers = likedTracks.filter((t) => t.album.coverArt);
        if (withCovers.length === 0) return [];
        return Array.from(
            new Set(withCovers.map((t) => t.album.coverArt))
        ).slice(0, 4);
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
            queryClient.invalidateQueries({ queryKey: queryKeys.likedPlaylist() });
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
                        {coverUrls.length > 0 ? (
                            <div className="grid grid-cols-2 gap-0 w-full h-full">
                                {coverUrls.map((url, index) => (
                                    <div key={index} className="relative bg-[#181818]">
                                        <Image
                                            src={api.getCoverArtUrl(url!, 200)}
                                            alt=""
                                            fill
                                            className="object-cover"
                                            sizes="96px"
                                            unoptimized
                                        />
                                    </div>
                                ))}
                                {Array.from({ length: Math.max(0, 4 - coverUrls.length) }).map((_, index) => (
                                    <div key={`empty-${index}`} className="relative bg-[#282828]" />
                                ))}
                            </div>
                        ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#3b82f6]/20 to-[#1e3a5f]/30">
                                <Heart className="h-16 w-16 text-[#60a5fa]" />
                            </div>
                        )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">Playlist</p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {data.playlist.name}
                        </h1>
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            <span>
                                {likedTracks.length} song{likedTracks.length === 1 ? "" : "s"}
                            </span>
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
                    {likedTracks.length > 0 && (
                        <button
                            onClick={handlePlayAll}
                            className="flex items-center gap-2 rounded-full bg-[#60a5fa] px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-all hover:bg-[#3b82f6] hover:scale-105"
                        >
                            {isThisPlaylistPlaying && isPlaying ? (
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
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span />
                        </div>

                        {/* Track Rows */}
                        <div>
                            {likedTracks.map((track, index) => {
                                const isCurrent = currentTrack?.id === track.id;
                                const isRemoving = removingTrackId === track.id;

                                return (
                                    <div
                                        key={track.id}
                                        onClick={() => handlePlayTrack(track)}
                                        className={cn(
                                            "group grid cursor-pointer grid-cols-[28px_1fr_auto] items-center gap-2 px-2 py-2 rounded-md transition-colors hover:bg-white/5 md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] md:gap-4 md:px-4",
                                            isCurrent && "bg-[#3b82f6]/10"
                                        )}
                                    >
                                        <div className="flex items-center justify-center text-sm text-gray-400">
                                            {index + 1}
                                        </div>

                                        <div className="flex min-w-0 items-center gap-3">
                                            <div className="relative h-10 w-10 overflow-hidden rounded bg-[#282828] shrink-0">
                                                {track.album.coverArt ? (
                                                    <Image
                                                        src={api.getCoverArtUrl(
                                                            track.album.coverArt,
                                                            100
                                                        )}
                                                        alt={track.title}
                                                        fill
                                                        sizes="40px"
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="flex h-full w-full items-center justify-center">
                                                        <Music className="h-4 w-4 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <p
                                                    className={cn(
                                                        "truncate text-sm font-medium",
                                                        isCurrent
                                                            ? "text-[#93c5fd]"
                                                            : "text-white"
                                                    )}
                                                >
                                                    {track.title}
                                                </p>
                                                <p className="truncate text-xs text-gray-400">
                                                    {track.artist.name}
                                                </p>
                                            </div>
                                        </div>

                                        <p className="hidden truncate text-sm text-gray-400 md:flex items-center">
                                            {track.album.title}
                                        </p>

                                        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                                            <span className="hidden sm:inline text-xs text-gray-500 w-10 text-right tabular-nums">
                                                {formatTime(track.duration)}
                                            </span>
                                            <TrackPreferenceButtons
                                                trackId={track.id}
                                                mode="up-only"
                                                resolveFromQuery={false}
                                                signal={
                                                    likedTrackIds.has(track.id) ?
                                                        "thumbs_up"
                                                    :   "clear"
                                                }
                                                isSaving={isRemoving}
                                                onToggleThumbsUp={() => unlikeMutation.mutate(track.id)}
                                                buttonSizeClassName="h-8 w-8"
                                                iconSizeClassName="h-4 w-4"
                                            />
                                            <TrackOverflowMenu track={toAudioTrack(track)} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
