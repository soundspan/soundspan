"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, Play, Loader2, Shuffle } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { toast } from "sonner";
import { shuffleArray } from "@/utils/shuffle";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { cn } from "@/utils/cn";
import { PageHeader } from "@/components/layout/PageHeader";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface RadioStation {
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
            | "workout";
        value?: string;
    };
    minTracks?: number;
}

interface GenreCount {
    genre: string;
    count: number;
}

// Static radio stations
const STATIC_STATIONS: RadioStation[] = [
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

interface DecadeCount {
    decade: number;
    count: number;
}

// Decade color mapping - covers from 1700s (classical) to 2020s
const DECADE_COLORS: Record<number, string> = {
    1700: "from-amber-800/30 to-yellow-900/30",
    1710: "from-amber-700/30 to-yellow-800/30",
    1720: "from-amber-700/30 to-yellow-800/30",
    1730: "from-amber-700/30 to-yellow-800/30",
    1740: "from-amber-700/30 to-yellow-800/30",
    1750: "from-amber-600/30 to-yellow-700/30",
    1760: "from-amber-600/30 to-yellow-700/30",
    1770: "from-amber-600/30 to-yellow-700/30",
    1780: "from-amber-600/30 to-yellow-700/30",
    1790: "from-amber-600/30 to-yellow-700/30",
    1800: "from-slate-600/30 to-gray-700/30",
    1810: "from-slate-600/30 to-gray-700/30",
    1820: "from-slate-500/30 to-gray-600/30",
    1830: "from-slate-500/30 to-gray-600/30",
    1840: "from-slate-500/30 to-gray-600/30",
    1850: "from-slate-400/30 to-gray-500/30",
    1860: "from-slate-400/30 to-gray-500/30",
    1870: "from-slate-400/30 to-gray-500/30",
    1880: "from-slate-400/30 to-gray-500/30",
    1890: "from-slate-400/30 to-gray-500/30",
    1900: "from-sepia-400/30 to-amber-500/30",
    1910: "from-amber-400/30 to-yellow-500/30",
    1920: "from-yellow-500/30 to-amber-600/30",
    1930: "from-orange-400/30 to-amber-500/30",
    1940: "from-red-400/30 to-orange-500/30",
    1950: "from-pink-400/30 to-red-500/30",
    1960: "from-amber-500/30 to-orange-600/30",
    1970: "from-orange-500/30 to-red-600/30",
    1980: "from-fuchsia-500/30 to-purple-600/30",
    1990: "from-purple-500/30 to-violet-600/30",
    2000: "from-blue-500/30 to-cyan-600/30",
    2010: "from-teal-500/30 to-emerald-600/30",
    2020: "from-orange-500/30 to-amber-600/30",
};

const getDecadeColor = (decade: number): string => {
    return DECADE_COLORS[decade] || "from-gray-500/30 to-slate-600/30";
};

const getDecadeName = (decade: number): string => {
    if (decade < 1900) return `${decade}s`;
    if (decade < 2000) return `${decade.toString().slice(2)}s`;
    return `${decade}s`;
};

const getDecadeDescription = (decade: number, count: number): string => {
    return `${decade}-${decade + 9} • ${count} tracks`;
};

// Genre color mapping
const GENRE_COLORS: Record<string, string> = {
    rock: "from-red-500/30 to-orange-600/30",
    pop: "from-pink-500/30 to-rose-600/30",
    "hip hop": "from-purple-500/30 to-indigo-600/30",
    "hip-hop": "from-purple-500/30 to-indigo-600/30",
    rap: "from-purple-500/30 to-indigo-600/30",
    electronic: "from-cyan-500/30 to-blue-600/30",
    jazz: "from-amber-500/30 to-yellow-600/30",
    classical: "from-slate-400/30 to-gray-500/30",
    metal: "from-zinc-600/30 to-neutral-700/30",
    country: "from-orange-400/30 to-amber-500/30",
    folk: "from-green-500/30 to-emerald-600/30",
    indie: "from-violet-500/30 to-purple-600/30",
    alternative: "from-indigo-500/30 to-blue-600/30",
    "r&b": "from-fuchsia-500/30 to-pink-600/30",
    soul: "from-amber-600/30 to-orange-700/30",
    blues: "from-blue-600/30 to-indigo-700/30",
    punk: "from-lime-500/30 to-green-600/30",
    reggae: "from-green-400/30 to-yellow-500/30",
    default: "from-gray-500/30 to-slate-600/30",
};

const getGenreColor = (genre: string): string => {
    const lower = genre.toLowerCase();
    return GENRE_COLORS[lower] || GENRE_COLORS.default;
};

// Radio Station Card Component
function RadioStationCard({ 
    station, 
    onPlay, 
    isLoading 
}: { 
    station: RadioStation; 
    onPlay: () => void; 
    isLoading: boolean;
}) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();

    const handlePlayClick = () => {
        triggerPlayFeedback();
        onPlay();
    };

    return (
        <button
            onClick={handlePlayClick}
            disabled={isLoading}
            className={`
                relative group w-full
                aspect-[4/3] rounded-lg overflow-hidden
                bg-gradient-to-br ${station.color}
                border border-white/10 hover:border-white/20
                transition-all duration-200
                hover:scale-[1.02] active:scale-[0.98]
                disabled:opacity-50 disabled:cursor-not-allowed
            `}
        >
            {/* Content */}
            <div className="absolute inset-0 p-3 flex flex-col justify-between">
                <div className="flex items-center gap-1.5">
                    <AudioLines className="w-4 h-4 text-white/60" />
                    <span className="text-[10px] text-white/60 font-medium uppercase tracking-wider">
                        Radio
                    </span>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white truncate leading-tight">
                        {station.name}
                    </h3>
                    <p className="text-xs text-white/50 truncate">
                        {station.description}
                    </p>
                </div>
            </div>

            <div
                className={cn(
                    "absolute inset-0 bg-black/40 transition-opacity flex items-center justify-center",
                    isLoading || showSpinner
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                )}
            >
                <div className="w-10 h-10 rounded-full bg-[#60a5fa] border border-[#93c5fd]/60 flex items-center justify-center shadow-lg transform scale-90 group-hover:scale-100 group-focus-visible:scale-100 transition-transform">
                    {isLoading || showSpinner ? (
                        <Loader2 className="w-4 h-4 text-black animate-spin" />
                    ) : (
                        <Play className="w-4 h-4 fill-current text-black ml-0.5" />
                    )}
                </div>
            </div>

        </button>
    );
}

// Section Header Component
function SectionHeader({ title, description }: { title: string; description?: string }) {
    return (
        <div className="mb-4">
            <h2 className="text-xl font-bold text-white">{title}</h2>
            {description && <p className="text-sm text-white/50 mt-1">{description}</p>}
        </div>
    );
}

export default function RadioPage() {
    const { playTracks } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);

    // Fetch genres from library
    const { data: genresData, isLoading: genresLoading } = useQuery({
        queryKey: ["library", "genres"],
        queryFn: () => api.get<{ genres: GenreCount[] }>("/library/genres"),
        staleTime: 5 * 60 * 1000,
        select: (data) => (data.genres || []).filter((g) => g.count >= 15),
    });

    // Fetch decades from library
    const { data: decadesData, isLoading: decadesLoading } = useQuery({
        queryKey: ["library", "decades"],
        queryFn: () => api.get<{ decades: DecadeCount[] }>("/library/decades"),
        staleTime: 5 * 60 * 1000,
        select: (data) => data.decades || [],
    });

    const genres = genresData ?? [];
    const decades = decadesData ?? [];
    const isLoading = genresLoading || decadesLoading;

    const startRadio = async (station: RadioStation) => {
        setLoadingStation(station.id);

        try {
            const params = new URLSearchParams();
            params.set("type", station.filter.type);
            if (station.filter.value) {
                params.set("value", station.filter.value);
            }
            params.set("limit", "100");

            const response = await api.get<{ tracks: Track[] }>(`/library/radio?${params.toString()}`);

            if (!response.tracks || response.tracks.length === 0) {
                toast.error(`No tracks found for ${station.name}`);
                return;
            }

            if (response.tracks.length < (station.minTracks || 10)) {
                toast.error(`Not enough tracks for ${station.name} radio`, {
                    description: `Found ${response.tracks.length}, need at least ${station.minTracks || 10}`,
                });
                return;
            }

            // Shuffle the tracks
            const shuffled = shuffleArray(response.tracks);

            // Start playing
            playTracks(shuffled, 0);
            toast.success(`${station.name} Radio`, {
                description: `Shuffling ${shuffled.length} tracks`,
                icon: <Shuffle className="w-4 h-4" />,
            });
        } catch (error) {
            sharedFrontendLogger.error("Failed to start radio:", error);
            toast.error("Failed to start radio station");
        } finally {
            setLoadingStation(null);
        }
    };

    // Create genre stations from library
    const genreStations: RadioStation[] = genres.map((g) => ({
        id: `genre-${g.genre}`,
        name: g.genre,
        description: `${g.count} tracks`,
        color: getGenreColor(g.genre),
        filter: { type: "genre" as const, value: g.genre },
        minTracks: 15,
    }));

    // Create decade stations from library (dynamically based on what's available)
    const decadeStations: RadioStation[] = decades.map((d) => ({
        id: `decade-${d.decade}`,
        name: getDecadeName(d.decade),
        description: getDecadeDescription(d.decade, d.count),
        color: getDecadeColor(d.decade),
        filter: { type: "decade" as const, value: d.decade.toString() },
        minTracks: 15,
    }));

    return (
        <div className="min-h-screen relative">
            {/* Hero gradient */}
            <div 
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background: "linear-gradient(to bottom, rgba(59, 130, 246, 0.15) 0%, rgba(139, 92, 246, 0.08) 40%, transparent 100%)",
                    height: "35vh"
                }}
            />
            <div 
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background: "radial-gradient(ellipse at top, rgba(59, 130, 246, 0.1) 0%, transparent 70%)",
                    height: "25vh"
                }}
            />

            {/* Content */}
            <div className="relative px-4 md:px-8 py-6">
                {/* Header */}
                <PageHeader
                    title="Radio Stations"
                    subtitle="Continuous shuffle from your library"
                    icon={AudioLines}
                    className="mb-8"
                />

                {/* Quick Start Section */}
                <section className="mb-10">
                    <SectionHeader 
                        title="Quick Start" 
                        description="Jump into your music instantly" 
                    />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                        {STATIC_STATIONS.map((station) => (
                            <RadioStationCard
                                key={station.id}
                                station={station}
                                onPlay={() => startRadio(station)}
                                isLoading={loadingStation === station.id}
                            />
                        ))}
                    </div>
                </section>

                {/* Genres Section */}
                {(isLoading || genreStations.length > 0) && (
                    <section className="mb-10">
                        <SectionHeader 
                            title="By Genre" 
                            description="Shuffle tracks from specific genres" 
                        />
                        {isLoading ? (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="aspect-[4/3] rounded-lg bg-white/5 animate-pulse" />
                                ))}
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {genreStations.map((station) => (
                                    <RadioStationCard
                                        key={station.id}
                                        station={station}
                                        onPlay={() => startRadio(station)}
                                        isLoading={loadingStation === station.id}
                                    />
                                ))}
                            </div>
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
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="aspect-[4/3] rounded-lg bg-white/5 animate-pulse" />
                                ))}
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {decadeStations.map((station) => (
                                    <RadioStationCard
                                        key={station.id}
                                        station={station}
                                        onPlay={() => startRadio(station)}
                                        isLoading={loadingStation === station.id}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                )}

                {/* Info */}
                <div className="mt-12 p-4 rounded-lg bg-white/5 border border-white/10">
                    <h3 className="text-sm font-semibold text-white mb-2">About Radio Stations</h3>
                    <p className="text-sm text-white/60">
                        Radio stations are generated from your personal music library. As you add more music, 
                        new genre and decade stations will automatically appear. Each station requires a minimum 
                        number of tracks to ensure a good listening experience.
                    </p>
                </div>
            </div>
        </div>
    );
}
