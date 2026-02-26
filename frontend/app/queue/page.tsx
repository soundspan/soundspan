"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAudioState, useAudioControls } from "@/lib/audio-context";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";
import { useListenTogether } from "@/lib/listen-together-context";
import { PageHeader } from "@/components/layout/PageHeader";

import {
    Music,
    Play,
    GripVertical,
    Trash2,
    ListMusic,
    ChevronUp,
    ChevronDown,
    X,
    Save,
} from "lucide-react";
import { TrackOverflowMenu, TrackMenuButton } from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { formatTime } from "@/utils/formatTime";

export default function QueuePage() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { queue, currentTrack, currentIndex, setQueue } = useAudioState();
    const { playTracks, removeFromQueue, clearQueue } = useAudioControls();
    const { toast } = useToast();
    const { isInGroup, isHost, syncSetTrack } = useListenTogether();

    useEffect(() => {
        if (!isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, router]);

    const handleClearQueue = () => {
        clearQueue();
        toast.success(isInGroup ? "Listen Together queue cleared" : "Queue cleared");
    };

    const handleRemoveTrack = (index: number) => {
        removeFromQueue(index);
        toast.success("Removed from queue");
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
        toast.success("Playing from queue");
    };

    const handleMoveUp = (index: number) => {
        if (isInGroup) return;
        if (index <= currentIndex + 1) return;
        setQueue((prev) => {
            const newQueue = [...prev];
            [newQueue[index], newQueue[index - 1]] = [
                newQueue[index - 1],
                newQueue[index],
            ];
            return newQueue;
        });
    };

    const handleMoveDown = (index: number) => {
        if (isInGroup) return;
        if (index >= queue.length - 1 || index <= currentIndex) return;
        setQueue((prev) => {
            const newQueue = [...prev];
            [newQueue[index], newQueue[index + 1]] = [
                newQueue[index + 1],
                newQueue[index],
            ];
            return newQueue;
        });
    };

    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [playlistName, setPlaylistName] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    const handleSaveAsPlaylist = async () => {
        const name = playlistName.trim() || `Queue — ${new Date().toLocaleDateString()}`;
        setIsSaving(true);
        try {
            const playlist = await api.createPlaylist(name);
            for (const track of queue) {
                await api.addTrackToPlaylist(playlist.id, track.id);
            }
            toast.success(`Saved ${queue.length} tracks to "${name}"`);
            setShowSaveDialog(false);
            setPlaylistName("");
            router.push(`/playlist/${playlist.id}`);
        } catch {
            toast.error("Failed to save playlist");
        } finally {
            setIsSaving(false);
        }
    };

    if (!isAuthenticated) {
        return null;
    }

    // Split queue into current, next up, and previous
    const previousTracks = queue.slice(0, currentIndex);
    const nextTracks = queue.slice(currentIndex + 1);

    return (
        <div className="min-h-screen bg-[#0a0a0a]">
            <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
                {/* Header */}
                <PageHeader
                    title={isInGroup ? "Listen Together Queue" : "Queue"}
                    subtitle={`${queue.length} track${queue.length !== 1 ? "s" : ""} in queue`}
                    icon={ListMusic}
                    iconClassName="text-[#3b82f6]"
                    className="mb-8"
                    actions={
                        queue.length > 0 ? (
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="secondary"
                                    onClick={() => setShowSaveDialog(true)}
                                >
                                    <Save className="w-4 h-4 mr-2" />
                                    Save as Playlist
                                </Button>
                                <Button
                                    variant="secondary"
                                    onClick={handleClearQueue}
                                >
                                    <Trash2 className="w-4 h-4 mr-2" />
                                    Clear Queue
                                </Button>
                            </div>
                        ) : null
                    }
                />

                {/* Empty State */}
                {queue.length === 0 && (
                    <EmptyState
                        icon={<ListMusic />}
                        title="No tracks in queue"
                        description="Start playing music to see your queue here"
                        action={{
                            label: "Browse Library",
                            onClick: () => router.push("/library"),
                        }}
                    />
                )}

                {/* Now Playing */}
                {currentTrack && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Now Playing
                        </h2>
                        <Card>
                            <div className="flex items-center gap-4 p-4 bg-[#1a1a1a] border-l-2 border-[#2323FF] group">
                                <div className="relative flex-shrink-0 w-16 h-16">
                                    {currentTrack.album?.coverArt ? (
                                        <Image
                                            src={api.getCoverArtUrl(
                                                currentTrack.album.coverArt,
                                                100
                                            )}
                                            alt={currentTrack.album.title}
                                            fill
                                            sizes="64px"
                                            className="object-cover rounded-sm"
                                            unoptimized
                                        />
                                    ) : (
                                        <div className="w-16 h-16 bg-[#0a0a0a] rounded-sm flex items-center justify-center">
                                            <Music className="w-6 h-6 text-gray-600" />
                                        </div>
                                    )}
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Play className="w-6 h-6 text-[#5b5bff] fill-[#5b5bff] animate-pulse" />
                                    </div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-sm font-medium text-[#5b5bff] truncate">
                                        {currentTrack.displayTitle ??
                                            currentTrack.title}
                                    </h3>
                                    <p className="text-sm text-gray-400 truncate">
                                        {currentTrack.artist?.name}
                                    </p>
                                    <p className="text-xs text-gray-500 truncate">
                                        {currentTrack.album?.title}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
                                        {formatTime(currentTrack.duration)}
                                    </span>
                                    <TrackPreferenceButtons
                                        trackId={currentTrack.id}
                                        mode="up-only"
                                        buttonSizeClassName="h-8 w-8"
                                        iconSizeClassName="h-4 w-4"
                                    />
                                    <TrackOverflowMenu
                                        track={currentTrack}
                                        showPlayNext={false}
                                        showAddToQueue={false}
                                        isInListenTogetherGroup={isInGroup}
                                    />
                                </div>
                            </div>
                        </Card>
                    </section>
                )}

                {/* Next Up */}
                {nextTracks.length > 0 && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Next Up ({nextTracks.length})
                        </h2>
                        <Card>
                            <div className="divide-y divide-[#1c1c1c]">
                                {nextTracks.map((track, idx) => {
                                    const queueIndex = currentIndex + 1 + idx;
                                    return (
                                        <div
                                            key={`${track.id}-${queueIndex}`}
                                            className="flex items-center gap-4 p-4 hover:bg-[#1a1a1a] transition-colors group"
                                        >
                                            {/* Drag Handle */}
                                            {!isInGroup && (
                                                <button
                                                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-white cursor-grab active:cursor-grabbing"
                                                    title="Drag to reorder"
                                                >
                                                    <GripVertical className="w-5 h-5" />
                                                </button>
                                            )}

                                            {/* Album Art */}
                                            <div className="relative flex-shrink-0 w-12 h-12">
                                                {track.album?.coverArt ? (
                                                    <Image
                                                        src={api.getCoverArtUrl(
                                                            track.album
                                                                .coverArt,
                                                            100
                                                        )}
                                                        alt={track.album.title}
                                                        fill
                                                        sizes="48px"
                                                        className="object-cover rounded-sm"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-12 h-12 bg-[#0a0a0a] rounded-sm flex items-center justify-center">
                                                        <Music className="w-5 h-5 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>

                                            {/* Track Info */}
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-sm font-medium text-white truncate">
                                                    {track.displayTitle ??
                                                        track.title}
                                                </h3>
                                                <p className="text-sm text-gray-400 truncate">
                                                    {track.artist?.name}
                                                </p>
                                            </div>

                                            {/* Actions */}
                                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                {!isInGroup && (
                                                    <>
                                                        <button
                                                            onClick={() =>
                                                                handleMoveUp(queueIndex)
                                                            }
                                                            disabled={
                                                                queueIndex <=
                                                                currentIndex + 1
                                                            }
                                                            className="p-2 hover:bg-[#0a0a0a] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                            title="Move up"
                                                        >
                                                            <ChevronUp className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() =>
                                                                handleMoveDown(
                                                                    queueIndex
                                                                )
                                                            }
                                                            disabled={
                                                                queueIndex >=
                                                                queue.length - 1
                                                            }
                                                            className="p-2 hover:bg-[#0a0a0a] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                            title="Move down"
                                                        >
                                                            <ChevronDown className="w-4 h-4" />
                                                        </button>
                                                    </>
                                                )}
                                                <button
                                                    onClick={() =>
                                                        handlePlayFromQueue(
                                                            queueIndex
                                                        )
                                                    }
                                                    className="p-2 hover:bg-[#0a0a0a] rounded-md transition-colors"
                                                    title="Play now"
                                                >
                                                    <Play className="w-4 h-4" />
                                                </button>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
                                                    {formatTime(track.duration)}
                                                </span>
                                                <TrackPreferenceButtons
                                                    trackId={track.id}
                                                    mode="up-only"
                                                    buttonSizeClassName="h-8 w-8"
                                                    iconSizeClassName="h-4 w-4"
                                                />
                                                <TrackOverflowMenu
                                                    track={track}
                                                    showPlayNext={false}
                                                    showAddToQueue={false}
                                                    isInListenTogetherGroup={isInGroup}
                                                    extraItemsAfter={
                                                        <TrackMenuButton
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRemoveTrack(queueIndex);
                                                            }}
                                                            icon={<X className="h-4 w-4" />}
                                                            label="Remove from queue"
                                                            className="text-red-400 hover:text-red-300"
                                                        />
                                                    }
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    </section>
                )}

                {/* Previously Played */}
                {previousTracks.length > 0 && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Previously Played ({previousTracks.length})
                        </h2>
                        <Card>
                            <div className="divide-y divide-[#1c1c1c]">
                                {previousTracks.map((track, idx) => (
                                    <div
                                        key={`${track.id}-${idx}`}
                                        className="flex items-center gap-4 p-4 hover:bg-[#1a1a1a] transition-colors group opacity-50"
                                    >
                                        {/* Album Art */}
                                        <div className="relative flex-shrink-0 w-12 h-12">
                                            {track.album?.coverArt ? (
                                                <Image
                                                    src={api.getCoverArtUrl(
                                                        track.album.coverArt,
                                                        100
                                                    )}
                                                    alt={track.album.title}
                                                    fill
                                                    sizes="48px"
                                                    className="object-cover rounded-sm"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-12 h-12 bg-[#0a0a0a] rounded-sm flex items-center justify-center">
                                                    <Music className="w-5 h-5 text-gray-600" />
                                                </div>
                                            )}
                                        </div>

                                        {/* Track Info */}
                                        <div className="flex-1 min-w-0">
                                            <h3 className="text-sm font-medium text-white truncate">
                                                {track.title}
                                            </h3>
                                            <p className="text-sm text-gray-400 truncate">
                                                {track.artist?.name}
                                            </p>
                                        </div>

                                        <div className="flex items-center gap-1">
                                            <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
                                                {formatTime(track.duration)}
                                            </span>
                                            <TrackPreferenceButtons
                                                trackId={track.id}
                                                mode="up-only"
                                                buttonSizeClassName="h-8 w-8"
                                                iconSizeClassName="h-4 w-4"
                                            />
                                            <TrackOverflowMenu
                                                track={track}
                                                showPlayNext={false}
                                                showAddToQueue={false}
                                                isInListenTogetherGroup={isInGroup}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </section>
                )}
            </div>

            {/* Save as Playlist Dialog */}
            {showSaveDialog && (
                <div
                    className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4"
                    onClick={() => setShowSaveDialog(false)}
                >
                    <div
                        className="bg-[#121212] rounded-xl max-w-md w-full overflow-hidden border border-white/10 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-6">
                            <h2 className="text-lg font-bold text-white mb-1">
                                Save Queue as Playlist
                            </h2>
                            <p className="text-sm text-gray-400 mb-4">
                                Save all {queue.length} tracks to a new playlist
                            </p>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(e) => setPlaylistName(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleSaveAsPlaylist()}
                                placeholder={`Queue — ${new Date().toLocaleDateString()}`}
                                className="w-full px-3 py-2 bg-[#1a1a1a] border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-[#3b82f6]/50"
                                autoFocus
                            />
                        </div>
                        <div className="flex gap-3 p-6 pt-0">
                            <button
                                onClick={() => setShowSaveDialog(false)}
                                className="flex-1 px-4 py-2.5 bg-white/5 hover:bg-white/10 text-white font-medium rounded-lg transition-colors border border-white/10"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveAsPlaylist}
                                disabled={isSaving}
                                className="flex-1 px-4 py-2.5 bg-[#3b82f6] hover:bg-[#2563eb] text-white font-medium rounded-lg transition-colors disabled:opacity-50"
                            >
                                {isSaving ? "Saving..." : "Save"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
