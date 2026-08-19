"use client";

import { useCallback, useState } from "react";
import { api, type LibraryHealthSummary } from "@/lib/api";
import { formatKbps } from "../format";
import { usePanelLoader } from "../hooks/usePanelLoader";
import { InsightPanel } from "./InsightPanel";

const FLOOR_CHOICES = [128, 192, 256, 320] as const;

interface QualityPanelProps {
    quality: LibraryHealthSummary["quality"];
}

/** Lossy albums whose derived average bitrate sits below a chosen floor. */
export function QualityPanel({ quality }: Readonly<QualityPanelProps>) {
    const [floor, setFloor] = useState(quality.floorKbps);
    const fetchPage = useCallback(
        () => api.getLibraryHealthQuality(floor, { limit: 50 }),
        [floor],
    );
    const page = usePanelLoader(fetchPage, "Failed to load quality outliers");

    return (
        <InsightPanel
            title="Quality outliers"
            subtitle={`${quality.albumsBelowFloor} lossy albums below ${quality.floorKbps} kbps`}
            isTruncated={quality.isTruncated}
            onFirstExpand={page.load}
            isLoading={page.isLoading}
            error={page.error}
        >
            <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="text-xs text-gray-400">Bitrate floor:</span>
                {FLOOR_CHOICES.map((choice) => (
                    <button
                        key={choice}
                        type="button"
                        onClick={() => setFloor(choice)}
                        className={`px-2 py-1 text-xs rounded-full border ${
                            choice === floor
                                ? "border-brand text-white bg-white/10"
                                : "border-white/10 text-gray-400"
                        }`}
                    >
                        {choice} kbps
                    </button>
                ))}
                <button
                    type="button"
                    onClick={page.load}
                    className="px-2 py-1 text-xs rounded-full border border-white/10 text-gray-400"
                >
                    Apply
                </button>
            </div>
            {page.data && (
                <ul className="space-y-1">
                    {page.data.items.map((album) => (
                        <li
                            key={album.albumId}
                            className="text-sm text-gray-300 flex justify-between gap-3"
                        >
                            <span className="truncate">
                                {album.title}
                                <span className="text-gray-500">
                                    {" "}
                                    — {album.artist.name}
                                </span>
                            </span>
                            <span className="text-gray-500 whitespace-nowrap">
                                ~{formatKbps(album.averageBitrateKbps)} ·{" "}
                                {album.trackCount} tracks
                            </span>
                        </li>
                    ))}
                    {page.data.items.length === 0 && (
                        <li className="text-xs text-gray-500">
                            No lossy albums below this floor.
                        </li>
                    )}
                    {page.data.total > page.data.items.length && (
                        <li className="text-xs text-gray-500 pt-1">
                            Showing {page.data.items.length} of{" "}
                            {page.data.total}.
                        </li>
                    )}
                </ul>
            )}
        </InsightPanel>
    );
}
