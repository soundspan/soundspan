"use client";

import { useCallback } from "react";
import {
    api,
    type LibraryHealthDuplicateTier,
    type LibraryHealthSummary,
} from "@/lib/api";
import { formatBytes } from "../format";
import { useInsightPanelLoader } from "../hooks/useInsightPanelLoader";
import { InsightPanel } from "./InsightPanel";

const TIER_LABELS: Record<LibraryHealthDuplicateTier, string> = {
    audioHash: "Exact audio duplicate",
    recordingMbid: "Same recording",
    isrc: "Same ISRC",
};

interface DuplicatesPanelProps {
    duplicates: LibraryHealthSummary["duplicates"];
    refreshToken: number;
}

/** Report-only duplicate/version clusters found via durable track identity. */
export function DuplicatesPanel({
    duplicates,
    refreshToken,
}: Readonly<DuplicatesPanelProps>) {
    const fetchPage = useCallback(
        () => api.getLibraryHealthDuplicates({ limit: 25 }),
        [],
    );
    const page = useInsightPanelLoader(
        fetchPage,
        "Failed to load duplicate clusters",
        refreshToken,
    );

    return (
        <InsightPanel
            title="Duplicates and versions"
            subtitle={`${duplicates.clusters} clusters · ${duplicates.byTier.audioHash} exact · ${duplicates.byTier.recordingMbid} same recording · ${duplicates.byTier.isrc} same ISRC`}
            isTruncated={duplicates.isTruncated}
            onFirstExpand={page.onFirstExpand}
            onRetry={page.load}
            isLoading={page.isLoading}
            error={page.error}
        >
            <p className="text-xs text-gray-500 mb-3">
                Detection is report-only: nothing is hidden, merged, or deleted.
                Your files are never touched.
            </p>
            {page.data && (
                <ul className="space-y-3">
                    {page.data.clusters.map((cluster) => (
                        <li
                            key={`${cluster.tier}:${cluster.identity}`}
                            className="text-sm text-gray-300"
                        >
                            <div className="text-xs text-gray-400 mb-1">
                                {TIER_LABELS[cluster.tier]} ·{" "}
                                {cluster.memberCount} tracks ·{" "}
                                {formatBytes(cluster.totalFileSize)}
                            </div>
                            <ul className="space-y-0.5 pl-3 border-l border-white/10">
                                {cluster.members.map((member) => (
                                    <li
                                        key={member.id}
                                        className="flex justify-between gap-3"
                                    >
                                        <span className="truncate">
                                            {member.title}
                                            <span className="text-gray-500">
                                                {" "}
                                                — {member.artistName} ·{" "}
                                                {member.albumTitle}
                                            </span>
                                        </span>
                                        <span className="text-gray-500 whitespace-nowrap">
                                            {formatBytes(member.fileSize)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    ))}
                    {page.data.clusters.length === 0 && (
                        <li className="text-xs text-gray-500">
                            No duplicate clusters found.
                        </li>
                    )}
                    {page.data.total > page.data.clusters.length && (
                        <li className="text-xs text-gray-500">
                            Showing {page.data.clusters.length} of{" "}
                            {page.data.total} clusters.
                        </li>
                    )}
                </ul>
            )}
        </InsightPanel>
    );
}
