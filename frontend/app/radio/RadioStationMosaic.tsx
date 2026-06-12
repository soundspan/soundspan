"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import { cn } from "@/utils/cn";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import {
    createRadioMosaicCandidates,
    selectRadioMosaicTiles,
} from "./radioStationMosaicSelection";

export type RadioStationFilterType =
    | "genre"
    | "decade"
    | "discovery"
    | "favorites"
    | "all"
    | "workout"
    | "liked";

export interface RadioStationFilter {
    type: RadioStationFilterType;
    value?: string;
}

interface RadioStationMosaicProps {
    filter: RadioStationFilter;
    className?: string;
    tileCount?: number;
}

/**
 * Renders station-specific artwork as a single random album cover (re-rolled daily).
 */
export function RadioStationMosaic({
    filter,
    className,
    tileCount = 1,
}: RadioStationMosaicProps) {
    const dailySeed = new Date().toISOString().slice(0, 10);

    const { data: tiles, isLoading } = useQuery({
        queryKey: [
            "radio",
            "mosaic",
            filter.type,
            filter.value ?? "",
            tileCount,
            dailySeed,
        ],
        queryFn: async () => {
            try {
                const response = await api.getRadioTracks(
                    filter.type,
                    filter.value,
                    96
                );
                const candidates = createRadioMosaicCandidates(
                    (response.tracks || []) as Track[]
                );
                return selectRadioMosaicTiles(candidates, tileCount);
            } catch (error) {
                sharedFrontendLogger.error(
                    "[RadioStationMosaic] Failed to fetch station tracks:",
                    error
                );
                return [];
            }
        },
        staleTime: 24 * 60 * 60 * 1000,
    });

    const coverUrls = useMemo(
        () => (tiles || []).map((tile) => api.getCoverArtUrl(tile.coverArt, 200)),
        [tiles]
    );

    return (
        <div className={cn("w-full h-full", className)}>
            <CoverMosaic
                coverUrls={coverUrls}
                layout="2x2"
                isLoading={isLoading}
                hoverScale
                imageSizes="(max-width: 768px) 120px, 180px"
                emptyState={
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1f2937] to-[#111827]">
                        <Music className="w-10 h-10 text-white/35" />
                    </div>
                }
            />
        </div>
    );
}
