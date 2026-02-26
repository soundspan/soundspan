import { useState } from "react";
import {
    Play,
    Pause,
    Shuffle,
    Download,
    ListMusic,
    Plus,
    Loader2,
    Search,
    ThumbsUp,
} from "lucide-react";
import { cn } from "@/utils/cn";
import type { Album } from "../types";
import type { AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { toast } from "sonner";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { ReleaseSelectionModal } from "@/components/ui/ReleaseSelectionModal";

const BRAND_PLAY = "#60a5fa";

interface AlbumActionBarProps {
    album: Album;
    source: AlbumSource;
    colors: ColorPalette | null;
    onPlayAll: () => void;
    onAddAllToQueue?: () => void;
    onShuffle: () => void;
    onDownloadAlbum: () => void;
    onAddToPlaylist: () => void;
    onThumbsUpAlbum?: () => void;
    isPendingDownload: boolean;
    isApplyingAlbumPreference?: boolean;
    isPlaying?: boolean;
    isPlayingThisAlbum?: boolean;
    onPause?: () => void;
    downloadsEnabled?: boolean;
    isInListenTogetherGroup?: boolean;
}

export function AlbumActionBar({
    album,
    source,
    colors: _colors,
    onPlayAll,
    onAddAllToQueue,
    onShuffle,
    onDownloadAlbum,
    onAddToPlaylist,
    onThumbsUpAlbum,
    isPendingDownload,
    isApplyingAlbumPreference = false,
    isPlaying = false,
    isPlayingThisAlbum = false,
    onPause,
    downloadsEnabled = true,
    isInListenTogetherGroup = false,
}: AlbumActionBarProps) {
    const [showReleaseModal, setShowReleaseModal] = useState(false);
    const isOwned = album.owned !== undefined ? album.owned : source === "library";
    const showDownload = downloadsEnabled && !isOwned && (album.mbid || album.rgMbid);
    const albumMbid = album.rgMbid || album.mbid || album.id;
    const showPause = isPlaying && isPlayingThisAlbum;
    const hasLockedControls = isOwned || showDownload;
    const lockMessage = "Listen Together is active. Play, shuffle, and download are disabled here.";
    const canShowAddAllToQueue = Boolean(onAddAllToQueue);
    const canShowAddToPlaylist = isOwned;
    const canShowAlbumPreference = isOwned && Boolean(onThumbsUpAlbum);
    const hasActionControls =
        isInListenTogetherGroup
            ? hasLockedControls ||
                canShowAddAllToQueue ||
                canShowAddToPlaylist ||
                canShowAlbumPreference
            : isOwned ||
                showDownload ||
                canShowAddAllToQueue ||
                canShowAddToPlaylist ||
                canShowAlbumPreference;
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();

    const handleLockedAction = () => {
        toast.error(lockMessage);
    };

    const handlePlayPauseClick = () => {
        triggerPlayFeedback();
        if (showPause && onPause) {
            onPause();
        } else {
            onPlayAll();
        }
    };

    return (
        <div className="space-y-2">
            {hasActionControls && (
                <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-2.5 py-2 backdrop-blur-sm">
                    {isInListenTogetherGroup ? (
                        hasLockedControls ? (
                            <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-red-500/50 bg-red-500/10 px-2.5 py-1.5">
                                {isOwned && (
                                    <>
                                        <button
                                            onClick={handleLockedAction}
                                            className="flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg font-semibold text-sm border border-red-400/60 bg-red-500/20 text-red-100"
                                            title={lockMessage}
                                        >
                                            {showPause ? (
                                                <Pause className="w-5 h-5 fill-current" />
                                            ) : (
                                                <Play className="w-5 h-5 fill-current ml-0.5" />
                                            )}
                                            <span>{showPause ? "Pause" : "Play All"}</span>
                                        </button>

                                        <button
                                            onClick={handleLockedAction}
                                            className="h-8 w-8 rounded-full border border-red-400/50 bg-red-500/10 flex items-center justify-center text-red-100"
                                            title={lockMessage}
                                        >
                                            <Shuffle className="w-5 h-5" />
                                        </button>
                                    </>
                                )}

                                {showDownload && (
                                    <>
                                        <button
                                            onClick={handleLockedAction}
                                            className={cn(
                                                "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium border border-red-400/50 bg-red-500/10 text-red-100",
                                                isPendingDownload && "opacity-70"
                                            )}
                                            title={lockMessage}
                                        >
                                            <Download className="w-4 h-4" />
                                            <span>
                                                {isPendingDownload ? "Downloading..." : "Download"}
                                            </span>
                                        </button>
                                        <button
                                            onClick={handleLockedAction}
                                            className="flex items-center gap-2 rounded-full border border-red-400/50 bg-red-500/10 px-4 py-2.5 font-medium text-red-100"
                                            title={lockMessage}
                                        >
                                            <Search className="w-4 h-4" />
                                            <span>Search</span>
                                        </button>
                                    </>
                                )}
                            </div>
                        ) : null
                    ) : (
                        <>
                    {/* Play Button - only for owned albums */}
                    {isOwned && (
                        <>
                            <button
                                onClick={handlePlayPauseClick}
                                className="flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg font-semibold text-sm text-black transition-all hover:scale-105"
                                style={{ backgroundColor: BRAND_PLAY }}
                            >
                                {showPlaySpinner ? (
                                    <Loader2 className="w-5 h-5 animate-spin text-black" />
                                ) : showPause ? (
                                    <Pause className="w-5 h-5 fill-current text-black" />
                                ) : (
                                    <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                                )}
                                <span>{showPause ? "Pause" : "Play All"}</span>
                            </button>

                            {/* Shuffle Button */}
                            <button
                                onClick={onShuffle}
                                className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                                title="Shuffle play"
                            >
                                <Shuffle className="w-5 h-5" />
                            </button>
                        </>
                    )}

                    {/* Download Album Button - prominent for unowned */}
                    {showDownload && (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={onDownloadAlbum}
                                disabled={isPendingDownload}
                                className={cn(
                                    "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium transition-all",
                                    isPendingDownload
                                        ? "bg-white/5 text-white/50 cursor-not-allowed"
                                        : "bg-[#60a5fa] hover:bg-[#3b82f6] text-black hover:scale-105"
                                )}
                                title="Auto-download best release"
                            >
                                <Download className="w-4 h-4" />
                                <span>
                                    {isPendingDownload ? "Downloading..." : "Download"}
                                </span>
                            </button>
                            <button
                                onClick={() => setShowReleaseModal(true)}
                                disabled={isPendingDownload}
                                className={cn(
                                    "flex items-center gap-2 px-4 py-2.5 rounded-full font-medium transition-all",
                                    isPendingDownload
                                        ? "bg-white/5 text-white/50 cursor-not-allowed"
                                        : "bg-[#60a5fa] hover:bg-[#3b82f6] text-black hover:scale-105"
                                )}
                                title="Search and select a specific release"
                            >
                                <Search className="w-4 h-4" />
                                <span>Search</span>
                            </button>
                        </div>
                    )}
                        </>
                    )}

                    {onAddAllToQueue && (
                        <button
                            onClick={onAddAllToQueue}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Add all to queue"
                        >
                            <ListMusic className="w-5 h-5" />
                        </button>
                    )}

                    {/* Add to Playlist Button */}
                    {isOwned && (
                        <button
                            onClick={onAddToPlaylist}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Add to playlist"
                        >
                            <Plus className="w-5 h-5" />
                        </button>
                    )}

                    {canShowAlbumPreference && (
                        <div className="flex items-center gap-1.5">
                            {onThumbsUpAlbum && (
                                <button
                                    onClick={onThumbsUpAlbum}
                                    disabled={isApplyingAlbumPreference}
                                    className={cn(
                                        "h-8 w-8 rounded-full flex items-center justify-center transition-colors",
                                        isApplyingAlbumPreference ?
                                            "cursor-not-allowed text-white/35"
                                        :   "text-white/60 hover:bg-white/10 hover:text-white"
                                    )}
                                    title="Like every track on this album"
                                >
                                    {isApplyingAlbumPreference ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <ThumbsUp className="h-4 w-4" />
                                    )}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {isInListenTogetherGroup && hasLockedControls && (
                <p className="text-xs text-red-300">
                    {lockMessage}
                </p>
            )}

            {showDownload && (
                <ReleaseSelectionModal
                    isOpen={showReleaseModal}
                    onClose={() => setShowReleaseModal(false)}
                    albumMbid={albumMbid}
                    artistName={album.artist?.name || "Unknown Artist"}
                    albumTitle={album.title}
                />
            )}
        </div>
    );
}
