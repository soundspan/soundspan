"use client";

import { useState } from "react";
import { Download, Loader2, Music, Disc, X } from "lucide-react";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { cn } from "@/utils/cn";
import { formatRelativeTime } from "@/utils/formatTime";
import { GradientSpinner } from "../ui/GradientSpinner";
import {
    useActiveDownloads,
    type DownloadHistoryItem,
} from "@/hooks/useNotifications";

const logger = createFrontendLogger("Activity.ActiveDownloadsTab");

interface ActiveDownloadsTabProps {
    downloads?: DownloadHistoryItem[];
    loading?: boolean;
    refetch?: () => Promise<unknown>;
    queryEnabled?: boolean;
}

/**
 * Renders the ActiveDownloadsTab component.
 */
export function ActiveDownloadsTab({
    downloads: downloadsProp,
    loading: loadingProp,
    refetch: refetchProp,
    queryEnabled = true,
}: ActiveDownloadsTabProps = {}) {
    const downloadsQuery = useActiveDownloads({ enabled: queryEnabled });
    const downloads = downloadsProp ?? downloadsQuery.downloads;
    const loading = loadingProp ?? downloadsQuery.isLoading;
    const refetch = refetchProp ?? downloadsQuery.refetch;
    const [cancelling, setCancelling] = useState<Set<string>>(new Set());

    // YouTube bulk-download jobs live in the sidecar and cancel through a
    // different endpoint than the library download manager. Library jobs with
    // the YouTube source are regular DownloadJob rows, so the routing keys on
    // the sidecar-row marker rather than currentSource.
    const cancelById = async (id: string) => {
        const download = downloads.find((d) => d.id === id);
        if (download?.metadata?.ytSidecarJob === true) {
            await api.cancelYouTubeDownload(id);
        } else {
            await api.deleteDownload(id);
        }
    };

    const handleCancel = async (id: string) => {
        setCancelling((prev) => new Set(prev).add(id));
        try {
            await cancelById(id);
            // Refetch to get updated list
            refetch();
        } catch (error) {
            logger.error("Failed to cancel download", { id, error });
        } finally {
            setCancelling((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const handleCancelAll = async () => {
        const ids = downloads.map((d) => d.id);
        setCancelling(new Set(ids));
        try {
            // Cancel all downloads in parallel
            await Promise.all(ids.map((id) => cancelById(id)));
            refetch();
        } catch (error) {
            logger.error("Failed to cancel all downloads", {
                ids,
                error,
            });
            refetch();
        } finally {
            setCancelling(new Set());
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (downloads.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <Download className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No active downloads</p>
                <p className="text-xs text-white/30 mt-1">
                    Downloads will appear here
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs text-white/40">
                    {downloads.length} downloading
                </span>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleCancelAll}
                        className="text-xs text-white/40 hover:text-red-400 transition-colors"
                        title="Cancel all downloads"
                    >
                        Cancel all
                    </button>
                    <span className="flex items-center gap-1.5 text-xs text-green-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        Active
                    </span>
                </div>
            </div>

            {/* Download list */}
            <div className="flex-1 overflow-y-auto">
                {downloads.map((download) => (
                    <div
                        key={download.id}
                        className="px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors group"
                    >
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 shrink-0">
                                {cancelling.has(download.id) ? (
                                    <Loader2 className="w-4 h-4 text-white/40 animate-spin" />
                                ) : (
                                    <GradientSpinner size="sm" />
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white truncate">
                                    {download.subject}
                                </p>
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                    <span
                                        className={cn(
                                            "text-xs font-medium capitalize",
                                            download.status === "processing"
                                                ? "text-blue-400"
                                                : "text-yellow-400",
                                        )}
                                    >
                                        {download.status}
                                    </span>
                                    {Boolean(download.metadata?.statusText) && (
                                        <>
                                            <span className="text-xs text-white/30">
                                                •
                                            </span>
                                            <span
                                                className={cn(
                                                    "text-xs font-medium",
                                                    download.metadata
                                                        ?.currentSource ===
                                                        "lidarr"
                                                        ? "text-ai-hover"
                                                        : download.metadata
                                                                ?.currentSource ===
                                                            "tidal"
                                                          ? "text-cyan-400"
                                                          : download.metadata
                                                                  ?.currentSource ===
                                                              "youtube"
                                                            ? "text-red-400"
                                                            : "text-teal-400",
                                                )}
                                            >
                                                {String(
                                                    download.metadata
                                                        ?.statusText,
                                                )}
                                            </span>
                                        </>
                                    )}
                                    <span className="text-xs text-white/30">
                                        •
                                    </span>
                                    <span className="text-xs text-white/30 capitalize flex items-center gap-1">
                                        {download.type === "album" ? (
                                            <Disc className="w-3 h-3" />
                                        ) : (
                                            <Music className="w-3 h-3" />
                                        )}
                                        {download.type}
                                    </span>
                                    <span className="text-xs text-white/30">
                                        •
                                    </span>
                                    <span className="text-xs text-white/30">
                                        {formatRelativeTime(
                                            download.createdAt,
                                            {
                                                justNowLabel: "Just started",
                                                suffix: "",
                                            },
                                        )}
                                    </span>
                                </div>
                            </div>
                            <button
                                onClick={() => handleCancel(download.id)}
                                disabled={cancelling.has(download.id)}
                                className="p-1 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded transition-all shrink-0"
                                title="Cancel download"
                            >
                                <X className="w-4 h-4 text-white/40 hover:text-red-400" />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
