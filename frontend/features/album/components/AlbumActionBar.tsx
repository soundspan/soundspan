import { useState } from "react";
import {
    Play,
    Pause,
    Shuffle,
    Download,
    ListMusic,
    Plus,
    Share2,
    Loader2,
    Search,
    Heart,
} from "lucide-react";
import { cn } from "@/utils/cn";
import type { Album } from "../types";
import type { AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { toast } from "sonner";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { ReleaseSelectionModal } from "@/components/ui/ReleaseSelectionModal";
import { ShareLinkModal } from "@/components/ui/ShareLinkModal";

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
    onToggleAlbumLike?: () => void;
    isAlbumLiked?: boolean;
    isPendingDownload: boolean;
    isApplyingAlbumPreference?: boolean;
    isPlaying?: boolean;
    isPlayingThisAlbum?: boolean;
    onPause?: () => void;
    downloadsEnabled?: boolean;
    isInListenTogetherGroup?: boolean;
}

/**
 * Renders the AlbumActionBar component.
 */
export function AlbumActionBar({
    album,
    source,
    colors: _colors,
    onPlayAll,
    onAddAllToQueue,
    onShuffle,
    onDownloadAlbum,
    onAddToPlaylist,
    onToggleAlbumLike,
    isAlbumLiked = false,
    isPendingDownload,
    isApplyingAlbumPreference = false,
    isPlaying = false,
    isPlayingThisAlbum = false,
    onPause,
    downloadsEnabled = true,
    isInListenTogetherGroup = false,
}: AlbumActionBarProps) {
    const [showReleaseModal, setShowReleaseModal] = useState(false);
    const [showShareModal, setShowShareModal] = useState(false);
    const isOwned = album.owned !== undefined ? album.owned : source === "library";
    const showDownload = downloadsEnabled && !isOwned && (album.mbid || album.rgMbid);
    const albumMbid = album.rgMbid || album.mbid || album.id;
    const showPause = isPlaying && isPlayingThisAlbum;
    const hasLockedControls = isOwned || showDownload;
    const lockMessage = "Listen Together is active — use Add to Queue to add tracks to the shared session.";
    const canShowAddAllToQueue = Boolean(onAddAllToQueue);
    const canShowAddToPlaylist = isOwned;
    const canShowAlbumPreference = isOwned && Boolean(onToggleAlbumLike);
    const canShareAlbum = Boolean(album.id);
    const hasActionControls =
        isInListenTogetherGroup
            ? hasLockedControls ||
                canShowAddAllToQueue ||
                canShowAddToPlaylist ||
                canShowAlbumPreference ||
                canShareAlbum
            : isOwned ||
                showDownload ||
                canShowAddAllToQueue ||
                canShowAddToPlaylist ||
                canShowAlbumPreference ||
                canShareAlbum;
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
                            <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5">
                                {isOwned && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={handleLockedAction}
                                            className="flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg font-semibold text-sm border border-white/15 bg-white/10 text-white/40"
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
                                            type="button"
                                            onClick={handleLockedAction}
                                            className="h-8 w-8 rounded-full border border-white/15 bg-white/10 flex items-center justify-center text-white/40"
                                            title={lockMessage}
                                        >
                                            <Shuffle className="w-5 h-5" />
                                        </button>
                                    </>
                                )}

                                {showDownload && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={handleLockedAction}
                                            className={cn(
                                                "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium border border-white/15 bg-white/10 text-white/40",
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
                                            type="button"
                                            onClick={handleLockedAction}
                                            className="flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2.5 font-medium text-white/40"
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
                                type="button"
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
                                 type="button"
                                 onClick={onShuffle}
                                 className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                                 title="Shuffle play"
                             >
                                 <Shuffle className="w-5 h-5" />
                             </button>

                            {canShareAlbum && (
                                <button
                                    type="button"
                                    onClick={() => setShowShareModal(true)}
                                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                                    title="Share album"
                                >
                                    <Share2 className="w-5 h-5" />
                                </button>
                            )}
                         </>
                     )}

                    {/* Download Album Button - prominent for unowned */}
                    {showDownload && (
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
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
                                type="button"
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

                    {/* Add to Queue Button */}
                     {onAddAllToQueue && (
                        <button
                            type="button"
                            onClick={onAddAllToQueue}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Add all to queue"
                        >
                            <ListMusic className="w-5 h-5" />
                         </button>
                     )}

                    {!isOwned && canShareAlbum && (
                        <button
                            type="button"
                            onClick={() => setShowShareModal(true)}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Share album"
                        >
                            <Share2 className="w-5 h-5" />
                        </button>
                    )}

                    {/* Add to Playlist Button */}
                    {isOwned && (
                        <button
                            type="button"
                            onClick={onAddToPlaylist}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Add to playlist"
                        >
                            <Plus className="w-5 h-5" />
                        </button>
                    )}

                    {canShowAlbumPreference && (
                        <div className="flex items-center gap-1.5">
                            {onToggleAlbumLike && (
                                <button
                                    type="button"
                                    onClick={onToggleAlbumLike}
                                    disabled={isApplyingAlbumPreference}
                                    className={cn(
                                        "h-8 w-8 rounded-full flex items-center justify-center transition-colors",
                                        isApplyingAlbumPreference ?
                                            "cursor-not-allowed text-white/35"
                                        : isAlbumLiked ?
                                            "text-[#3b82f6] hover:bg-white/10"
                                        :   "text-white/60 hover:bg-white/10 hover:text-white"
                                    )}
                                    title={isAlbumLiked ? "Remove like from all tracks" : "Like every track on this album"}
                                >
                                    {isApplyingAlbumPreference ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Heart className={cn("h-4 w-4", isAlbumLiked && "fill-current")} />
                                    )}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {isInListenTogetherGroup && hasLockedControls && (
                <p className="text-xs text-white/40">
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

            <ShareLinkModal
                isOpen={showShareModal}
                onClose={() => setShowShareModal(false)}
                resourceType="album"
                resourceId={album.id}
                resourceName={album.title}
            />
        </div>
    );
}
