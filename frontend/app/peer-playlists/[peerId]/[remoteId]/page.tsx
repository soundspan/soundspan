"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Heart, ListMusic, Network, Play } from "lucide-react";
import { api } from "@/lib/api";
import type { PeerPlaylistTrack } from "@/lib/api/peerPlaylists";
import { useAudioControls } from "@/lib/audio-context";
import type { Track as AudioTrack } from "@/lib/audio-state-context";
import { useToast } from "@/lib/toast-context";
import { PageHeader } from "@/components/layout/PageHeader";
import { formatTime } from "@/utils/formatTime";
import {
    useFollowedPeerPlaylists,
    usePeerPlaylist,
} from "@/features/social/hooks/usePeerPlaylists";
import { queryKeys } from "@/lib/queryKeys";

/** Maps a resolved peer playlist row onto the audio-context track shape. */
function peerRowToAudioTrack(row: PeerPlaylistTrack): AudioTrack | null {
    const track = row.track;
    if (!row.isResolvable || !track) return null;
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
        source: track.source,
        peer: track.peer,
        // The stream source union grows with the contract (peer tier);
        // pass it through with its provider ids untouched.
        ...(track.streamSource
            ? {
                  streamSource: track.streamSource,
                  tidalTrackId: track.tidalTrackId,
                  youtubeVideoId: track.youtubeVideoId,
              }
            : {}),
    };
}

/**
 * Renders a public playlist shared by a federated peer: play the rows
 * that resolve locally or through the peer, follow it live, or save a
 * copy as a normal local playlist.
 */
export default function PeerPlaylistDetailPage() {
    const params = useParams<{ peerId: string; remoteId: string }>();
    const peerId = params.peerId;
    const remoteId = params.remoteId;
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const { playNow, playTracks } = useAudioControls();
    const [busy, setBusy] = useState(false);

    const detailQuery = usePeerPlaylist(peerId, remoteId);
    const followedQuery = useFollowedPeerPlaylists();

    const detail = detailQuery.data;
    const rows = useMemo(
        () => detail?.playlist.tracks ?? [],
        [detail?.playlist.tracks],
    );
    const playable = useMemo(
        () =>
            rows
                .map((row) => peerRowToAudioTrack(row))
                .filter((track): track is AudioTrack => track !== null),
        [rows],
    );
    const followState: "loading" | "unknown" | "followed" | "not-followed" =
        followedQuery.isLoading
            ? "loading"
            : followedQuery.isError
              ? "unknown"
              : followedQuery.data?.playlists.some(
                      (playlist) =>
                          playlist.peerId === peerId &&
                          playlist.remoteId === remoteId,
                  )
                ? "followed"
                : "not-followed";
    const isFollowed = followState === "followed";

    const invalidate = () =>
        queryClient.invalidateQueries({
            queryKey: queryKeys.peerPlaylistsAll(),
        });

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } catch {
            toast.error("The peer could not be reached. Try again later.");
        } finally {
            setBusy(false);
        }
    };

    if (detailQuery.isLoading) {
        return (
            <div className="flex items-center justify-center py-16">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <Network className="mb-3 h-8 w-8 text-white/20" />
                <p className="text-sm text-white/50">
                    This peer playlist is unavailable right now.
                </p>
                <p className="mt-1 text-xs text-white/30">
                    The peer may be offline, or the playlist is no longer
                    shared.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <PageHeader
                icon={ListMusic}
                title={detail.playlist.name}
                subtitle={`By ${detail.playlist.owner.displayName} · From ${detail.peer.name} · ${playable.length} of ${rows.length} tracks playable`}
            />
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={busy || playable.length === 0}
                    onClick={() => {
                        playTracks(playable, 0);
                        toast.success("Playing peer playlist");
                    }}
                    className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black disabled:opacity-50"
                >
                    <Play className="h-3.5 w-3.5" /> Play
                </button>
                <button
                    type="button"
                    disabled={
                        busy ||
                        followState === "loading" ||
                        followState === "unknown"
                    }
                    onClick={() =>
                        void run(async () => {
                            if (isFollowed) {
                                await api.unfollowPeerPlaylist(
                                    peerId,
                                    remoteId,
                                );
                                toast.success("Unfollowed");
                            } else {
                                await api.followPeerPlaylist(peerId, remoteId);
                                toast.success(
                                    "Following — it stays in sync with the peer",
                                );
                            }
                            await invalidate();
                        })
                    }
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-xs font-medium text-white hover:border-white/40 disabled:opacity-50"
                >
                    <Heart className="h-3.5 w-3.5" />
                    {isFollowed ? "Unfollow" : "Follow"}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                        void run(async () => {
                            const result = await api.copyPeerPlaylist(
                                peerId,
                                remoteId,
                            );
                            toast.success(
                                `Saved a copy: ${result.copied} tracks${result.skipped ? `, ${result.skipped} skipped` : ""}`,
                            );
                            await invalidate();
                        })
                    }
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-xs font-medium text-white hover:border-white/40 disabled:opacity-50"
                >
                    <Copy className="h-3.5 w-3.5" /> Save a copy
                </button>
            </div>
            <div role="list" aria-label="Peer playlist tracks">
                {rows.map((row, index) => {
                    const audioTrack = peerRowToAudioTrack(row);
                    return (
                        <div
                            key={`${row.remoteTrackId}:${index}`}
                            role="listitem"
                            className={`flex items-center gap-3 border-b border-white/5 px-3 py-2 ${audioTrack ? "hover:bg-white/5" : "opacity-40"}`}
                        >
                            <span className="w-6 shrink-0 text-right text-xs text-white/30">
                                {index + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                                <button
                                    type="button"
                                    disabled={!audioTrack}
                                    onClick={() =>
                                        audioTrack && playNow(audioTrack)
                                    }
                                    className="block w-full truncate text-left text-sm text-white/85 disabled:cursor-default"
                                >
                                    {row.title}
                                </button>
                                <p className="truncate text-xs text-white/40">
                                    {row.artist}
                                    {!audioTrack &&
                                        " · Not available from this peer"}
                                </p>
                            </div>
                            <span className="shrink-0 text-xs text-white/30">
                                {formatTime(row.duration)}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
