"use client";

import { useState, useEffect, useMemo } from "react";
import { shuffleArray } from "@/utils/shuffle";
import { Shuffle } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { RadioStationCard, RadioStationCardStation } from "@/components/ui/RadioStationCard";
import {
    GenreCount,
    selectFeaturedRadioGenres,
} from "./libraryRadioStationsGenreSelection";

type RadioStation = RadioStationCardStation;

// Static radio stations (always shown if tracks exist)
const STATIC_STATIONS: RadioStation[] = [
    {
        id: "all",
        name: "Shuffle All",
        description: "Your entire library",
        color: "from-[#3b82f6]/60 to-amber-600/40",
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

function diversifyTracksByArtist(tracks: Track[]): Track[] {
    if (tracks.length === 0) {
        return [];
    }

    const maxPerArtist = 2;
    const selected: Track[] = [];
    const overflow: Track[] = [];
    const artistCounts = new Map<string, number>();

    for (const track of tracks) {
        const artistKey =
            track.artist?.id ||
            track.artist?.name?.trim().toLowerCase() ||
            `unknown:${track.id}`;
        const count = artistCounts.get(artistKey) ?? 0;

        if (count < maxPerArtist) {
            artistCounts.set(artistKey, count + 1);
            selected.push(track);
            continue;
        }

        overflow.push(track);
    }

    if (selected.length >= tracks.length) {
        return selected;
    }

    for (const track of overflow) {
        selected.push(track);
        if (selected.length >= tracks.length) {
            break;
        }
    }

    return selected;
}

/**
 * Fetches library genre and decade data, then builds three station lists:
 * quickStart (static stations), genres, and decades.
 */
export function useLibraryRadioData(skip = false) {
    const [genres, setGenres] = useState<GenreCount[]>([]);
    const [decades, setDecades] = useState<DecadeCount[]>([]);
    const [isLoading, setIsLoading] = useState(!skip);

    useEffect(() => {
        if (skip) return;
        const fetchData = async () => {
            try {
                const [genresRes, decadesRes] = await Promise.all([
                    api.get<{ genres: GenreCount[] }>("/library/genres"),
                    api.get<{ decades: DecadeCount[] }>("/library/decades"),
                ]);

                const validGenres = selectFeaturedRadioGenres(
                    genresRes.genres || []
                );
                setGenres(validGenres);
                setDecades((decadesRes.decades || []).slice(0, 4));
            } catch (error) {
                sharedFrontendLogger.error("Failed to fetch radio data:", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchData();
    }, [skip]);

    const genreStations: RadioStation[] = useMemo(
        () =>
            genres.map((g) => ({
                id: `genre-${g.genre}`,
                name: g.genre,
                description: `${g.count} tracks`,
                color: getGenreColor(g.genre),
                filter: { type: "genre" as const, value: g.genre },
                minTracks: 15,
            })),
        [genres]
    );

    const decadeStations: RadioStation[] = useMemo(
        () =>
            decades.map((d) => ({
                id: `decade-${d.decade}`,
                name: getDecadeName(d.decade),
                description: `${d.count} tracks`,
                color: getDecadeColor(d.decade),
                filter: { type: "decade" as const, value: d.decade.toString() },
                minTracks: 15,
            })),
        [decades]
    );

    return {
        quickStartStations: STATIC_STATIONS,
        genreStations,
        decadeStations,
        allStations: useMemo(
            () => [...STATIC_STATIONS, ...genreStations, ...decadeStations],
            [genreStations, decadeStations]
        ),
        isLoading,
    };
}

interface LibraryRadioStationsProps {
    /** When provided, renders only these stations. Otherwise fetches its own data. */
    stations?: RadioStation[];
    /** External loading state (only used when stations prop is provided). */
    externalLoading?: boolean;
}

/**
 * Renders the LibraryRadioStations component as a responsive grid of
 * full-size square radio station cards with mosaic cover art.
 */
export function LibraryRadioStations({ stations: stationsProp, externalLoading }: LibraryRadioStationsProps = {}) {
    const { playTracks } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);

    // When no stations prop, fetch internally (backward compat for home page)
    const internalData = useLibraryRadioData(!!stationsProp);
    const allStations = stationsProp ?? internalData.allStations;
    const isLoading = stationsProp ? (externalLoading ?? false) : internalData.isLoading;

    const startRadio = async (station: RadioStation) => {
        setLoadingStation(station.id);

        try {
            const params = new URLSearchParams();
            params.set("type", station.filter.type);
            if (station.filter.value) {
                params.set("value", station.filter.value);
            }
            params.set("limit", "100");

            const response = await api.get<{ tracks: Track[] }>(
                `/library/radio?${params.toString()}`
            );

            if (!response.tracks || response.tracks.length === 0) {
                toast.error(`No tracks found for ${station.name}`);
                return;
            }

            if (response.tracks.length < (station.minTracks || 10)) {
                toast.error(`Not enough tracks for ${station.name} radio`, {
                    description: `Found ${
                        response.tracks.length
                    }, need at least ${station.minTracks || 10}`,
                });
                return;
            }

            const diversifiedTracks = diversifyTracksByArtist(response.tracks);
            const shuffled = shuffleArray(diversifiedTracks);
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
            {allStations.map((station) => (
                <RadioStationCard
                    key={station.id}
                    station={station}
                    onPlay={() => startRadio(station)}
                    isLoading={loadingStation === station.id}
                />
            ))}
        </div>
    );
}
