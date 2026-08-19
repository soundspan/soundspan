"use client";

import { useCallback, useState } from "react";
import { api, type LibraryHealthSummary } from "@/lib/api";
import { enrichmentApi } from "@/lib/enrichmentApi";
import { formatCoveragePercent } from "../format";
import { usePanelLoader } from "../hooks/usePanelLoader";
import { InsightPanel } from "./InsightPanel";

interface AnalysisCoveragePanelProps {
    coverage: LibraryHealthSummary["analysisCoverage"];
}

/** Analysis, vibe, and loudness coverage with retry actions for failures. */
export function AnalysisCoveragePanel({
    coverage,
}: Readonly<AnalysisCoveragePanelProps>) {
    const fetchPage = useCallback(
        () => api.getLibraryHealthAnalysis({ limit: 50 }),
        [],
    );
    const page = usePanelLoader(fetchPage, "Failed to load analysis coverage");
    const [actionNotice, setActionNotice] = useState<string | null>(null);
    const [isActing, setIsActing] = useState(false);

    const runAction = (action: () => Promise<unknown>, done: string) => {
        setIsActing(true);
        setActionNotice(null);
        void action()
            .then(() => {
                setActionNotice(done);
                page.load();
            })
            .catch(() => {
                setActionNotice("Action failed — check the server logs.");
            })
            .finally(() => {
                setIsActing(false);
            });
    };

    const analysisDone = coverage.analysisStatus.completed;
    const vibeDone = coverage.vibeAnalysisStatus.completed;
    const loudnessTotal =
        coverage.loudness.measured + coverage.loudness.missing;

    return (
        <InsightPanel
            title="Analysis coverage"
            subtitle={`Audio ${formatCoveragePercent(analysisDone, coverage.total)} · Vibe ${formatCoveragePercent(vibeDone, coverage.total)} · Loudness ${formatCoveragePercent(coverage.loudness.measured, loudnessTotal)} · ${coverage.analysisStatus.failed} failed`}
            onFirstExpand={page.load}
            isLoading={page.isLoading}
            error={page.error}
        >
            <div className="flex flex-wrap gap-2 mb-3">
                <button
                    type="button"
                    disabled={isActing}
                    onClick={() =>
                        runAction(
                            () => api.retryFailedAnalysis(),
                            "Failed audio analysis re-queued.",
                        )
                    }
                    className="px-2 py-1 text-xs rounded-full border border-white/10 text-gray-300 disabled:opacity-50"
                >
                    Retry failed audio analysis
                </button>
                <button
                    type="button"
                    disabled={isActing}
                    onClick={() =>
                        runAction(
                            () => enrichmentApi.retryVibeEmbeddings(),
                            "Failed vibe embeddings re-queued.",
                        )
                    }
                    className="px-2 py-1 text-xs rounded-full border border-white/10 text-gray-300 disabled:opacity-50"
                >
                    Retry failed vibe embeddings
                </button>
            </div>
            {actionNotice && (
                <p className="text-xs text-gray-400 mb-2">{actionNotice}</p>
            )}
            {page.data && page.data.failed.items.length > 0 && (
                <ul className="space-y-1">
                    {page.data.failed.items.map((track) => (
                        <li key={track.id} className="text-sm text-gray-300">
                            <span className="truncate">{track.title}</span>
                            <span className="text-gray-500">
                                {" "}
                                — {track.album.artist.name}
                                {track.analysisError
                                    ? ` · ${track.analysisError}`
                                    : ""}
                            </span>
                        </li>
                    ))}
                    {page.data.failed.total > page.data.failed.items.length && (
                        <li className="text-xs text-gray-500 pt-1">
                            Showing {page.data.failed.items.length} of{" "}
                            {page.data.failed.total} failed tracks.
                        </li>
                    )}
                </ul>
            )}
            {page.data && page.data.failed.items.length === 0 && (
                <p className="text-xs text-gray-500">
                    No failed tracks. Pending tracks are processed by the
                    analysis workers automatically.
                </p>
            )}
        </InsightPanel>
    );
}
