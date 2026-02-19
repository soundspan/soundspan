import React from "react";
import { Play, Pause, Volume2, Music, ListPlus } from "lucide-react";
import { cn } from "@/utils/cn";
import Image from "next/image";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";
import { formatNumber } from "@/utils/formatNumber";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { toast } from "sonner";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";

interface PopularTracksProps {
    tracks: Track[];
    artist: Artist;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track) => void;
    previewTrack: string | null;
    previewPlaying: boolean;
    onPreview: (track: Track, e: React.MouseEvent) => void;
    isInListenTogetherGroup?: boolean;
    popularHref?: string;
    onAddAllToQueue?: () => void;
}

export const PopularTracks: React.FC<PopularTracksProps> = ({
    tracks,
    artist,
    currentTrackId,
    colors: _colors,
    onPlayTrack,
    previewTrack,
    previewPlaying,
    onPreview,
    isInListenTogetherGroup = false,
    popularHref,
    onAddAllToQueue,
}) => {
    const queuedTrackIds = useQueuedTrackIds();

    return (
        <section id="popular" className="scroll-mt-28">
            <div className="mb-4 flex flex-wrap items-center gap-3 justify-between">
                <h2 className="text-xl font-bold">
                    {popularHref ? (
                        <Link
                            href={popularHref}
                            className="inline-flex items-center hover:text-[#3b82f6] transition-colors"
                        >
                            Popular
                        </Link>
                    ) : (
                        "Popular"
                    )}
                </h2>
                {isInListenTogetherGroup && onAddAllToQueue && (
                    <button
                        onClick={onAddAllToQueue}
                        className="inline-flex items-center gap-2 rounded-full bg-[#60a5fa] hover:bg-[#3b82f6] px-3 py-1.5 text-xs font-semibold text-black transition-colors"
                        title="Add all visible popular tracks to shared queue"
                    >
                        <ListPlus className="w-3.5 h-3.5" />
                        <span>Add All to Queue</span>
                    </button>
                )}
            </div>
            <div data-tv-section="tracks">
                {tracks.slice(0, 5).map((track, index) => {
                    const isPlaying = currentTrackId === track.id;
                    const isInQueue = queuedTrackIds.has(track.id);
                    const isPreviewPlaying =
                        previewTrack === track.id && previewPlaying;
                    const isUnowned =
                        !track.album?.id ||
                        !track.album?.title ||
                        track.album.title === "Unknown Album";
                    const isYtMusic =
                        track.streamSource === "youtube" &&
                        !!track.youtubeVideoId;
                    const isTidalTrack = track.streamSource === "tidal" && !!track.tidalTrackId;
                    const isPreviewOnly = isUnowned && !isTidalTrack && !isYtMusic;
                    const hasLocalFile =
                        typeof track.filePath === "string" &&
                        track.filePath.trim().length > 0;
                    const isLocalLibraryTrack =
                        !isTidalTrack &&
                        !isYtMusic &&
                        (hasLocalFile || Boolean(track.album?.id));
                    const blockedByListenTogether = isInListenTogetherGroup && !isLocalLibraryTrack;
                    const coverUrl = track.album?.coverArt
                        ? api.getCoverArtUrl(track.album.coverArt, 80)
                        : null;

                    return (
                        <div
                            key={track.id}
                            data-track-row
                            data-tv-card
                            data-tv-card-index={index}
                            tabIndex={0}
                            className={cn(
                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(80px,1fr)_80px] gap-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                isPlaying && "bg-white/10",
                                isInQueue &&
                                    !isPlaying &&
                                    !blockedByListenTogether &&
                                    "bg-[#3b82f6]/[0.06]",
                                blockedByListenTogether && "border border-red-500/30 bg-red-500/5"
                            )}
                            onClick={(e) => {
                                if (blockedByListenTogether) {
                                    e.preventDefault();
                                    toast.error("Listen Together only supports local library tracks");
                                    return;
                                }
                                if (isPreviewOnly) {
                                    onPreview(track, e);
                                } else {
                                    onPlayTrack(track);
                                }
                            }}
                        >
                            {/* Track Number / Play Icon */}
                            <div className="flex items-center justify-center">
                                <span
                                    className={cn(
                                        "text-sm group-hover:hidden",
                                        isPlaying
                                            ? "text-[#3b82f6]"
                                            : "text-gray-400"
                                    )}
                                >
                                    {isPlaying ? (
                                        <Music className="w-4 h-4 text-[#3b82f6] animate-pulse" />
                                    ) : (
                                        index + 1
                                    )}
                                </span>
                                <Play className="w-4 h-4 text-white hidden group-hover:block" />
                            </div>

                            {/* Title + Album Art */}
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                    {coverUrl ? (
                                        <Image
                                            src={coverUrl}
                                            alt={track.title}
                                            width={40}
                                            height={40}
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
                                    <div
                                        className={cn(
                                            "text-sm font-medium truncate flex items-center gap-2",
                                            isPlaying
                                                ? "text-[#3b82f6]"
                                                : "text-white"
                                        )}
                                    >
                                        <span className="truncate">
                                            {track.displayTitle ?? track.title}
                                        </span>
                                        {isTidalTrack && <TidalBadge />}
                                        {isYtMusic && (
                                            <span className="shrink-0 text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-medium">
                                                YT MUSIC
                                            </span>
                                        )}
                                        {isPreviewOnly && (
                                            <span className="shrink-0 text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-medium">
                                                PREVIEW
                                            </span>
                                        )}
                                        {blockedByListenTogether && (
                                            <span className="shrink-0 text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded font-medium border border-red-500/30">
                                                LOCAL ONLY
                                            </span>
                                        )}
                                        {isInQueue && (
                                            <span className="shrink-0 text-[10px] bg-[#3b82f6]/15 text-[#93c5fd] px-1.5 py-0.5 rounded font-medium border border-[#3b82f6]/30">
                                                IN QUEUE
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-400 truncate">
                                        {artist.name}
                                    </p>
                                </div>
                            </div>

                            {/* Play Count (hidden on mobile) */}
                            <div className="hidden md:flex items-center text-sm text-gray-400">
                                {track.playCount !== undefined &&
                                    track.playCount > 0 && (
                                        <span className="flex items-center gap-1">
                                            <Play className="w-3 h-3" />
                                            {formatNumber(track.playCount)}
                                        </span>
                                    )}
                            </div>

                            {/* Duration + Preview + Overflow */}
                            <div className="flex items-center justify-end gap-2">
                                {isPreviewOnly && !blockedByListenTogether && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onPreview(track, e);
                                        }}
                                        className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                                    >
                                        {isPreviewPlaying ? (
                                            <Pause className="w-4 h-4" />
                                        ) : (
                                            <Volume2 className="w-4 h-4" />
                                        )}
                                    </button>
                                )}
                                {track.duration > 0 && (
                                    <span className="text-sm text-gray-400 w-10 text-right">
                                        {formatTime(track.duration)}
                                    </span>
                                )}
                                <TrackOverflowMenu
                                    track={{
                                        id: track.id,
                                        title: track.displayTitle ?? track.title,
                                        artist: { name: track.artist?.name ?? artist.name, id: track.artist?.id ?? artist.id },
                                        album: track.album ? { title: track.album.title ?? "", id: track.album.id, coverArt: track.album.coverArt } : { title: "" },
                                        duration: track.duration,
                                        streamSource: track.streamSource === "tidal" || track.streamSource === "youtube" ? track.streamSource : undefined,
                                    }}
                                    isInListenTogetherGroup={isInListenTogetherGroup}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
};
