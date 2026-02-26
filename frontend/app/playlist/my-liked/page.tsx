"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Music, Pause, Play, Shuffle, ThumbsUp } from "lucide-react";
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
import { PageHeader } from "@/components/layout/PageHeader";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { useToast } from "@/lib/toast-context";

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
        <div className="min-h-screen px-4 py-6 md:px-8">
            <PageHeader
                title={data.playlist.name}
                subtitle={`${likedTracks.length} song${likedTracks.length === 1 ? "" : "s"}${
                    totalDuration > 0 ? ` • ${formatTotalDuration(totalDuration)}` : ""
                }`}
                icon={ThumbsUp}
                className="mb-6"
            />

            <div className="mb-6 flex items-center gap-3">
                <button
                    onClick={handlePlayAll}
                    disabled={likedTracks.length === 0}
                    className="flex items-center gap-2 rounded-full bg-[#60a5fa] px-5 py-2.5 text-sm font-semibold text-black transition-all hover:bg-[#3b82f6] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {isThisPlaylistPlaying && isPlaying ? (
                        <Pause className="h-5 w-5 fill-current" />
                    ) : (
                        <Play className="h-5 w-5 fill-current ml-0.5" />
                    )}
                    <span>{isThisPlaylistPlaying && isPlaying ? "Pause" : "Play All"}</span>
                </button>
                <button
                    onClick={handleShuffle}
                    disabled={likedTracks.length < 2}
                    className="flex h-9 w-9 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    title="Shuffle"
                    aria-label="Shuffle"
                >
                    <Shuffle className="h-5 w-5" />
                </button>
            </div>

            {likedTracks.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] py-24 text-center">
                    <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
                        <Music className="h-8 w-8 text-white/40" />
                    </div>
                    <h2 className="mb-1 text-lg font-semibold text-white">
                        No liked tracks yet
                    </h2>
                    <p className="text-sm text-white/50">
                        Tap thumbs up on any song to add it here.
                    </p>
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border border-white/10">
                    <div className="hidden grid-cols-[40px_minmax(220px,4fr)_minmax(120px,2fr)_auto_auto] gap-3 border-b border-white/10 px-4 py-2 text-xs uppercase tracking-wider text-white/40 md:grid">
                        <span className="text-center">#</span>
                        <span>Title</span>
                        <span>Album</span>
                        <span className="text-right">Duration</span>
                        <span className="text-right">Action</span>
                    </div>
                    {likedTracks.map((track, index) => {
                        const isCurrent = currentTrack?.id === track.id;
                        const isRemoving = removingTrackId === track.id;

                        return (
                            <div
                                key={track.id}
                                onClick={() => handlePlayTrack(track)}
                                className={cn(
                                    "grid cursor-pointer grid-cols-[28px_1fr_auto] items-center gap-2 px-2 py-2 transition-colors hover:bg-white/5 md:grid-cols-[40px_minmax(220px,4fr)_minmax(120px,2fr)_auto_auto] md:gap-3 md:px-4",
                                    isCurrent && "bg-[#3b82f6]/10"
                                )}
                            >
                                <div className="flex items-center justify-center text-sm text-white/50">
                                    {index + 1}
                                </div>

                                <div className="flex min-w-0 items-center gap-3">
                                    <div className="relative h-10 w-10 overflow-hidden rounded bg-white/5">
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
                                                <Music className="h-4 w-4 text-white/40" />
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
                                        <p className="truncate text-xs text-white/55">
                                            {track.artist.name}
                                        </p>
                                    </div>
                                </div>

                                <p className="hidden truncate text-sm text-white/45 md:block">
                                    {track.album.title}
                                </p>

                                <span className="hidden w-12 text-right text-sm text-white/45 sm:inline">
                                    {formatTime(track.duration)}
                                </span>

                                <div className="flex items-center justify-end">
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
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
