"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AudioLines } from "lucide-react";
import { useAudioControls } from "@/lib/audio-controls-context";
import { openRadioStation } from "@/lib/radio/openRadioStation";
import {
    useRadioPageStations,
    type RadioPageStation,
} from "@/lib/radio/radioPageStations";
import { PageHeader } from "@/components/layout/PageHeader";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { RadioStationCard } from "@/components/ui/RadioStationCard";

// Static radio stations
const STATIC_STATIONS: RadioPageStation[] = [
    {
        id: "all",
        name: "Shuffle All",
        description: "Your entire library",
        color: "from-brand/40 to-sky-400/30",
        filter: { type: "all" },
        minTracks: 10,
    },
    {
        id: "workout",
        name: "Workout",
        description: "High energy tracks",
        color: "from-red-500/30 to-orange-600/30",
        filter: { type: "workout" },
        minTracks: 15,
    },
    {
        id: "discovery",
        name: "Discovery",
        description: "Lesser-played gems",
        color: "from-emerald-500/30 to-teal-600/30",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: "Favorites",
        description: "Most played",
        color: "from-rose-500/30 to-pink-600/30",
        filter: { type: "favorites" },
        minTracks: 10,
    },
];

function StationGridSkeleton() {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
                <div
                    key={i}
                    className="aspect-square rounded-lg bg-white/5 animate-pulse"
                />
            ))}
        </div>
    );
}

function StationGrid({
    stations,
    loadingStation,
    onOpen,
}: {
    stations: RadioPageStation[];
    loadingStation: string | null;
    onOpen: (station: RadioPageStation) => void;
}) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {stations.map((station) => (
                <RadioStationCard
                    key={station.id}
                    station={station}
                    onPlay={() => onOpen(station)}
                    isLoading={loadingStation === station.id}
                />
            ))}
        </div>
    );
}

/**
 * Renders the RadioPage component.
 */
export default function RadioPage() {
    const router = useRouter();
    const { playTracks } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);
    const { genreStations, decadeStations, isLoading } = useRadioPageStations();

    const handleStation = async (station: RadioPageStation) => {
        setLoadingStation(station.id);
        try {
            await openRadioStation(station, {
                push: router.push,
                playTracks,
            });
        } finally {
            setLoadingStation(null);
        }
    };

    return (
        <div className="min-h-screen relative">
            {/* Hero gradient */}
            <div
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background:
                        "linear-gradient(to bottom, rgba(59, 130, 246, 0.15) 0%, rgba(139, 92, 246, 0.08) 40%, transparent 100%)",
                    height: "35vh",
                }}
            />
            <div
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background:
                        "radial-gradient(ellipse at top, rgba(59, 130, 246, 0.1) 0%, transparent 70%)",
                    height: "25vh",
                }}
            />

            {/* Content */}
            <div className="relative px-4 md:px-8 py-6">
                {/* Header */}
                <PageHeader
                    title="Radio Stations"
                    subtitle="Generated stations from your library"
                    icon={AudioLines}
                    className="mb-8"
                />

                {/* Quick Start Section */}
                <section className="mb-10">
                    <SectionHeader
                        title="Quick Start"
                        description="Open a ready-made station from your library"
                    />
                    <StationGrid
                        stations={STATIC_STATIONS}
                        loadingStation={loadingStation}
                        onOpen={handleStation}
                    />
                </section>

                {/* Genres Section */}
                {(isLoading || genreStations.length > 0) && (
                    <section className="mb-10">
                        <SectionHeader
                            title="By Genre"
                            description="Shuffle tracks from specific genres"
                        />
                        {isLoading ? (
                            <StationGridSkeleton />
                        ) : (
                            <StationGrid
                                stations={genreStations}
                                loadingStation={loadingStation}
                                onOpen={handleStation}
                            />
                        )}
                    </section>
                )}

                {/* Decades Section - Only show if there are decade stations */}
                {(isLoading || decadeStations.length > 0) && (
                    <section className="mb-10">
                        <SectionHeader
                            title="By Decade"
                            description="Travel through time with your music"
                        />
                        {isLoading ? (
                            <StationGridSkeleton />
                        ) : (
                            <StationGrid
                                stations={decadeStations}
                                loadingStation={loadingStation}
                                onOpen={handleStation}
                            />
                        )}
                    </section>
                )}

                {/* Info */}
                <div className="mt-12 p-4 rounded-lg bg-white/5 border border-white/10">
                    <h3 className="text-sm font-semibold text-white mb-2">
                        About Radio Stations
                    </h3>
                    <p className="text-sm text-white/60">
                        Radio stations are generated from your personal music
                        library. Opening a station builds a playlist you can
                        replay, regenerate, or extend with more tracks — Shuffle
                        All starts playing your whole library right away. As you
                        add more music, new genre and decade stations will
                        automatically appear.
                    </p>
                </div>
            </div>
        </div>
    );
}
