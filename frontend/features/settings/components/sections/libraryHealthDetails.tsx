"use client";

import { useState, type ElementType } from "react";
import type { LibraryHealthRecord } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
    AlertTriangle,
    ChevronDown,
    ChevronRight,
    FileWarning,
    Loader2,
    RefreshCw,
    Trash2,
} from "lucide-react";

interface StatusConfig {
    label: string;
    icon: ElementType;
    color: string;
}

const STATUS_LABELS: Record<LibraryHealthRecord["status"], StatusConfig> = {
    MISSING_FROM_DISK: {
        label: "Missing",
        icon: FileWarning,
        color: "text-amber-400",
    },
    UNREADABLE_METADATA: {
        label: "Unreadable",
        icon: AlertTriangle,
        color: "text-red-400",
    },
};

const REMOVED_STATUS: StatusConfig = {
    label: "Removed, pending purge",
    icon: FileWarning,
    color: "text-gray-400",
};

interface LibraryHealthDetailsProps {
    records: LibraryHealthRecord[];
    total: number;
    removedPendingPurgeCount: number;
    trackRemovalRetentionDays: number;
    isLoading: boolean;
    isPurging: boolean;
    error: string | null;
    purgeNotice: string | null;
    /** Initial expansion state of the record list; collapsed by default. */
    defaultExpanded?: boolean;
    onRefresh: () => void;
    onDismiss: (recordId: string) => void;
    onPurgeAll: () => void;
}

function statusForRecord(record: LibraryHealthRecord): StatusConfig {
    if (record.status === "MISSING_FROM_DISK" && record.track?.removedAt) {
        return REMOVED_STATUS;
    }
    return STATUS_LABELS[record.status];
}

function RemovedTrackSummary({
    count,
    retentionDays,
    isPurging,
    onPurgeAll,
}: Readonly<{
    count: number;
    retentionDays: number;
    isPurging: boolean;
    onPurgeAll: () => void;
}>) {
    if (count === 0) return null;
    return (
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-300">
                        {count} removed, pending purge
                    </p>
                    <p className="mt-1 text-[11px] text-gray-400">
                        A rescan restores these tracks if their files return.
                        SoundSpan permanently purges them after {retentionDays}{" "}
                        day
                        {retentionDays === 1 ? "" : "s"}, as configured by{" "}
                        <code>TRACK_REMOVAL_RETENTION_DAYS</code>.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onPurgeAll}
                    disabled={isPurging}
                    className="flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 text-xs font-medium text-red-400 border border-red-400/40 rounded-md hover:bg-red-400/10 transition-colors disabled:opacity-50"
                >
                    {isPurging ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                    )}
                    Delete all now
                </button>
            </div>
        </div>
    );
}

function LibraryHealthRecordRow({
    record,
    onDismiss,
}: Readonly<{
    record: LibraryHealthRecord;
    onDismiss: (recordId: string) => void;
}>) {
    const statusConfig = statusForRecord(record);
    const Icon = statusConfig.icon;
    return (
        <div className="px-4 py-3 hover:bg-white/[0.03] transition-colors">
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <Icon
                            className={`w-4 h-4 shrink-0 ${statusConfig.color}`}
                        />
                        <p className="text-sm text-white truncate">
                            {record.track?.title || "Unknown Track"}
                        </p>
                        <span
                            className={`shrink-0 text-[10px] font-medium ${statusConfig.color}`}
                        >
                            {statusConfig.label}
                        </span>
                    </div>
                    {record.track?.album && (
                        <p className="text-xs text-gray-400 mt-0.5 ml-6 truncate">
                            {record.track.album.artist?.name} &middot;{" "}
                            {record.track.album.title}
                        </p>
                    )}
                    <p className="text-[11px] text-gray-400 mt-1 ml-6 truncate font-mono">
                        {record.filePath}
                    </p>
                    {record.detail && (
                        <p className="text-[11px] text-gray-400 mt-0.5 ml-6">
                            {record.detail}
                        </p>
                    )}
                </div>
                <button
                    onClick={() => onDismiss(record.id)}
                    className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-white/5 rounded transition-colors shrink-0"
                    title="Dismiss"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}

const RECORD_LIST_ID = "library-health-record-list";

/** Renders the full record list; mounted only while expanded. */
function LibraryHealthRecordList({
    records,
    onDismiss,
}: Readonly<{
    records: LibraryHealthRecord[];
    onDismiss: (recordId: string) => void;
}>) {
    return (
        <div
            id={RECORD_LIST_ID}
            className="rounded-lg border border-white/5 overflow-hidden divide-y divide-white/5"
        >
            {records.map((record) => (
                <LibraryHealthRecordRow
                    key={record.id}
                    record={record}
                    onDismiss={onDismiss}
                />
            ))}
        </div>
    );
}

function RecordListToggle({
    isExpanded,
    count,
    onToggle,
}: Readonly<{ isExpanded: boolean; count: number; onToggle: () => void }>) {
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-controls={RECORD_LIST_ID}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
        >
            <Chevron className="w-3.5 h-3.5" />
            {isExpanded
                ? "Hide records"
                : `Show ${count} record${count === 1 ? "" : "s"}`}
        </button>
    );
}

function purgeConfirmMessage(count: number, retentionDays: number): string {
    const tracks = `${count} removed track${count === 1 ? "" : "s"}`;
    return (
        `Permanently delete ${tracks} right now instead of after the ` +
        `${retentionDays}-day retention window. Play history and playlist ` +
        `entries for these tracks are deleted with them. This cannot be undone.`
    );
}

/** Renders the response-driven Library Health details and record states. */
export function LibraryHealthDetails({
    records,
    total,
    removedPendingPurgeCount,
    trackRemovalRetentionDays,
    isLoading,
    isPurging,
    error,
    purgeNotice,
    defaultExpanded = false,
    onRefresh,
    onDismiss,
    onPurgeAll,
}: LibraryHealthDetailsProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <p className="text-sm text-gray-400">
                    {total} issue{total !== 1 ? "s" : ""} detected
                </p>
                <button
                    onClick={onRefresh}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                >
                    <RefreshCw
                        className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`}
                    />
                    Refresh
                </button>
            </div>
            <RemovedTrackSummary
                count={removedPendingPurgeCount}
                retentionDays={trackRemovalRetentionDays}
                isPurging={isPurging}
                onPurgeAll={() => setShowPurgeConfirm(true)}
            />
            {error && <p className="text-sm text-red-400 py-2">{error}</p>}
            {purgeNotice && (
                <p className="text-sm text-gray-300 py-2">{purgeNotice}</p>
            )}
            {isLoading && records.length === 0 && (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
                </div>
            )}
            {!isLoading && records.length === 0 && !error && (
                <div className="text-center py-6">
                    <p className="text-sm text-gray-400">
                        No health issues detected
                    </p>
                </div>
            )}
            {records.length > 0 && (
                <>
                    <RecordListToggle
                        isExpanded={isExpanded}
                        count={records.length}
                        onToggle={() => setIsExpanded((previous) => !previous)}
                    />
                    {isExpanded && (
                        <LibraryHealthRecordList
                            records={records}
                            onDismiss={onDismiss}
                        />
                    )}
                </>
            )}
            <ConfirmDialog
                isOpen={showPurgeConfirm}
                onClose={() => setShowPurgeConfirm(false)}
                onConfirm={onPurgeAll}
                title="Delete all removed tracks"
                message={purgeConfirmMessage(
                    removedPendingPurgeCount,
                    trackRemovalRetentionDays,
                )}
                confirmText="Delete all now"
                variant="danger"
            />
        </div>
    );
}
