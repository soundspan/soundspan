"use client";

import { useState } from "react";
import Image from "next/image";
import { Play, Download, Loader2, ChevronDown } from "lucide-react";
import type { YtVideoInfo } from "../hooks/useYouTubeUrl";
import { formatTime } from "@/utils/formatTime";

interface YouTubePreviewCardProps {
    videoInfo: YtVideoInfo;
    isLoading: boolean;
    isDownloading: boolean;
    /** Download progress percentage (0-100), or null when unknown/idle. */
    downloadProgress: number | null;
    /**
     * Whether the current user may download (admin-only, matching the
     * backend gate). Playback stays available regardless.
     */
    canDownload: boolean;
    onPlay: () => void;
    onDownload: (format: string, quality: string) => Promise<void>;
}

const FORMAT_OPTIONS = [
    { label: "MP3 320kbps", format: "mp3", quality: "HIGH" },
    { label: "Opus", format: "opus", quality: "HIGH" },
    { label: "FLAC", format: "flac", quality: "LOSSLESS" },
] as const;

export function YouTubePreviewCard({
    videoInfo,
    isLoading,
    isDownloading,
    downloadProgress,
    canDownload,
    onPlay,
    onDownload,
}: YouTubePreviewCardProps) {
    const [showFormatMenu, setShowFormatMenu] = useState(false);

    if (isLoading) {
        return (
            <section className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-4">YouTube</h2>
                <div className="bg-surface-sunken rounded-lg p-6 animate-pulse">
                    <div className="flex gap-5">
                        <div className="w-64 h-36 rounded bg-white/10 shrink-0" />
                        <div className="flex-1 space-y-3 py-1">
                            <div className="h-5 bg-white/10 rounded w-3/4" />
                            <div className="h-4 bg-white/10 rounded w-1/2" />
                            <div className="h-4 bg-white/10 rounded w-1/4" />
                        </div>
                    </div>
                </div>
            </section>
        );
    }

    const handleDownloadClick = async (format: string, quality: string) => {
        setShowFormatMenu(false);
        // Resolves once the job is started; progress/completion arrive via
        // the polling state (isDownloading/downloadProgress) and toasts.
        await onDownload(format, quality);
    };

    return (
        <section className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-4">YouTube</h2>
            <div className="bg-surface-sunken hover:bg-surface-elevated transition-colors rounded-lg p-5">
                <div className="flex flex-col sm:flex-row gap-5">
                    {/* Thumbnail */}
                    {videoInfo.thumbnail && (
                        <div className="relative w-full sm:w-72 aspect-video rounded-md overflow-hidden shrink-0">
                            <Image
                                src={videoInfo.thumbnail}
                                alt={videoInfo.title}
                                fill
                                className="object-cover"
                                unoptimized
                            />
                        </div>
                    )}

                    {/* Info + Actions */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <div>
                            <h3 className="text-lg font-semibold text-white truncate">
                                {videoInfo.title}
                            </h3>
                            <p className="text-sm text-gray-400 mt-1">
                                {videoInfo.uploader}
                            </p>
                            <p className="text-sm text-gray-400 mt-1">
                                {formatTime(videoInfo.duration)}
                            </p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-3 mt-4">
                            {/* Play button */}
                            <button
                                onClick={onPlay}
                                className="flex items-center gap-2 px-5 py-2.5 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-full transition-colors"
                            >
                                <Play className="w-4 h-4 fill-current" />
                                Play
                            </button>

                            {/* Download button with dropdown (admin only) */}
                            {canDownload && (
                            <div className="relative">
                                <button
                                    onClick={() =>
                                        setShowFormatMenu(!showFormatMenu)
                                    }
                                    disabled={isDownloading}
                                    className="flex items-center gap-2 px-4 py-2.5 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors disabled:opacity-50"
                                >
                                    {isDownloading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            {downloadProgress !== null
                                                ? `Downloading… ${Math.round(downloadProgress)}%`
                                                : "Downloading…"}
                                        </>
                                    ) : (
                                        <>
                                            <Download className="w-4 h-4" />
                                            Download
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
                            )}
                        </div>

                        {/* Download progress bar (admin only) */}
                        {canDownload && isDownloading && downloadProgress !== null && (
                            <div className="mt-3 h-1 w-full rounded-full bg-white/10 overflow-hidden">
                                <div
                                    className="h-full bg-green-500 transition-all duration-500"
                                    style={{
                                        width: `${Math.min(100, Math.max(0, downloadProgress))}%`,
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
}
