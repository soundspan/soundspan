"use client";

import { useCallback, useState } from "react";
import {
    api,
    type LibraryHealthGapKind,
    type LibraryHealthSummary,
} from "@/lib/api";
import { gapItemLine } from "../format";
import { useInsightPanelLoader } from "../hooks/useInsightPanelLoader";
import { InsightPanel } from "./InsightPanel";

const GAP_TABS: Array<{ kind: LibraryHealthGapKind; label: string }> = [
    { kind: "missing-art", label: "Cover art" },
    { kind: "missing-mbid", label: "MusicBrainz IDs" },
    { kind: "missing-genres", label: "Genres" },
    { kind: "missing-lyrics", label: "Lyrics" },
];

interface MetadataGapsPanelProps {
    gaps: LibraryHealthSummary["metadataGaps"];
    refreshToken: number;
}

/** Metadata-gap counts with a tabbed drill-down into each category. */
export function MetadataGapsPanel({
    gaps,
    refreshToken,
}: Readonly<MetadataGapsPanelProps>) {
    const [activeKind, setActiveKind] =
        useState<LibraryHealthGapKind>("missing-art");
    const fetchPage = useCallback(
        () => api.getLibraryHealthGaps(activeKind, { limit: 50 }),
        [activeKind],
    );
    const page = useInsightPanelLoader(
        fetchPage,
        "Failed to load metadata gaps",
        refreshToken,
    );

    const totalGaps =
        gaps.missingArt.albums +
        gaps.missingMbid.albums +
        gaps.missingGenres +
        gaps.missingLyrics;

    return (
        <InsightPanel
            title="Metadata gaps"
            subtitle={`${gaps.missingArt.albums} albums without art · ${gaps.missingMbid.albums} albums without MBIDs · ${gaps.missingGenres} tracks without genres · ${gaps.missingLyrics} tracks without lyrics`}
            onFirstExpand={page.onFirstExpand}
            onRetry={page.load}
            isLoading={page.isLoading}
            error={page.error}
        >
            <div className="flex flex-wrap gap-2 mb-3">
                {GAP_TABS.map((tab) => (
                    <button
                        key={tab.kind}
                        type="button"
                        onClick={() => setActiveKind(tab.kind)}
                        className={`px-2 py-1 text-xs rounded-full border ${
                            tab.kind === activeKind
                                ? "border-brand text-white bg-white/10"
                                : "border-white/10 text-gray-400"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            {page.data && page.data.kind === activeKind ? (
                <ul className="space-y-1">
                    {page.data.items.map((item) => {
                        const line = gapItemLine(item);
                        return (
                            <li
                                key={item.id}
                                className="text-sm text-gray-300 flex justify-between gap-3"
                            >
                                <span className="truncate">{line.primary}</span>
                                <span className="text-gray-500 truncate">
                                    {line.secondary}
                                </span>
                            </li>
                        );
                    })}
                    {page.data.items.length === 0 && (
                        <li className="text-xs text-gray-500">
                            Nothing is missing in this category.
                        </li>
                    )}
                    {page.data.total > page.data.items.length && (
                        <li className="text-xs text-gray-500 pt-1">
                            Showing {page.data.items.length} of{" "}
                            {page.data.total}.
                        </li>
                    )}
                </ul>
            ) : null}
            <p className="text-xs text-gray-500 mt-3">
                Fix these from Cache &amp; Automation: metadata enrichment fills
                art, MBIDs, and genres, and lyrics are fetched during
                enrichment. {totalGaps === 0 && "Everything is covered."}
            </p>
        </InsightPanel>
    );
}
