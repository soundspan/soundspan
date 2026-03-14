"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type LibraryHealthRecord } from "@/lib/api";
import { SettingsSection } from "../ui";
import {
    AlertTriangle,
    FileWarning,
    Loader2,
    RefreshCw,
    Trash2,
} from "lucide-react";

const STATUS_LABELS: Record<string, { label: string; icon: React.ElementType; color: string }> = {
    MISSING_FROM_DISK: { label: "Missing", icon: FileWarning, color: "text-amber-400" },
    UNREADABLE_METADATA: { label: "Unreadable", icon: AlertTriangle, color: "text-red-400" },
};

/**
 * Admin section showing library health records for corrupt or missing tracks.
 */
export function LibraryHealthSection() {
    const [records, setRecords] = useState<LibraryHealthRecord[]>([]);
    const [total, setTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadRecords = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await api.getLibraryHealth();
            setRecords(data.records);
            setTotal(data.total);
        } catch {
            setError("Failed to load library health records");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadRecords();
    }, [loadRecords]);

    const handleDismiss = async (recordId: string) => {
        try {
            await api.dismissLibraryHealthRecord(recordId);
            setRecords((prev) => prev.filter((r) => r.id !== recordId));
            setTotal((prev) => Math.max(0, prev - 1));
        } catch {
            // Silently fail
        }
    };

    return (
        <SettingsSection
            id="library-health"
            title="Library Health"
            description="Tracks flagged during library scans as missing from disk or having unreadable metadata."
        >
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-400">
                        {total} issue{total !== 1 ? "s" : ""} detected
                    </p>
                    <button
                        onClick={() => void loadRecords()}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                        Refresh
                    </button>
                </div>

                {error && (
                    <p className="text-sm text-red-400 py-2">{error}</p>
                )}

                {isLoading && records.length === 0 && (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 text-gray-500 animate-spin" />
                    </div>
                )}

                {!isLoading && records.length === 0 && !error && (
                    <div className="text-center py-6">
                        <p className="text-sm text-gray-500">
                            No health issues detected
                        </p>
                    </div>
                )}

                {records.length > 0 && (
                    <div className="rounded-lg border border-white/5 overflow-hidden divide-y divide-white/5">
                        {records.map((record) => {
                            const statusConfig = STATUS_LABELS[record.status] ?? STATUS_LABELS.MISSING_FROM_DISK;
                            const Icon = statusConfig.icon;

                            return (
                                <div
                                    key={record.id}
                                    className="px-4 py-3 hover:bg-white/[0.03] transition-colors"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <Icon className={`w-4 h-4 shrink-0 ${statusConfig.color}`} />
                                                <p className="text-sm text-white truncate">
                                                    {record.track?.title || "Unknown Track"}
                                                </p>
                                            </div>
                                            {record.track?.album && (
                                                <p className="text-xs text-gray-500 mt-0.5 ml-6 truncate">
                                                    {record.track.album.artist?.name} &middot;{" "}
                                                    {record.track.album.title}
                                                </p>
                                            )}
                                            <p className="text-[11px] text-gray-600 mt-1 ml-6 truncate font-mono">
                                                {record.filePath}
                                            </p>
                                            {record.detail && (
                                                <p className="text-[11px] text-gray-600 mt-0.5 ml-6">
                                                    {record.detail}
                                                </p>
                                            )}
                                        </div>
                                        <button
                                            onClick={() => void handleDismiss(record.id)}
                                            className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-white/5 rounded transition-colors shrink-0"
                                            title="Dismiss"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </SettingsSection>
    );
}
