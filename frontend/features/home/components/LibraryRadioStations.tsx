"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, type RadioPlaylistFilter } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import {
    isGeneratedPlaylistDecade,
    openRadioStation,
} from "@/lib/radio/openRadioStation";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    RadioStationCard,
    RadioStationCardStation,
} from "@/components/ui/RadioStationCard";
import {
    GenreCount,
    selectFeaturedRadioGenres,
} from "./libraryRadioStationsGenreSelection";

/**
 * A renderable radio station card plus the playlist filter used to generate
 * its ephemeral playlist. Consumed by Explore's library-backed section
 * classification (`useExploreData`) in addition to the home-page grid.
 */
export type RadioStation = Omit<RadioStationCardStation, "filter"> & {
    filter: { type: "all" } | RadioPlaylistFilter;
};

// Static radio stations (always shown if tracks exist)
const STATIC_STATIONS: RadioStation[] = [
    {
        id: "all",
        name: "Shuffle All",
        description: "Your entire library",
        color: "from-brand/60 to-amber-600/40",
        filter: { type: "all" },
        minTracks: 10,
    },
    {
        id: "workout",
        name: "Workout",
        description: "High energy tracks",
        color: "from-red-500/50 to-orange-600/40",
        filter: { type: "workout" },
        minTracks: 15,
    },
    {
        id: "discovery",
        name: "Discovery",
        description: "Lesser-played gems",
        color: "from-emerald-500/50 to-teal-600/40",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: "Favorites",
        description: "Most played",
        color: "from-rose-500/50 to-pink-600/40",
        filter: { type: "favorites" },
        minTracks: 10,
    },
];

interface DecadeCount {
    decade: number;
    count: number;
}

// Decade color mapping
const DECADE_COLORS: Record<number, string> = {
    1700: "from-amber-800/50 to-yellow-900/40",
    1800: "from-slate-500/50 to-gray-600/40",
    1900: "from-amber-400/50 to-yellow-500/40",
    1920: "from-yellow-500/50 to-amber-600/40",
    1940: "from-red-400/50 to-orange-500/40",
    1950: "from-pink-400/50 to-red-500/40",
    1960: "from-amber-500/50 to-orange-600/40",
    1970: "from-orange-500/50 to-red-600/40",
    1980: "from-fuchsia-500/50 to-purple-600/40",
    1990: "from-purple-500/50 to-violet-600/40",
    2000: "from-blue-500/50 to-cyan-600/40",
    2010: "from-teal-500/50 to-emerald-600/40",
    2020: "from-orange-500/50 to-amber-600/40",
};

const getDecadeColor = (decade: number): string => {
    const knownDecades = Object.keys(DECADE_COLORS)
        .map(Number)
        .sort((a, b) => b - a);
    for (const known of knownDecades) {
        if (decade >= known) {
            return DECADE_COLORS[known];
        }
    }
    return "from-gray-500/50 to-slate-600/40";
};

const getDecadeName = (decade: number): string => {
    if (decade < 1900) return `${decade}s`;
    if (decade < 2000) return `${decade.toString().slice(2)}s`;
    return `${decade}s`;
};

// Genre color mapping
const GENRE_COLORS: Record<string, string> = {
    rock: "from-red-500/50 to-orange-600/40",
    pop: "from-pink-500/50 to-rose-600/40",
    "hip hop": "from-purple-500/50 to-indigo-600/40",
    "hip-hop": "from-purple-500/50 to-indigo-600/40",
    rap: "from-purple-500/50 to-indigo-600/40",
    electronic: "from-cyan-500/50 to-blue-600/40",
    jazz: "from-amber-500/50 to-yellow-600/40",
    classical: "from-slate-400/50 to-gray-500/40",
    metal: "from-zinc-600/50 to-neutral-700/40",
    country: "from-orange-400/50 to-amber-500/40",
    folk: "from-green-500/50 to-emerald-600/40",
    indie: "from-violet-500/50 to-purple-600/40",
    alternative: "from-indigo-500/50 to-blue-600/40",
    "r&b": "from-fuchsia-500/50 to-pink-600/40",
    soul: "from-amber-600/50 to-orange-700/40",
    blues: "from-blue-600/50 to-indigo-700/40",
    punk: "from-lime-500/50 to-green-600/40",
    reggae: "from-green-400/50 to-yellow-500/40",
    default: "from-gray-500/50 to-slate-600/40",
};

const getGenreColor = (genre: string): string => {
    const lower = genre.toLowerCase();
    return GENRE_COLORS[lower] || GENRE_COLORS.default;
};

/**
 * Fetches library genre and decade data, then builds three station lists:
 * quickStart (static stations), genres, and decades.
 */
export function useLibraryRadioData(skip = false) {
    const genresQuery = useQuery({
        queryKey: ["library", "genres"],
        queryFn: () => api.get<{ genres: GenreCount[] }>("/library/genres"),
        enabled: !skip,
        select: (data) => selectFeaturedRadioGenres(data.genres || []),
    });
    const decadesQuery = useQuery({
        queryKey: ["library", "decades"],
        queryFn: () => api.get<{ decades: DecadeCount[] }>("/library/decades"),
        enabled: !skip,
        select: (data) =>
            (data.decades || [])
                .filter((decade) => isGeneratedPlaylistDecade(decade.decade))
                .slice(0, 4),
    });
    const queryError = genresQuery.error ?? decadesQuery.error;

    useEffect(() => {
        if (!skip && queryError) {
            sharedFrontendLogger.error(
                "Failed to fetch radio data:",
                queryError,
            );
        }
    }, [queryError, skip]);

    const genreStations: RadioStation[] = useMemo(
        () =>
            (genresQuery.data ?? []).map((g) => ({
                id: `genre-${g.genre}`,
                name: g.genre,
                description: `${g.count} tracks`,
                color: getGenreColor(g.genre),
                filter: { type: "genre" as const, value: g.genre },
                minTracks: 15,
            })),
        [genresQuery.data],
    );

    const decadeStations: RadioStation[] = useMemo(
        () =>
            (decadesQuery.data ?? []).map((d) => ({
                id: `decade-${d.decade}`,
                name: getDecadeName(d.decade),
                description: `${d.count} tracks`,
                color: getDecadeColor(d.decade),
                filter: { type: "decade" as const, value: d.decade.toString() },
                minTracks: 15,
            })),
        [decadesQuery.data],
    );
    const hasInitialError =
        genresQuery.isLoadingError || decadesQuery.isLoadingError;
    const allStations = useMemo(
        () =>
            hasInitialError
                ? STATIC_STATIONS
                : [...STATIC_STATIONS, ...genreStations, ...decadeStations],
        [decadeStations, genreStations, hasInitialError],
    );

    return {
        quickStartStations: STATIC_STATIONS,
        genreStations: hasInitialError ? [] : genreStations,
        decadeStations: hasInitialError ? [] : decadeStations,
        allStations,
        isLoading: genresQuery.isLoading || decadesQuery.isLoading,
        genresQuery,
        decadesQuery,
    };
}

interface LibraryRadioStationsProps {
    /** When provided, renders only these stations. Otherwise fetches its own data. */
    stations?: RadioStation[];
    /** External loading state (only used when stations prop is provided). */
    externalLoading?: boolean;
}

/**
 * Fetches radio data only for callers that do not supply station data.
 */
function LibraryRadioStationsWithQuery() {
    const { allStations, isLoading } = useLibraryRadioData();
    return (
        <LibraryRadioStationGrid stations={allStations} isLoading={isLoading} />
    );
}

/** Renders one responsive grid of full-size radio station cards. */
function LibraryRadioStationGrid({
    stations,
    isLoading,
}: {
    stations: RadioStation[];
    isLoading: boolean;
}) {
    const router = useRouter();
    const { playTracks } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);

    const handleStation = async (station: RadioStation) => {
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

    if (isLoading) {
        return (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="p-3">
                        <div className="aspect-square rounded-lg bg-white/5 animate-pulse" />
                        <div className="h-3 w-2/3 bg-white/5 rounded mt-3 animate-pulse" />
                        <div className="h-2 w-1/2 bg-white/5 rounded mt-1.5 animate-pulse" />
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {stations.map((station) => (
                <RadioStationCard
                    key={station.id}
                    station={station}
                    onPlay={() => handleStation(station)}
                    isLoading={loadingStation === station.id}
                />
            ))}
        </div>
    );
}

/**
 * Renders radio stations from supplied data or the shared internal query.
 */
export function LibraryRadioStations({
    stations,
    externalLoading,
}: LibraryRadioStationsProps = {}) {
    if (stations !== undefined) {
        return (
            <LibraryRadioStationGrid
                stations={stations}
                isLoading={externalLoading ?? false}
            />
        );
    }
    return <LibraryRadioStationsWithQuery />;
}
