"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Virtuoso } from "react-virtuoso";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAudioState, useAudioControls } from "@/lib/audio-context";
import {
    resolveDropPosition,
    resolveDropTargetIndex,
    type DropPosition,
} from "@/components/track/reorderDnd";
import type { Track } from "@/lib/audio-state-context";
import { isEpisodeQueueItem, type EpisodeQueueItem } from "@/lib/queue-item";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";
import { useListenTogether } from "@/lib/listen-together-context";
import { PageHeader } from "@/components/layout/PageHeader";
import type { AvailabilityItem } from "@/lib/listen-together-socket";

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
import {
    TrackOverflowMenu,
    TrackMenuButton,
} from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { formatTime } from "@/utils/formatTime";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { PeerBadge } from "@/components/ui/PeerBadge";

/**
 * Rows rendered on the first pass before react-virtuoso measures the
 * viewport; keeps first paint windowed instead of mounting the whole queue
 * (GH #784).
 */
const INITIAL_WINDOW_COUNT = 20;

/**
 * Renders the QueuePage component.
 */
export default function QueuePage() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { queue, currentTrack, currentIndex } = useAudioState();
    const { playQueueIndex, removeFromQueue, clearQueue, moveQueueItem } =
        useAudioControls();
    const { toast } = useToast();
    const listenTogether = useListenTogether();
    const { isInGroup, isHost, syncSetTrack } = listenTogether;
    const trackAvailability = listenTogether.trackAvailability ?? new Map();

    useEffect(() => {
        if (!isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, router]);

    const resolveQueueSource = (
        index: number,
        fallback?: "peer" | "tidal" | "youtube" | "youtube-direct",
    ): "local" | "peer" | "tidal" | "youtube" => {
        const resolved = trackAvailability.get(index)?.source;
        if (
            resolved === "local" ||
            resolved === "peer" ||
            resolved === "tidal" ||
            resolved === "youtube"
        ) {
            return resolved;
        }
        if (
            fallback === "peer" ||
            fallback === "tidal" ||
            fallback === "youtube"
        ) {
            return fallback;
        }
        if (fallback === "youtube-direct") {
            return "youtube";
        }
        return "local";
    };

    const handleClearQueue = () => {
        clearQueue();
        toast.success(
            isInGroup ? "Listen Together queue cleared" : "Queue cleared",
        );
    };

    const handleRemoveTrack = (index: number) => {
        removeFromQueue(index);
        toast.success("Removed from queue");
    };

    const handlePlayFromQueue = (index: number) => {
        const queueTrack = queue[index];
        if (
            !isEpisodeQueueItem(queueTrack) &&
            queueTrack.source === "federated" &&
            queueTrack.peer?.online === false
        ) {
            toast.info("This peer is offline");
            return;
        }
        const availability = isInGroup
            ? trackAvailability.get(index)
            : undefined;
        if (availability?.available === false) {
            toast.info(
                "Track unavailable for your account in this Listen Together session",
            );
            return;
        }
        if (isInGroup) {
            if (!isHost) {
                toast.info("Only the host can change the current track");
                return;
            }
            syncSetTrack(index);
            return;
        }
        playQueueIndex(index);
        toast.success("Playing from queue");
    };

    // Both the arrow actions and drag-and-drop route through the shared
    // moveQueueItem primitive (LT/current/bounds guards + shuffle-index
    // remapping live there).
    const handleMoveUp = (index: number) => {
        moveQueueItem(index, index - 1);
    };

    const handleMoveDown = (index: number) => {
        moveQueueItem(index, index + 1);
    };

    // Drag-and-drop reorder for the Next Up list (same mechanic and pure
    // drop math as playlist reordering). Indexes here are positions
    // WITHIN nextTracks; moveQueueItem receives absolute queue indexes.
    const dragFromIdxRef = useRef<number | null>(null);
    const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
    const [dragOver, setDragOver] = useState<{
        idx: number;
        position: DropPosition;
    } | null>(null);

    const clearQueueDragState = () => {
        dragFromIdxRef.current = null;
        setDragFromIdx(null);
        setDragOver(null);
    };

    const buildDragHandleProps = (idx: number) =>
        isInGroup
            ? undefined
            : {
                  draggable: true,
                  onClick: (e: React.MouseEvent) => e.stopPropagation(),
                  onDragStart: (e: React.DragEvent) => {
                      dragFromIdxRef.current = idx;
                      setDragFromIdx(idx);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(idx));
                      const row = (e.currentTarget as HTMLElement).closest(
                          "[data-queue-dnd-row]",
                      );
                      if (row instanceof HTMLElement) {
                          e.dataTransfer.setDragImage(
                              row,
                              16,
                              row.clientHeight / 2,
                          );
                      }
                  },
                  onDragEnd: clearQueueDragState,
              };

    const buildRowDropProps = (idx: number) => ({
        "data-queue-dnd-row": true,
        onDragOver: (e: React.DragEvent) => {
            if (dragFromIdxRef.current === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = e.currentTarget.getBoundingClientRect();
            setDragOver({
                idx,
                position: resolveDropPosition(
                    e.clientY - rect.top,
                    rect.height,
                ),
            });
        },
        onDragLeave: (e: React.DragEvent) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragOver((current) => (current?.idx === idx ? null : current));
        },
        onDrop: (e: React.DragEvent) => {
            const fromIdx = dragFromIdxRef.current;
            if (fromIdx === null) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const toIdx = resolveDropTargetIndex(
                fromIdx,
                idx,
                resolveDropPosition(e.clientY - rect.top, rect.height),
            );
            clearQueueDragState();
            if (toIdx !== fromIdx) {
                moveQueueItem(
                    currentIndex + 1 + fromIdx,
                    currentIndex + 1 + toIdx,
                );
            }
        },
    });

    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [playlistName, setPlaylistName] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    // Podcast episodes cannot be saved to playlists; only track items are.
    const playlistTracks = queue.filter(
        (item): item is Track => !isEpisodeQueueItem(item),
    );

    const handleSaveAsPlaylist = async () => {
        const name =
            playlistName.trim() || `Queue — ${new Date().toLocaleDateString()}`;
        setIsSaving(true);
        try {
            const playlist = await api.createPlaylist(name);
            for (const track of playlistTracks) {
                await api.addTrackToPlaylist(
                    playlist.id,
                    toAddToPlaylistRef(track),
                );
            }
            toast.success(`Saved ${playlistTracks.length} tracks to "${name}"`);
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
    const currentQueueItem = queue[currentIndex];
    const currentEpisode =
        !currentTrack && isEpisodeQueueItem(currentQueueItem)
            ? currentQueueItem
            : null;
    const currentAvailability = currentTrack
        ? trackAvailability.get(currentIndex)
        : undefined;
    const isCurrentUnavailable = currentAvailability?.available === false;

    return (
        <div className="min-h-screen bg-surface">
            <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
                {/* Header */}
                <PageHeader
                    title={isInGroup ? "Listen Together Queue" : "Queue"}
                    subtitle={`${queue.length} item${queue.length !== 1 ? "s" : ""} in queue`}
                    icon={ListMusic}
                    iconClassName="text-brand"
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
                            <div
                                className={`flex items-center gap-4 p-4 bg-surface-hover border-l-2 border-ai group ${isCurrentUnavailable ? "opacity-50" : ""}`}
                            >
                                <div className="relative flex-shrink-0 w-16 h-16">
                                    {currentTrack.album?.coverArt ? (
                                        <Image
                                            src={api.getCoverArtUrl(
                                                currentTrack.album.coverArt,
                                                100,
                                            )}
                                            alt={currentTrack.album.title}
                                            fill
                                            sizes="64px"
                                            className="object-cover rounded-sm"
                                            unoptimized
                                        />
                                    ) : (
                                        <div className="w-16 h-16 bg-surface rounded-sm flex items-center justify-center">
                                            <Music className="w-6 h-6 text-gray-400" />
                                        </div>
                                    )}
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Play className="w-6 h-6 text-ai-hover fill-ai-hover animate-pulse" />
                                    </div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-sm font-medium text-ai-hover truncate">
                                        {currentTrack.displayTitle ??
                                            currentTrack.title}
                                    </h3>
                                    <p className="text-sm text-gray-400 truncate">
                                        {currentTrack.artist?.name}
                                    </p>
                                    <div className="mt-1 flex items-center gap-2">
                                        {isCurrentUnavailable ? (
                                            <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-500/50 rounded px-1.5 py-0.5">
                                                Unavailable
                                            </span>
                                        ) : null}
                                        {isInGroup &&
                                        resolveQueueSource(
                                            currentIndex,
                                            currentTrack.streamSource,
                                        ) === "tidal" ? (
                                            <TidalBadge />
                                        ) : null}
                                        {isInGroup &&
                                        resolveQueueSource(
                                            currentIndex,
                                            currentTrack.streamSource,
                                        ) === "youtube" ? (
                                            <YouTubeBadge />
                                        ) : null}
                                        {currentTrack.source === "federated" &&
                                        currentTrack.peer ? (
                                            <PeerBadge
                                                peerName={
                                                    currentTrack.peer.name
                                                }
                                                online={
                                                    currentTrack.peer.online
                                                }
                                            />
                                        ) : null}
                                    </div>
                                    <p className="text-xs text-gray-400 truncate">
                                        {currentTrack.album?.title}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-400 w-10 text-right tabular-nums">
                                        {formatTime(currentTrack.duration)}
                                    </span>
                                    <TrackPreferenceButtons
                                        trackId={currentTrack.id}
                                        mode="up-only"
                                        buttonSizeClassName="h-8 w-8"
                                        iconSizeClassName="h-4 w-4"
                                        metadata={buildPreferenceMetadata(
                                            currentTrack,
                                        )}
                                    />
                                    <TrackOverflowMenu
                                        track={currentTrack}
                                        showPlayNext={false}
                                        showAddToQueue={false}
                                    />
                                </div>
                            </div>
                        </Card>
                    </section>
                )}

                {/* Now Playing (podcast episode) */}
                {currentEpisode && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Now Playing
                        </h2>
                        <Card>
                            <div className="flex items-center gap-4 p-4 bg-surface-hover border-l-2 border-ai">
                                <div className="relative flex-shrink-0 w-16 h-16">
                                    {currentEpisode.coverUrl ? (
                                        <Image
                                            src={currentEpisode.coverUrl}
                                            alt={currentEpisode.podcastTitle}
                                            fill
                                            sizes="64px"
                                            className="object-cover rounded-sm"
                                            unoptimized
                                        />
                                    ) : (
                                        <div className="w-16 h-16 bg-surface rounded-sm flex items-center justify-center">
                                            <Music className="w-6 h-6 text-gray-400" />
                                        </div>
                                    )}
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Play className="w-6 h-6 text-ai-hover fill-ai-hover animate-pulse" />
                                    </div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-sm font-medium text-ai-hover truncate">
                                        {currentEpisode.title}
                                    </h3>
                                    <p className="text-sm text-gray-400 truncate">
                                        {currentEpisode.podcastTitle}
                                    </p>
                                </div>
                                <span className="text-xs text-gray-400 w-10 text-right tabular-nums">
                                    {formatTime(currentEpisode.duration)}
                                </span>
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
                            <Virtuoso
                                totalCount={nextTracks.length}
                                initialItemCount={Math.min(
                                    nextTracks.length,
                                    INITIAL_WINDOW_COUNT,
                                )}
                                computeItemKey={(idx) =>
                                    `next-${nextTracks[idx]?.id ?? idx}-${idx}`
                                }
                                style={{
                                    height: Math.min(
                                        nextTracks.length * 80,
                                        600,
                                    ),
                                }}
                                itemContent={(idx) => {
                                    const item = nextTracks[idx];
                                    const queueIndex = currentIndex + 1 + idx;
                                    const row = isEpisodeQueueItem(item) ? (
                                        <EpisodeQueueRow
                                            episode={item}
                                            onPlay={
                                                isInGroup
                                                    ? undefined
                                                    : () =>
                                                          handlePlayFromQueue(
                                                              queueIndex,
                                                          )
                                            }
                                            onRemove={
                                                isInGroup
                                                    ? undefined
                                                    : () =>
                                                          handleRemoveTrack(
                                                              queueIndex,
                                                          )
                                            }
                                            dragHandleProps={buildDragHandleProps(
                                                idx,
                                            )}
                                        />
                                    ) : (
                                        <NextTrackRow
                                            track={item}
                                            queueIndex={queueIndex}
                                            queueLength={queue.length}
                                            currentIndex={currentIndex}
                                            isInGroup={isInGroup}
                                            resolveQueueSource={
                                                resolveQueueSource
                                            }
                                            onMoveUp={handleMoveUp}
                                            onMoveDown={handleMoveDown}
                                            onPlay={handlePlayFromQueue}
                                            onRemove={handleRemoveTrack}
                                            trackAvailability={
                                                trackAvailability
                                            }
                                            dragHandleProps={buildDragHandleProps(
                                                idx,
                                            )}
                                        />
                                    );
                                    return (
                                        <div
                                            className={
                                                dragFromIdx === idx
                                                    ? "relative opacity-50"
                                                    : "relative"
                                            }
                                            {...buildRowDropProps(idx)}
                                        >
                                            {dragOver?.idx === idx &&
                                                dragFromIdx !== idx && (
                                                    <div
                                                        className={`pointer-events-none absolute left-0 right-0 h-0.5 rounded bg-blue-400 z-10 ${
                                                            dragOver.position ===
                                                            "before"
                                                                ? "top-0"
                                                                : "bottom-0"
                                                        }`}
                                                    />
                                                )}
                                            {row}
                                        </div>
                                    );
                                }}
                            />
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
                            <Virtuoso
                                totalCount={previousTracks.length}
                                initialItemCount={Math.min(
                                    previousTracks.length,
                                    INITIAL_WINDOW_COUNT,
                                )}
                                computeItemKey={(idx) =>
                                    `prev-${previousTracks[idx]?.id ?? idx}-${idx}`
                                }
                                style={{
                                    height: Math.min(
                                        previousTracks.length * 80,
                                        600,
                                    ),
                                }}
                                itemContent={(idx) => {
                                    const item = previousTracks[idx];
                                    if (isEpisodeQueueItem(item)) {
                                        return (
                                            <EpisodeQueueRow
                                                episode={item}
                                                played
                                            />
                                        );
                                    }
                                    return (
                                        <PreviousTrackRow
                                            track={item}
                                            idx={idx}
                                            isInGroup={isInGroup}
                                            resolveQueueSource={
                                                resolveQueueSource
                                            }
                                            trackAvailability={
                                                trackAvailability
                                            }
                                        />
                                    );
                                }}
                            />
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
                        className="bg-surface-sunken rounded-xl max-w-md w-full overflow-hidden border border-white/10 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-6">
                            <h2 className="text-lg font-bold text-white mb-1">
                                Save Queue as Playlist
                            </h2>
                            <p className="text-sm text-gray-400 mb-4">
                                Save {playlistTracks.length} track
                                {playlistTracks.length !== 1 ? "s" : ""} to a
                                new playlist
                            </p>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(e) =>
                                    setPlaylistName(e.target.value)
                                }
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleSaveAsPlaylist()
                                }
                                placeholder={`Queue — ${new Date().toLocaleDateString()}`}
                                className="w-full px-3 py-2 bg-surface-hover border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand/50"
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
                                className="flex-1 px-4 py-2.5 bg-brand hover:bg-brand-dark text-white font-medium rounded-lg transition-colors disabled:opacity-50"
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

/** Queue row for a podcast episode entry (Next Up / Previously Played). */
function EpisodeQueueRow({
    episode,
    played = false,
    onPlay,
    onRemove,
    dragHandleProps,
}: {
    episode: EpisodeQueueItem;
    played?: boolean;
    onPlay?: () => void;
    onRemove?: () => void;
    dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        draggable?: boolean;
    };
}) {
    return (
        <div
            className={`flex items-center gap-4 p-4 hover:bg-surface-hover transition-colors group border-b border-surface-active ${played ? "opacity-50" : ""}`}
        >
            {dragHandleProps && (
                <button
                    {...dragHandleProps}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-white cursor-grab active:cursor-grabbing"
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                >
                    <GripVertical className="w-5 h-5" />
                </button>
            )}
            <div className="relative flex-shrink-0 w-12 h-12">
                {episode.coverUrl ? (
                    <Image
                        src={episode.coverUrl}
                        alt={episode.podcastTitle}
                        fill
                        sizes="48px"
                        className="object-cover rounded-sm"
                        unoptimized
                    />
                ) : (
                    <div className="w-12 h-12 bg-surface rounded-sm flex items-center justify-center">
                        <Music className="w-5 h-5 text-gray-400" />
                    </div>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-white truncate">
                    {episode.title}
                </h3>
                <p className="text-sm text-gray-400 truncate">
                    {episode.podcastTitle}
                </p>
                <p className="text-[11px] text-gray-400 truncate">
                    Podcast episode
                </p>
            </div>
            {(onPlay || onRemove) && (
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {onPlay && (
                        <button
                            onClick={onPlay}
                            className="p-2 hover:bg-surface rounded-md transition-colors"
                            title="Play now"
                            aria-label="Play now"
                        >
                            <Play className="w-4 h-4" />
                        </button>
                    )}
                    {onRemove && (
                        <button
                            onClick={onRemove}
                            className="p-2 hover:bg-surface rounded-md transition-colors text-red-400 hover:text-red-300"
                            title="Remove from queue"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
            )}
            <span className="text-xs text-gray-400 w-10 text-right tabular-nums">
                {formatTime(episode.duration)}
            </span>
        </div>
    );
}

/** Virtualized row for the "Next Up" section. */
function NextTrackRow({
    track,
    queueIndex,
    queueLength,
    currentIndex,
    isInGroup,
    resolveQueueSource,
    onMoveUp,
    onMoveDown,
    onPlay,
    onRemove,
    trackAvailability,
    dragHandleProps,
}: {
    track: Track;
    queueIndex: number;
    queueLength: number;
    currentIndex: number;
    isInGroup: boolean;
    resolveQueueSource: (
        index: number,
        fallback?: "peer" | "tidal" | "youtube" | "youtube-direct",
    ) => "local" | "peer" | "tidal" | "youtube";
    onMoveUp: (index: number) => void;
    onMoveDown: (index: number) => void;
    onPlay: (index: number) => void;
    onRemove: (index: number) => void;
    trackAvailability: Map<number, AvailabilityItem>;
    dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        draggable?: boolean;
    };
}) {
    const availability = isInGroup
        ? trackAvailability.get(queueIndex)
        : undefined;
    const isUnavailable =
        availability?.available === false ||
        (track.source === "federated" && track.peer?.online === false);
    const resolvedSource = resolveQueueSource(queueIndex, track.streamSource);

    return (
        <div
            className={`flex items-center gap-4 p-4 hover:bg-surface-hover transition-colors group border-b border-surface-active ${isUnavailable ? "opacity-50" : ""}`}
        >
            {!isInGroup && dragHandleProps && (
                <button
                    {...dragHandleProps}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-white cursor-grab active:cursor-grabbing"
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                >
                    <GripVertical className="w-5 h-5" />
                </button>
            )}
            <div className="relative flex-shrink-0 w-12 h-12">
                {track.album?.coverArt ? (
                    <Image
                        src={api.getCoverArtUrl(track.album.coverArt, 100)}
                        alt={track.album.title}
                        fill
                        sizes="48px"
                        className="object-cover rounded-sm"
                        unoptimized
                    />
                ) : (
                    <div className="w-12 h-12 bg-surface rounded-sm flex items-center justify-center">
                        <Music className="w-5 h-5 text-gray-400" />
                    </div>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-white truncate">
                    {track.displayTitle ?? track.title}
                </h3>
                <p className="text-sm text-gray-400 truncate">
                    {track.artist?.name}
                </p>
                <div className="mt-1 flex items-center gap-2">
                    {isUnavailable ? (
                        <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-500/50 rounded px-1.5 py-0.5">
                            Unavailable
                        </span>
                    ) : null}
                    {isInGroup && resolvedSource === "tidal" ? (
                        <TidalBadge />
                    ) : null}
                    {isInGroup && resolvedSource === "youtube" ? (
                        <YouTubeBadge />
                    ) : null}
                    {track.source === "federated" && track.peer ? (
                        <PeerBadge
                            peerName={track.peer.name}
                            online={track.peer.online}
                        />
                    ) : null}
                </div>
                {track.album?.title && (
                    <p className="text-[11px] text-gray-400 truncate">
                        {track.album.title}
                    </p>
                )}
            </div>
            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {!isInGroup && (
                    <>
                        <button
                            onClick={() => onMoveUp(queueIndex)}
                            disabled={queueIndex <= currentIndex + 1}
                            className="p-2 hover:bg-surface rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Move up"
                            aria-label="Move up"
                        >
                            <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => onMoveDown(queueIndex)}
                            disabled={queueIndex >= queueLength - 1}
                            className="p-2 hover:bg-surface rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Move down"
                            aria-label="Move down"
                        >
                            <ChevronDown className="w-4 h-4" />
                        </button>
                    </>
                )}
                <button
                    onClick={() => onPlay(queueIndex)}
                    disabled={isUnavailable}
                    className="p-2 hover:bg-surface rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Play now"
                    aria-label="Play now"
                >
                    <Play className="w-4 h-4" />
                </button>
            </div>
            <div className="flex items-center gap-1">
                <span className="text-xs text-gray-400 w-10 text-right tabular-nums">
                    {formatTime(track.duration)}
                </span>
                <TrackPreferenceButtons
                    trackId={track.id}
                    mode="up-only"
                    buttonSizeClassName="h-8 w-8"
                    iconSizeClassName="h-4 w-4"
                    metadata={buildPreferenceMetadata(track)}
                />
                <TrackOverflowMenu
                    track={track}
                    showPlayNext={false}
                    showAddToQueue={false}
                    extraItemsAfter={
                        <TrackMenuButton
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove(queueIndex);
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
}

/** Virtualized row for the "Previously Played" section. */
function PreviousTrackRow({
    track,
    idx,
    isInGroup,
    resolveQueueSource,
    trackAvailability,
}: {
    track: Track;
    idx: number;
    isInGroup: boolean;
    resolveQueueSource: (
        index: number,
        fallback?: "peer" | "tidal" | "youtube" | "youtube-direct",
    ) => "local" | "peer" | "tidal" | "youtube";
    trackAvailability: Map<number, AvailabilityItem>;
}) {
    const availability = isInGroup ? trackAvailability.get(idx) : undefined;
    const isUnavailable =
        availability?.available === false ||
        (track.source === "federated" && track.peer?.online === false);
    const resolvedSource = resolveQueueSource(idx, track.streamSource);

    return (
        <div
            className={`flex items-center gap-4 p-4 hover:bg-surface-hover transition-colors group opacity-50 border-b border-surface-active ${isUnavailable ? "opacity-30" : ""}`}
        >
            <div className="relative flex-shrink-0 w-12 h-12">
                {track.album?.coverArt ? (
                    <Image
                        src={api.getCoverArtUrl(track.album.coverArt, 100)}
                        alt={track.album.title}
                        fill
                        sizes="48px"
                        className="object-cover rounded-sm"
                        unoptimized
                    />
                ) : (
                    <div className="w-12 h-12 bg-surface rounded-sm flex items-center justify-center">
                        <Music className="w-5 h-5 text-gray-400" />
                    </div>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-white truncate">
                    {track.title}
                </h3>
                <p className="text-sm text-gray-400 truncate">
                    {track.artist?.name}
                </p>
                <div className="mt-1 flex items-center gap-2">
                    {isUnavailable ? (
                        <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-500/50 rounded px-1.5 py-0.5">
                            Unavailable
                        </span>
                    ) : null}
                    {isInGroup && resolvedSource === "tidal" ? (
                        <TidalBadge />
                    ) : null}
                    {isInGroup && resolvedSource === "youtube" ? (
                        <YouTubeBadge />
                    ) : null}
                    {track.source === "federated" && track.peer ? (
                        <PeerBadge
                            peerName={track.peer.name}
                            online={track.peer.online}
                        />
                    ) : null}
                </div>
                {track.album?.title && (
                    <p className="text-[11px] text-gray-400 truncate">
                        {track.album.title}
                    </p>
                )}
            </div>
            <div className="flex items-center gap-1">
                <span className="text-xs text-gray-400 w-10 text-right tabular-nums">
                    {formatTime(track.duration)}
                </span>
                <TrackPreferenceButtons
                    trackId={track.id}
                    mode="up-only"
                    buttonSizeClassName="h-8 w-8"
                    iconSizeClassName="h-4 w-4"
                    metadata={buildPreferenceMetadata(track)}
                />
                <TrackOverflowMenu
                    track={track}
                    showPlayNext={false}
                    showAddToQueue={false}
                />
            </div>
        </div>
    );
}
