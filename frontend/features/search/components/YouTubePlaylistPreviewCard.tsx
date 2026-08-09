"use client";

import { useState } from "react";
import { Download, Loader2, ChevronDown, ListVideo, X } from "lucide-react";
import type {
    BulkDownloadProgress,
    YouTubePlaylistInfo,
} from "@/lib/youtube-bulk-download";

interface YouTubePlaylistPreviewCardProps {
    playlistInfo: YouTubePlaylistInfo | null;
    isLoading: boolean;
    error: string | null;
    isDownloading: boolean;
    progress: BulkDownloadProgress | null;
    /**
     * Whether the current user may bulk-download (admin-only, matching the
     * backend gate). The playlist preview itself stays for everyone.
     */
    canDownload: boolean;
    onDownloadAll: (format: string, quality: string) => Promise<void>;
    onCancel: () => void;
}

const FORMAT_OPTIONS = [
    { label: "MP3 320kbps", format: "mp3", quality: "HIGH" },
    { label: "Opus", format: "opus", quality: "HIGH" },
    { label: "FLAC", format: "flac", quality: "LOSSLESS" },
] as const;

/** Number of entry titles shown in the preview before collapsing to "+N more". */
const PREVIEW_ROWS = 5;

export function YouTubePlaylistPreviewCard({
    playlistInfo,
    isLoading,
    error,
    isDownloading,
    progress,
    canDownload,
    onDownloadAll,
    onCancel,
}: YouTubePlaylistPreviewCardProps) {
    const [showFormatMenu, setShowFormatMenu] = useState(false);

    if (isLoading) {
        return (
            <section className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-4">YouTube</h2>
                <div className="bg-surface-sunken rounded-lg p-6 animate-pulse">
                    <div className="space-y-3">
                        <div className="h-5 bg-white/10 rounded w-1/2" />
                        <div className="h-4 bg-white/10 rounded w-1/3" />
                        <div className="h-4 bg-white/10 rounded w-2/3" />
                    </div>
                </div>
            </section>
        );
    }

    if (error) {
        return (
            <section className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-4">YouTube</h2>
                <div className="bg-surface-sunken rounded-lg p-5">
                    <p className="text-sm text-gray-400">{error}</p>
                </div>
            </section>
        );
    }

    if (!playlistInfo) {
        return null;
    }

    const heading =
        playlistInfo.kind === "channel"
            ? "YouTube Channel"
            : "YouTube Playlist";
    const trackWord = playlistInfo.count === 1 ? "track" : "tracks";
    const countLabel = playlistInfo.truncated
        ? `Showing first ${playlistInfo.count}${
              playlistInfo.totalCount ? ` of ${playlistInfo.totalCount}` : ""
          } ${trackWord}`
        : `${playlistInfo.count} ${trackWord}`;

    const previewEntries = playlistInfo.entries.slice(0, PREVIEW_ROWS);
    const remaining = playlistInfo.count - previewEntries.length;

    const handleDownloadClick = async (format: string, quality: string) => {
        setShowFormatMenu(false);
        // Resolves once the run finishes; progress arrives via `progress`.
        await onDownloadAll(format, quality);
    };

    return (
        <section className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-4">{heading}</h2>
            <div className="bg-surface-sunken hover:bg-surface-elevated transition-colors rounded-lg p-5">
                <div className="flex items-start gap-3">
                    <ListVideo className="w-6 h-6 text-green-500 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                        <h3 className="text-lg font-semibold text-white truncate">
                            {playlistInfo.title || heading}
                        </h3>
                        {playlistInfo.uploader && (
                            <p className="text-sm text-gray-400 mt-1 truncate">
                                {playlistInfo.uploader}
                            </p>
                        )}
                        <p className="text-sm text-gray-400 mt-1">
                            {countLabel}
                            {playlistInfo.truncated && (
                                <span className="text-gray-400">
                                    {" "}
                                    — paste with a smaller list to get them all
                                </span>
                            )}
                        </p>
                    </div>
                </div>

                {/* Entry preview */}
                {previewEntries.length > 0 && (
                    <ol className="mt-4 space-y-1.5 text-sm">
                        {previewEntries.map((entry, index) => (
                            <li
                                key={entry.videoId}
                                className="flex gap-3 text-gray-300"
                            >
                                <span className="text-gray-400 w-5 shrink-0 text-right">
                                    {index + 1}
                                </span>
                                <span className="truncate">{entry.title}</span>
                            </li>
                        ))}
                        {remaining > 0 && (
                            <li className="flex gap-3 text-gray-400">
                                <span className="w-5 shrink-0" />
                                <span>+{remaining} more</span>
                            </li>
                        )}
                    </ol>
                )}

                {/* Actions (bulk download is admin only) */}
                {canDownload && (
                <div className="flex items-center gap-3 mt-5">
                    <div className="relative">
                        <button
                            onClick={() => setShowFormatMenu(!showFormatMenu)}
                            disabled={isDownloading}
                            className="flex items-center gap-2 px-5 py-2.5 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-full transition-colors disabled:opacity-50"
                        >
                            {isDownloading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    {progress
                                        ? `Downloading… ${progress.completed}/${progress.total}`
                                        : "Downloading…"}
                                </>
                            ) : (
                                <>
                                    <Download className="w-4 h-4" />
                                    Download all ({playlistInfo.count})
                                    <ChevronDown className="w-3 h-3" />
                                </>
                            )}
                        </button>

                        {showFormatMenu && !isDownloading && (
                            <div className="absolute top-full left-0 mt-2 w-44 bg-surface-highlight rounded-lg shadow-xl border border-white/10 overflow-hidden z-50">
                                {FORMAT_OPTIONS.map((opt) => (
                                    <button
                                        key={opt.format}
                                        onClick={() =>
                                            handleDownloadClick(
                                                opt.format,
                                                opt.quality
                                            )
                                        }
                                        className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {isDownloading && (
                        <button
                            onClick={onCancel}
                            className="flex items-center gap-2 px-4 py-2.5 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors"
                        >
                            <X className="w-4 h-4" />
                            Cancel
                        </button>
                    )}
                </div>
                )}

                {/* Aggregate progress bar (admin only) */}
                {canDownload && isDownloading && progress && (
                    <div className="mt-3">
                        <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
                            <div
                                className="h-full bg-green-500 transition-all duration-500"
                                style={{ width: `${progress.pct}%` }}
                            />
                        </div>
                        {progress.failed > 0 && (
                            <p className="text-xs text-gray-400 mt-1.5">
                                {progress.failed} unfinished (continuing in the
                                background)
                            </p>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
