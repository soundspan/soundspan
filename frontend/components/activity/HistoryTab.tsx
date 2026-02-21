"use client";

import { useState, useEffect } from "react";
import { CheckCircle, XCircle, Trash2, RotateCcw, History, Disc, Music } from "lucide-react";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { createFrontendLogger } from "@/lib/logger";
import { cn } from "@/utils/cn";

const logger = createFrontendLogger("Activity.HistoryTab");

interface DownloadHistory {
    id: string;
    subject: string;
    type: string;
    status: string;
    error?: string;
    createdAt: string;
    completedAt?: string;
}

export function HistoryTab() {
    const [history, setHistory] = useState<DownloadHistory[]>([]);
    const [loading, setLoading] = useState(true);
    const [retrying, setRetrying] = useState<Set<string>>(new Set());
    const { downloadsEnabled } = useDownloadContext();

    const fetchHistory = async () => {
        try {
            const data = await api.getDownloadHistory();
            setHistory(data);
        } catch (error) {
            logger.error("Failed to fetch download history", { error });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchHistory();
        
        // Refresh on window focus
        const handleFocus = () => fetchHistory();
        window.addEventListener("focus", handleFocus);
        return () => window.removeEventListener("focus", handleFocus);
    }, []);

    const handleClear = async (id: string) => {
        try {
            await api.clearDownloadFromHistory(id);
            setHistory((prev) => prev.filter((h) => h.id !== id));
            // Notify other components that download status has changed
            window.dispatchEvent(new CustomEvent("download-status-changed"));
        } catch (error) {
            logger.error("Failed to clear download history item", { id, error });
        }
    };

    const handleClearAll = async () => {
        try {
            await api.clearAllDownloadHistory();
            setHistory([]);
            // Notify other components that download status has changed
            window.dispatchEvent(new CustomEvent("download-status-changed"));
        } catch (error) {
            logger.error("Failed to clear all download history", { error });
        }
    };

    const handleRetry = async (id: string) => {
        try {
            setRetrying((prev) => new Set(prev).add(id));
            const result = await api.retryFailedDownload(id);
            if (result.success) {
                // Remove from history (it's now in active)
                setHistory((prev) => prev.filter((h) => h.id !== id));
            }
        } catch (error) {
            logger.error("Failed to retry download", { id, error });
        } finally {
            setRetrying((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const completed = history.filter((h) => h.status === "completed");
    const failed = history.filter((h) => h.status === "failed" || h.status === "exhausted");

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (history.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <History className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No download history</p>
                <p className="text-xs text-white/30 mt-1">Completed downloads will appear here</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header with clear all */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <div className="flex items-center gap-3 text-xs text-white/40">
                    {completed.length > 0 && (
                        <span className="flex items-center gap-1">
                            <CheckCircle className="w-3 h-3 text-green-400" />
                            {completed.length}
                        </span>
                    )}
                    {failed.length > 0 && (
                        <span className="flex items-center gap-1">
                            <XCircle className="w-3 h-3 text-red-400" />
                            {failed.length}
                        </span>
                    )}
                </div>
                <button
                    onClick={handleClearAll}
                    className="text-xs text-white/40 hover:text-white transition-colors"
                >
                    Clear all
                </button>
            </div>

            {/* History list */}
            <div className="flex-1 overflow-y-auto">
                {/* Failed section first */}
                {failed.length > 0 && (
                    <div>
                        <div className="px-3 py-1.5 bg-red-500/10 border-b border-red-500/20">
                            <span className="text-xs font-medium text-red-400">Failed ({failed.length})</span>
                        </div>
                        {failed.map((item) => (
                            <HistoryItem
                                key={item.id}
                                item={item}
                                onClear={handleClear}
                                onRetry={downloadsEnabled ? handleRetry : undefined}
                                isRetrying={retrying.has(item.id)}
                            />
                        ))}
                    </div>
                )}

                {/* Completed section */}
                {completed.length > 0 && (
                    <div>
                        <div className="px-3 py-1.5 bg-green-500/10 border-b border-green-500/20">
                            <span className="text-xs font-medium text-green-400">Completed ({completed.length})</span>
                        </div>
                        {completed.map((item) => (
                            <HistoryItem
                                key={item.id}
                                item={item}
                                onClear={handleClear}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function HistoryItem({
    item,
    onClear,
    onRetry,
    isRetrying,
}: {
    item: DownloadHistory;
    onClear: (id: string) => void;
    onRetry?: (id: string) => void;
    isRetrying?: boolean;
}) {
    const isCompleted = item.status === "completed";
    const isFailed = item.status === "failed" || item.status === "exhausted";

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        
        if (diff < 60000) return "Just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return date.toLocaleDateString();
    };

    return (
        <div className="px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors group">
            <div className="flex items-start gap-3">
                <div className="mt-0.5 flex-shrink-0">
                    {isCompleted ? (
                        <CheckCircle className="w-4 h-4 text-green-400" />
                    ) : (
                        <XCircle className="w-4 h-4 text-red-400" />
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                        {item.subject}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-white/30 capitalize flex items-center gap-1">
                            {item.type === "album" ? (
                                <Disc className="w-3 h-3" />
                            ) : (
                                <Music className="w-3 h-3" />
                            )}
                            {item.type}
                        </span>
                        <span className="text-xs text-white/30">•</span>
                        <span className="text-xs text-white/30">
                            {formatTime(item.completedAt || item.createdAt)}
                        </span>
                    </div>
                    {item.error && (
                        <p className="text-xs text-red-400/70 mt-1 line-clamp-2">
                            {item.error}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {isFailed && onRetry && (
                        <button
                            onClick={() => onRetry(item.id)}
                            disabled={isRetrying}
                            className={cn(
                                "p-1 hover:bg-white/10 rounded transition-colors",
                                isRetrying && "opacity-50 cursor-not-allowed"
                            )}
                            title="Retry download"
                        >
                            <RotateCcw className={cn(
                                "w-3.5 h-3.5 text-white/40 hover:text-[#3b82f6]",
                                isRetrying && "animate-spin"
                            )} />
                        </button>
                    )}
                    <button
                        onClick={() => onClear(item.id)}
                        className="p-1 hover:bg-white/10 rounded transition-colors"
                        title="Remove from history"
                    >
                        <Trash2 className="w-3.5 h-3.5 text-white/40 hover:text-red-400" />
                    </button>
                </div>
            </div>
        </div>
    );
}
