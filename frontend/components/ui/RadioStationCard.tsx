"use client";

import { Loader2 } from "lucide-react";
import { RadioStationMosaic } from "@/app/radio/RadioStationMosaic";

export interface RadioStationCardStation {
    id: string;
    name: string;
    description: string;
    color: string;
    filter: {
        type:
            | "genre"
            | "decade"
            | "discovery"
            | "favorites"
            | "all"
            | "workout"
            | "liked";
        value?: string;
    };
    minTracks?: number;
}

interface RadioStationCardProps {
    station: RadioStationCardStation;
    onPlay: () => void;
    isLoading: boolean;
}

/**
 * Square radio station card with mosaic cover art, gradient overlay,
 * and title + description below. The whole card is the click target;
 * a spinner appears over the art while the station opens.
 */
export function RadioStationCard({
    station,
    onPlay,
    isLoading,
}: RadioStationCardProps) {
    const handlePlayClick = () => {
        if (isLoading) {
            return;
        }
        onPlay();
    };

    return (
        <button
            onClick={handlePlayClick}
            disabled={isLoading}
            className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left w-full"
        >
            {/* Square cover art */}
            <div className="relative aspect-square bg-surface-highlight rounded-lg mb-3 overflow-hidden shadow-lg">
                <RadioStationMosaic
                    filter={station.filter}
                    className="absolute inset-0"
                />
                {/* Gradient tint overlay */}
                <div
                    className={`absolute inset-0 bg-gradient-to-br ${station.color} opacity-40 pointer-events-none`}
                />
                {/* Loading spinner — bottom-right, only while the station opens */}
                {isLoading && (
                    <div className="absolute bottom-2 right-2">
                        <div className="w-10 h-10 rounded-full bg-brand-hover flex items-center justify-center shadow-xl">
                            <Loader2 className="w-4 h-4 text-black animate-spin" />
                        </div>
                    </div>
                )}
            </div>
            {/* Title + description below art */}
            <h3 className="text-sm font-semibold text-white truncate">
                {station.name}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5 truncate">
                {station.description}
            </p>
        </button>
    );
}
