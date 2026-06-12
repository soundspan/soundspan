"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ImportJob } from "@/lib/api";
import { Loader2, CheckCircle2, XCircle, Ban, Clock, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; label: string }> = {
    pending: { icon: Clock, color: "text-gray-400", label: "Pending" },
    resolving: { icon: Loader2, color: "text-blue-400", label: "Resolving" },
    creating_playlist: { icon: Loader2, color: "text-blue-400", label: "Creating" },
    cancelling: { icon: Loader2, color: "text-amber-400", label: "Cancelling" },
    completed: { icon: CheckCircle2, color: "text-emerald-400", label: "Completed" },
    failed: { icon: XCircle, color: "text-red-400", label: "Failed" },
    cancelled: { icon: Ban, color: "text-gray-500", label: "Cancelled" },
};

function JobStatusBadge({ status }: { status: string }) {
    const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
    const Icon = config.icon;
    const isAnimated =
        status === "resolving" ||
        status === "creating_playlist" ||
        status === "cancelling";

    return (
        <span className={`flex items-center gap-1.5 text-xs font-medium ${config.color}`}>
            <Icon className={`w-3.5 h-3.5 ${isAnimated ? "animate-spin" : ""}`} />
            {config.label}
        </span>
    );
}

/**
 * Activity panel tab showing generic import job history and progress.
 */
export function ImportsTab() {
    const router = useRouter();
    const [jobs, setJobs] = useState<ImportJob[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const loadJobs = useCallback(async () => {
        try {
            const data = await api.listImportJobs();
            setJobs(data.jobs);
        } catch {
            // Silently fail — tab is informational
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadJobs();
    }, [loadJobs]);

    // Poll for active jobs
    useEffect(() => {
        const hasActive = jobs.some(
            (j) =>
                j.status === "pending" ||
                j.status === "resolving" ||
                j.status === "creating_playlist" ||
                j.status === "cancelling"
        );
        if (!hasActive) return;

        const interval = setInterval(loadJobs, 3000);
        return () => clearInterval(interval);
    }, [jobs, loadJobs]);

    const handleCancel = async (jobId: string) => {
        try {
            await api.cancelImportJob(jobId);
            await loadJobs();
        } catch {
            // Silently fail
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 text-gray-500 animate-spin" />
            </div>
        );
    }

    if (jobs.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <p className="text-gray-400 text-sm">No import jobs yet</p>
                <p className="text-gray-600 text-xs mt-1">
                    Submit imports from the Import page
                </p>
            </div>
        );
    }

    return (
        <div className="overflow-y-auto h-full">
            {jobs.map((job) => {
                const isActive =
                    job.status === "pending" ||
                    job.status === "resolving" ||
                    job.status === "creating_playlist" ||
                    job.status === "cancelling";

                return (
                    <div
                        key={job.id}
                        className="px-4 py-3 border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white truncate">
                                    {job.requestedPlaylistName || job.playlistName}
                                </p>
                                <p className="text-xs text-gray-500 truncate mt-0.5">
                                    {job.sourceType} &middot;{" "}
                                    {new Date(job.createdAt).toLocaleDateString()}
                                </p>
                            </div>
                            <JobStatusBadge status={job.status} />
                        </div>

                        {isActive && job.progress > 0 && (
                            <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                                    style={{ width: `${Math.min(100, job.progress)}%` }}
                                />
                            </div>
                        )}

                        {job.summary && job.summary.total > 0 && (
                            <p className="text-[11px] text-gray-600 mt-1">
                                {job.summary.local} local &middot;{" "}
                                {job.summary.unresolved} unresolved &middot;{" "}
                                {job.summary.total} total
                            </p>
                        )}

                        <div className="flex items-center gap-2 mt-2">
                            {isActive && (
                                <button
                                    onClick={() => void handleCancel(job.id)}
                                    className="text-xs text-red-400/70 hover:text-red-400 transition-colors"
                                >
                                    Cancel
                                </button>
                            )}
                            {job.status === "completed" && job.createdPlaylistId && (
                                <button
                                    onClick={() =>
                                        router.push(`/playlist/${job.createdPlaylistId}`)
                                    }
                                    className="flex items-center gap-1 text-xs text-blue-400/70 hover:text-blue-400 transition-colors"
                                >
                                    View Playlist
                                    <ArrowRight className="w-3 h-3" />
                                </button>
                            )}
                            {job.status === "failed" && job.error && (
                                <p className="text-xs text-red-400/60 truncate">
                                    {job.error}
                                </p>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
