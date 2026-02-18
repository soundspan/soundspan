import { Play, Pause, Shuffle, Download, Radio, ListMusic, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import type { Artist } from "../types";
import type { Album } from "../types";
import type { ArtistSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { toast } from "sonner";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";

const BRAND_PLAY = "#60a5fa";

interface ArtistActionBarProps {
    artist: Artist;
    albums: Album[];
    source: ArtistSource;
    colors: ColorPalette | null;
    onPlayAll: () => void;
    onShuffle: () => void;
    onDownloadAll: () => void;
    onAddAllToQueue?: () => void;
    onStartRadio?: () => void;
    isPendingDownload: boolean;
    isPlaying?: boolean;
    isPlayingThisArtist?: boolean;
    onPause?: () => void;
    downloadsEnabled?: boolean;
    isInListenTogetherGroup?: boolean;
}

export function ArtistActionBar({
    artist: _artist,
    albums,
    source,
    colors: _colors,
    onPlayAll,
    onShuffle,
    onDownloadAll,
    onAddAllToQueue,
    onStartRadio,
    isPendingDownload,
    isPlaying = false,
    isPlayingThisArtist = false,
    onPause,
    downloadsEnabled = true,
    isInListenTogetherGroup = false,
}: ArtistActionBarProps) {
    const availableAlbums = albums.filter(
        (album) => album.availability !== "unavailable"
    );
    const showDownloadAll = downloadsEnabled && (source === "discovery" || availableAlbums.length > 0);
    const showPause = isPlaying && isPlayingThisArtist;
    const showRadio = source === "library" && onStartRadio;
    const lockMessage = "Listen Together is active. Play and shuffle are disabled here.";
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
            <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-2.5 py-2 backdrop-blur-sm">
                {isInListenTogetherGroup ? (
                    <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-red-500/50 bg-red-500/10 px-2.5 py-1.5">
                        <button
                            onClick={handleLockedAction}
                            className="h-12 w-12 rounded-full flex items-center justify-center shadow-lg border border-red-400/60 bg-red-500/20 text-red-100"
                            title={lockMessage}
                        >
                            {showPause ? (
                                <Pause className="w-5 h-5 fill-current" />
                            ) : (
                                <Play className="w-5 h-5 fill-current ml-0.5" />
                            )}
                        </button>

                        <button
                            onClick={handleLockedAction}
                            className="h-8 w-8 rounded-full border border-red-400/50 bg-red-500/10 flex items-center justify-center text-red-100"
                            title={lockMessage}
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>

                    </div>
                ) : (
                    <>
                    {/* Play Button */}
                    <button
                        onClick={handlePlayPauseClick}
                        className="h-12 w-12 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105"
                        style={{ backgroundColor: BRAND_PLAY }}
                    >
                        {showPlaySpinner ? (
                            <Loader2 className="w-5 h-5 animate-spin text-black" />
                        ) : showPause ? (
                            <Pause className="w-5 h-5 fill-current text-black" />
                        ) : (
                            <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                        )}
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

                {showDownloadAll && (
                    <button
                        onClick={onDownloadAll}
                        disabled={isPendingDownload}
                        className={cn(
                            "h-8 w-8 rounded-full flex items-center justify-center transition-all",
                            isPendingDownload
                                ? "bg-white/5 text-white/50 cursor-not-allowed"
                                : "hover:bg-white/10 text-white/60 hover:text-white"
                        )}
                        title={isPendingDownload ? "Downloading all tracks" : "Download all tracks"}
                    >
                        {isPendingDownload ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                            <Download className="w-5 h-5" />
                        )}
                    </button>
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

                {/* Radio Button - Only for library artists */}
                {showRadio && (
                    <button
                        onClick={onStartRadio}
                        className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title="Start artist radio"
                    >
                        <Radio className="w-5 h-5" />
                    </button>
                )}
            </div>

            {isInListenTogetherGroup && (
                <p className="text-xs text-red-300">
                    {lockMessage}
                </p>
            )}
        </div>
    );
}
