import { useQuery } from "@tanstack/react-query";
import { api, type RadioPlaylistFilter } from "@/lib/api";
import type { RadioStationCardStation } from "@/components/ui/RadioStationCard";
import { isGeneratedPlaylistDecade } from "@/lib/radio/openRadioStation";

/**
 * Station shape used by the /radio page: the card's loose filter union is
 * narrowed so non-shuffle stations are provably valid playlist filters.
 */
export type RadioPageStation = Omit<RadioStationCardStation, "filter"> & {
    filter: { type: "all" } | RadioPlaylistFilter;
};

export interface GenreCount {
    genre: string;
    count: number;
}

export interface DecadeCount {
    decade: number;
    count: number;
}

const MIN_GENRE_TRACKS = 15;

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

/** Builds genre stations from library counts, skipping sparse genres. */
export function buildGenreStations(genres: GenreCount[]): RadioPageStation[] {
    return genres
        .filter((g) => g.count >= MIN_GENRE_TRACKS)
        .map((g) => ({
            id: `genre-${g.genre}`,
            name: g.genre,
            description: `${g.count} tracks`,
            color: getGenreColor(g.genre),
            filter: { type: "genre" as const, value: g.genre },
            minTracks: 15,
        }));
}

/**
 * Builds decade stations from library counts, dropping decades the
 * generated-playlist API rejects.
 */
export function buildDecadeStations(
    decades: DecadeCount[],
): RadioPageStation[] {
    return decades
        .filter((d) => isGeneratedPlaylistDecade(d.decade))
        .map((d) => ({
            id: `decade-${d.decade}`,
            name: getDecadeName(d.decade),
            description: getDecadeDescription(d.decade, d.count),
            color: getDecadeColor(d.decade),
            filter: { type: "decade" as const, value: d.decade.toString() },
            minTracks: 15,
        }));
}

const STATION_DATA_STALE_TIME_MS = 5 * 60 * 1000;

/** Fetches library genre/decade counts and derives /radio station lists. */
export function useRadioPageStations() {
    const { data: genreStations, isLoading: genresLoading } = useQuery({
        queryKey: ["library", "genres"],
        queryFn: () => api.get<{ genres: GenreCount[] }>("/library/genres"),
        staleTime: STATION_DATA_STALE_TIME_MS,
        select: (data) => buildGenreStations(data.genres || []),
    });

    const { data: decadeStations, isLoading: decadesLoading } = useQuery({
        queryKey: ["library", "decades"],
        queryFn: () => api.get<{ decades: DecadeCount[] }>("/library/decades"),
        staleTime: STATION_DATA_STALE_TIME_MS,
        select: (data) => buildDecadeStations(data.decades || []),
    });

    return {
        genreStations: genreStations ?? [],
        decadeStations: decadeStations ?? [],
        isLoading: genresLoading || decadesLoading,
    };
}
