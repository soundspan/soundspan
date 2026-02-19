import React, { memo, useCallback, useMemo } from "react";
import { Card } from "@/components/ui/Card";
import {
    Play,
    Pause,
    Volume2,
    Disc,
} from "lucide-react";
import { cn } from "@/utils/cn";
import type { Track, Album, AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";
import { formatNumber } from "@/utils/formatNumber";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { toast } from "sonner";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";

interface TrackListProps {
    tracks: Track[];
    album: Album;
    source: AlbumSource;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number) => void;
    previewTrack: string | null;
    previewPlaying: boolean;
    onPreview: (track: Track, e: React.MouseEvent) => void;
    isInListenTogetherGroup?: boolean;
}

interface TrackRowProps {
    track: Track;
    index: number;
    album: Album;
    isOwned: boolean;
    isPlaying: boolean;
    isPreviewPlaying: boolean;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number) => void;
    onPreview: (track: Track, e: React.MouseEvent) => void;
    isInListenTogetherGroup: boolean;
    isInQueue: boolean;
}



const TrackRow = memo(
    function TrackRow({
        track,
        index,
        album,
        isOwned,
        isPlaying,
        isPreviewPlaying,
        colors,
        onPlayTrack,
        onPreview,
        isInListenTogetherGroup,
        isInQueue,
    }: TrackRowProps) {
        const isYouTubeTrack = track.streamSource === "youtube";
        const isTidalTrack = track.streamSource === "tidal" && !!track.tidalTrackId;
        const hasLocalFile =
            typeof track.filePath === "string" &&
            track.filePath.trim().length > 0;
        const isLocalLibraryTrack =
            !isTidalTrack &&
            !isYouTubeTrack &&
            (isOwned || hasLocalFile || Boolean(track.album?.id));
        const blockedByListenTogether = isInListenTogetherGroup && !isLocalLibraryTrack;
        const isPlayable = (isOwned || isTidalTrack || isYouTubeTrack) && !blockedByListenTogether;
        const isPreviewOnly = !isPlayable;

        const handlePreview = useCallback(
            (e: React.MouseEvent) => {
                onPreview(track, e);
            },
            [track, onPreview]
        );

        const handlePlayTrack = useCallback(() => {
            onPlayTrack(track, index);
        }, [track, index, onPlayTrack]);

        const handleRowClick = useCallback(
            (e: React.MouseEvent) => {
                // For unowned tracks without streaming, play preview instead
                if (blockedByListenTogether) {
                    toast.error("Listen Together only supports local library tracks");
                    return;
                }

                if (isPreviewOnly) {
                    onPreview(track, e);
                } else {
                    // Owned tracks and YouTube Music tracks play normally
                    onPlayTrack(track, index);
                }
            },
            [blockedByListenTogether, isPreviewOnly, track, index, onPlayTrack, onPreview]
        );

        // Build the track object for the overflow menu
        const overflowTrack = {
            id: track.id,
            title: track.displayTitle ?? track.title,
            artist: { name: track.artist?.name ?? album.artist?.name ?? "", id: track.artist?.id ?? album.artist?.id },
            album: { title: album.title, coverArt: album.coverArt, id: album.id },
            duration: track.duration ?? 0,
            streamSource: track.streamSource === "tidal" || track.streamSource === "youtube" ? track.streamSource : undefined,
        };

        return (
            <div
                data-track-row
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className={cn(
                    "group relative flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 hover:bg-[#141414] transition-colors cursor-pointer",
                    isPlaying && "bg-[#1a1a1a] border-l-2",
                    isInQueue &&
                        !isPlaying &&
                        !blockedByListenTogether &&
                        "bg-[#3b82f6]/[0.06]",
                    isPreviewOnly && "opacity-70 hover:opacity-90",
                    blockedByListenTogether && "border border-red-500/30 bg-red-500/5"
                )}
                style={
                    isPlaying
                        ? { borderLeftColor: colors?.vibrant || "#2323FF" }
                        : undefined
                }
                onClick={handleRowClick}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        if (blockedByListenTogether) {
                            toast.error("Listen Together only supports local library tracks");
                            return;
                        }
                        if (isPreviewOnly) {
                            onPreview(track, e as unknown as React.MouseEvent);
                        } else {
                            handlePlayTrack();
                        }
                    }
                }}
            >
                <div className="w-6 md:w-8 flex-shrink-0 text-center">
                    <span
                        className={cn(
                            "group-hover:hidden text-sm",
                            isPlaying
                                ? "text-[#5b5bff] font-bold"
                                : "text-gray-500"
                        )}
                    >
                        {track.trackNumber || track.trackNo || track.displayTrackNo || index + 1}
                    </span>
                    <Play
                        className="hidden group-hover:inline-block w-4 h-4 text-white"
                        fill="currentColor"
                    />
                </div>

                <div className="flex-1 min-w-0">
                    <div
                        className={cn(
                            "font-medium truncate text-sm md:text-base flex items-center gap-2",
                            isPlaying ? "text-[#5b5bff]" : "text-white"
                        )}
                    >
                        <span className="truncate">
                            {track.displayTitle ?? track.title}
                        </span>
                        {isTidalTrack && <TidalBadge />}
                        {isYouTubeTrack && <YouTubeBadge />}
                        {isPreviewOnly && (
                            <span className="shrink-0 text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30 font-medium">
                                PREVIEW
                            </span>
                        )}
                        {blockedByListenTogether && (
                            <span className="shrink-0 text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded border border-red-500/30 font-medium">
                                LOCAL ONLY
                            </span>
                        )}
                        {isInQueue && (
                            <span className="shrink-0 text-[10px] bg-[#3b82f6]/15 text-[#93c5fd] px-1.5 py-0.5 rounded border border-[#3b82f6]/30 font-medium">
                                IN QUEUE
                            </span>
                        )}
                    </div>
                    {track.artist?.name &&
                        track.artist.name !== album.artist?.name && (
                            <div className="text-xs md:text-sm text-gray-400 truncate">
                                {track.artist.name}
                            </div>
                        )}
                </div>

                {isPlayable &&
                    track.playCount !== undefined &&
                    track.playCount > 0 && (
                        <div className="hidden lg:flex items-center gap-1.5 text-xs text-gray-400 bg-[#1a1a1a] px-2 py-1 rounded-full">
                            <Play className="w-3 h-3" />
                            <span>{formatNumber(track.playCount)}</span>
                        </div>
                    )}

                {isPreviewOnly && (
                    <button
                        onClick={handlePreview}
                        className="p-2 rounded-full bg-[#1a1a1a] hover:bg-[#2a2a2a] transition-colors text-white"
                        aria-label={
                            isPreviewPlaying ? "Pause preview" : "Play preview"
                        }
                    >
                        {isPreviewPlaying ? (
                            <Pause className="w-4 h-4" />
                        ) : (
                            <Volume2 className="w-4 h-4" />
                        )}
                    </button>
                )}

                <div className="text-xs md:text-sm text-gray-400 w-10 md:w-12 text-right tabular-nums">
                    {track.duration ? formatTime(track.duration) : ""}
                </div>

                {(isPlayable || blockedByListenTogether) && (
                    <TrackOverflowMenu
                        track={overflowTrack}
                        showGoToAlbum={false}
                        isInListenTogetherGroup={isInListenTogetherGroup}
                    />
                )}

                <div className="ml-1 flex w-[96px] flex-shrink-0 items-center justify-end md:w-[104px]">
                    <TrackPreferenceButtons
                        trackId={track.id}
                        buttonSizeClassName="h-10 w-10"
                        iconSizeClassName="h-5 w-5"
                    />
                </div>
            </div>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.track.id === nextProps.track.id &&
            prevProps.track.streamSource === nextProps.track.streamSource &&
            prevProps.isPlaying === nextProps.isPlaying &&
            prevProps.isPreviewPlaying === nextProps.isPreviewPlaying &&
            prevProps.isInQueue === nextProps.isInQueue &&
            prevProps.index === nextProps.index &&
            prevProps.isOwned === nextProps.isOwned &&
            prevProps.isInListenTogetherGroup ===
                nextProps.isInListenTogetherGroup
        );
    }
);

export const TrackList = memo(function TrackList({
    tracks,
    album,
    source,
    currentTrackId,
    colors,
    onPlayTrack,
    previewTrack,
    previewPlaying,
    onPreview,
    isInListenTogetherGroup = false,
}: TrackListProps) {
    const isOwned = source === "library";
    const queuedTrackIds = useQueuedTrackIds();

    // Detect if this is a multi-disc album
    const isMultiDisc = useMemo(() => {
        if (!tracks?.length) return false;
        const discs = new Set(tracks.map((t) => t.discNumber ?? t.discNo ?? 1));
        return discs.size > 1;
    }, [tracks]);

    return (
        <section>
            <Card>
                <div
                    data-tv-section="tracks"
                    className="divide-y divide-[#1c1c1c]"
                >
                    {tracks.map((track, index) => {
                        const isPlaying = currentTrackId === track.id;
                        const isInQueue = queuedTrackIds.has(track.id);
                        const isPreviewPlaying =
                            previewTrack === track.id && previewPlaying;

                        // Show disc separator before the first track of each new disc
                        const currentDisc = track.discNumber ?? track.discNo ?? 1;
                        const prevDisc = index > 0 ? (tracks[index - 1].discNumber ?? tracks[index - 1].discNo ?? 1) : 0;
                        const showDiscSeparator = isMultiDisc && (index === 0 || currentDisc !== prevDisc);

                        return (
                            <React.Fragment key={track.id}>
                                {showDiscSeparator && (
                                    <div className="flex items-center gap-2 px-3 md:px-4 py-2.5 bg-[#0d0d0d] border-b border-[#1c1c1c]">
                                        <Disc className="w-3.5 h-3.5 text-gray-500" />
                                        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                                            Disc {currentDisc}
                                        </span>
                                    </div>
                                )}
                                <TrackRow
                                    track={track}
                                    index={index}
                                    album={album}
                                    isOwned={isOwned}
                                    isPlaying={isPlaying}
                                    isPreviewPlaying={isPreviewPlaying}
                                    colors={colors}
                                    onPlayTrack={onPlayTrack}
                                    onPreview={onPreview}
                                    isInListenTogetherGroup={isInListenTogetherGroup}
                                    isInQueue={isInQueue}
                                />
                            </React.Fragment>
                        );
                    })}
                </div>
            </Card>
        </section>
    );
});
