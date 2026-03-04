"use client";

import { Play, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
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
 * hover play button, and title + description below.
 */
export function RadioStationCard({ station, onPlay, isLoading }: RadioStationCardProps) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();

    const handlePlayClick = () => {
        if (isLoading) {
            return;
        }
        triggerPlayFeedback();
        onPlay();
    };

    return (
        <button
            onClick={handlePlayClick}
            disabled={isLoading}
            className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left w-full"
        >
            {/* Square cover art */}
            <div className="relative aspect-square bg-[#282828] rounded-lg mb-3 overflow-hidden shadow-lg">
                <RadioStationMosaic filter={station.filter} className="absolute inset-0" />
                {/* Gradient tint overlay */}
                <div
                    className={`absolute inset-0 bg-gradient-to-br ${station.color} opacity-40 pointer-events-none`}
                />
                {/* Play button — bottom-right, appears on hover */}
                <div
                    className={cn(
                        "absolute bottom-2 right-2 transition-all duration-200",
                        isLoading || showSpinner
                            ? "opacity-100 translate-y-0"
                            : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 translate-y-2 group-hover:translate-y-0 group-focus-visible:translate-y-0"
                    )}
                >
                    <div className="w-10 h-10 rounded-full bg-[#60a5fa] flex items-center justify-center shadow-xl hover:scale-105 transition-transform">
                        {isLoading || showSpinner ? (
                            <Loader2 className="w-4 h-4 text-black animate-spin" />
                        ) : (
                            <Play className="w-4 h-4 fill-current text-black ml-0.5" />
                        )}
                    </div>
                </div>
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
