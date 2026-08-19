"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { SettingsSection } from "@/features/settings/components/ui";
import { useLibraryInsights } from "../hooks/useLibraryInsights";
import { AnalysisCoveragePanel } from "./AnalysisCoveragePanel";
import { DuplicatesPanel } from "./DuplicatesPanel";
import { MetadataGapsPanel } from "./MetadataGapsPanel";
import { QualityPanel } from "./QualityPanel";
import { StoragePanel } from "./StoragePanel";

/**
 * Library Health dashboard (issue #532): metadata gaps, analysis coverage,
 * duplicate clusters, and storage/quality analytics from the read-model API.
 */
export function LibraryInsightsSection() {
    const { summary, isLoading, isRefreshing, error, refresh, refreshToken } =
        useLibraryInsights();

    return (
        <SettingsSection
            id="library-insights"
            title="Library Insights"
            description="What the enrichment pipeline knows about your library: metadata gaps, analysis coverage, duplicates, and storage. Counts are cached for 15 minutes."
            titleExtra={
                <button
                    type="button"
                    onClick={refresh}
                    disabled={isRefreshing || isLoading}
                    className="p-1 text-gray-400 hover:text-white disabled:opacity-50"
                    title="Recompute now"
                    aria-label="Recompute library insights"
                >
                    <RefreshCw
                        className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
                    />
                </button>
            }
        >
            {isLoading && (
                <div className="flex items-center gap-2 py-2 text-sm text-gray-300">
                    <Loader2 className="w-4 h-4 animate-spin text-brand" />
                    Loading library insights…
                </div>
            )}
            {error && <p className="py-2 text-sm text-red-400">{error}</p>}
            {summary && (
                <div className="space-y-3">
                    <MetadataGapsPanel
                        gaps={summary.metadataGaps}
                        refreshToken={refreshToken}
                    />
                    <AnalysisCoveragePanel
                        coverage={summary.analysisCoverage}
                        refreshToken={refreshToken}
                        onRemediated={refresh}
                    />
                    <DuplicatesPanel
                        duplicates={summary.duplicates}
                        refreshToken={refreshToken}
                    />
                    <StoragePanel
                        storage={summary.storage}
                        refreshToken={refreshToken}
                    />
                    <QualityPanel
                        quality={summary.quality}
                        refreshToken={refreshToken}
                    />
                </div>
            )}
        </SettingsSection>
    );
}
