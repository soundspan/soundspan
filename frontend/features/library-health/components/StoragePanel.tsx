"use client";

import { useCallback } from "react";
import { api, type LibraryHealthSummary } from "@/lib/api";
import { formatBytes, formatKbps } from "../format";
import { useInsightPanelLoader } from "../hooks/useInsightPanelLoader";
import { InsightPanel } from "./InsightPanel";

interface StoragePanelProps {
    storage: LibraryHealthSummary["storage"];
    refreshToken: number;
}

/** Storage breakdown by format plus the artists using the most space. */
export function StoragePanel({
    storage,
    refreshToken,
}: Readonly<StoragePanelProps>) {
    const fetchReport = useCallback(() => api.getLibraryHealthStorage(), []);
    const report = useInsightPanelLoader(
        fetchReport,
        "Failed to load storage report",
        refreshToken,
    );

    return (
        <InsightPanel
            title="Storage"
            subtitle={`${storage.tracks} tracks · ${formatBytes(storage.totalFileSize)} across ${storage.mimeTypes} formats`}
            isTruncated={storage.isTruncated}
            onFirstExpand={report.onFirstExpand}
            onRetry={report.load}
            isLoading={report.isLoading}
            error={report.error}
        >
            {report.data && (
                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <h3 className="text-xs font-medium text-gray-400 mb-1">
                            By format
                        </h3>
                        <ul className="space-y-1">
                            {report.data.formats.map((format) => (
                                <li
                                    key={format.mime ?? "unknown"}
                                    className="text-sm text-gray-300 flex justify-between gap-3"
                                >
                                    <span className="truncate">
                                        {format.mime ?? "Unknown format"}
                                    </span>
                                    <span className="text-gray-500 whitespace-nowrap">
                                        {format.trackCount} ·{" "}
                                        {formatBytes(format.totalFileSize)} · ~
                                        {formatKbps(format.averageBitrateKbps)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <div>
                        <h3 className="text-xs font-medium text-gray-400 mb-1">
                            Largest artists
                        </h3>
                        <ul className="space-y-1">
                            {report.data.topArtists.map((artist) => (
                                <li
                                    key={artist.artistId}
                                    className="text-sm text-gray-300 flex justify-between gap-3"
                                >
                                    <span className="truncate">
                                        {artist.artistName}
                                    </span>
                                    <span className="text-gray-500 whitespace-nowrap">
                                        {artist.trackCount} ·{" "}
                                        {formatBytes(artist.totalFileSize)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}
        </InsightPanel>
    );
}
