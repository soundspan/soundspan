"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { shuffleArray } from "@/utils/shuffle";
import {
    Radio,
    Play,
    Loader2,
    Shuffle,
    ChevronLeft,
    ChevronRight,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { toast } from "sonner";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
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

export function LibraryRadioStations() {
    const { playTracks } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();
    const [playFeedbackStationId, setPlayFeedbackStationId] = useState<string | null>(null);
    const [genres, setGenres] = useState<GenreCount[]>([]);
    const [decades, setDecades] = useState<DecadeCount[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [genresRes, decadesRes] = await Promise.all([
                    api.get<{ genres: GenreCount[] }>("/library/genres"),
                    api.get<{ decades: DecadeCount[] }>("/library/decades"),
                ]);

                const validGenres = (genresRes.genres || [])
                    .filter((g) => g.count >= 15)
                    .slice(0, 6);
                setGenres(validGenres);
                setDecades((decadesRes.decades || []).slice(0, 4));
            } catch (error) {
                sharedFrontendLogger.error("Failed to fetch radio data:", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchData();
    }, []);

    useEffect(() => {
        if (!showSpinner) {
            setPlayFeedbackStationId(null);
        }
    }, [showSpinner]);

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

    const allStations = useMemo(() => {
        const genreStations: RadioStation[] = genres.map((g) => ({
            id: `genre-${g.genre}`,
            name: g.genre,
            description: `${g.count} tracks`,
            color: getGenreColor(g.genre),
            filter: { type: "genre" as const, value: g.genre },
            minTracks: 15,
        }));

        const decadeStations: RadioStation[] = decades.map((d) => ({
            id: `decade-${d.decade}`,
            name: getDecadeName(d.decade),
            description: `${d.count} tracks`,
            color: getDecadeColor(d.decade),
            filter: { type: "decade" as const, value: d.decade.toString() },
            minTracks: 15,
        }));

        return [...STATIC_STATIONS, ...genreStations, ...decadeStations];
    }, [genres, decades]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const [currentPage, setCurrentPage] = useState(0);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Group stations into pages of 6 (2x3 grid) for mobile only
    const stationPages = useMemo(() => {
        const pages: RadioStation[][] = [];
        for (let i = 0; i < allStations.length; i += 6) {
            pages.push(allStations.slice(i, i + 6));
        }
        return pages;
    }, [allStations]);

    const checkScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 0);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);

        // Update current page for mobile
        if (isMobileOrTablet) {
            const pageWidth = el.clientWidth;
            const newPage = Math.round(el.scrollLeft / pageWidth);
            setCurrentPage(newPage);
        }
    }, [isMobileOrTablet]);

    useEffect(() => {
        checkScroll();
        const el = scrollRef.current;
        if (el) {
            el.addEventListener("scroll", checkScroll);
            window.addEventListener("resize", checkScroll);
        }
        return () => {
            if (el) el.removeEventListener("scroll", checkScroll);
            window.removeEventListener("resize", checkScroll);
        };
    }, [stationPages, isMobileOrTablet, checkScroll]);

    const scroll = (direction: "left" | "right") => {
        const el = scrollRef.current;
        if (!el) return;
        const scrollAmount = isMobileOrTablet
            ? el.clientWidth
            : el.clientWidth * 0.8;
        el.scrollBy({
            left: direction === "left" ? -scrollAmount : scrollAmount,
            behavior: "smooth",
        });
    };

    // Desktop: Compact horizontal card
    const renderDesktopCard = (station: RadioStation) => {
        const showStationSpinner =
            loadingStation === station.id ||
            (showSpinner && playFeedbackStationId === station.id);

        return (
            <button
                key={station.id}
                onClick={() => {
                    setPlayFeedbackStationId(station.id);
                    triggerPlayFeedback();
                    void startRadio(station);
                }}
                disabled={loadingStation !== null}
                className={cn(
                    "flex-shrink-0 snap-start",
                    "w-[160px] h-[72px] rounded-lg overflow-hidden",
                    `bg-gradient-to-br ${station.color}`,
                    "border border-white/10 hover:border-white/20",
                    "transition-all duration-200",
                    "hover:scale-[1.02] active:scale-[0.98]",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    "group relative"
                )}
            >
                <div className="absolute inset-0 p-3 flex flex-col justify-between">
                    <div className="flex items-center gap-1">
                        <Radio className="w-3 h-3 text-white/70" />
                        <span className="text-[8px] text-white/70 font-semibold uppercase tracking-wider">
                            Radio
                        </span>
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-white truncate leading-tight">
                            {station.name}
                        </h3>
                        <p className="text-[10px] text-white/60 truncate">
                            {station.description}
                        </p>
                    </div>
                </div>

                {showStationSpinner && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 text-white animate-spin" />
                    </div>
                )}

                {/* Play button on hover */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="w-8 h-8 rounded-full bg-[#60a5fa] flex items-center justify-center shadow-lg transform scale-90 group-hover:scale-100 transition-transform">
                        {showStationSpinner ? (
                            <Loader2 className="w-4 h-4 text-black animate-spin" />
                        ) : (
                            <Play
                                className="w-4 h-4 text-black ml-0.5"
                                fill="currentColor"
                            />
                        )}
                    </div>
                </div>
            </button>
        );
    };

    // Mobile: Card for 2x3 grid
    const renderMobileCard = (station: RadioStation) => (
        <button
            key={station.id}
            onClick={() => {
                setPlayFeedbackStationId(station.id);
                triggerPlayFeedback();
                void startRadio(station);
            }}
            disabled={loadingStation !== null}
            className={cn(
                "relative group w-full",
                "aspect-[5/3] rounded-lg overflow-hidden",
                `bg-gradient-to-br ${station.color}`,
                "border border-white/10",
                "transition-all duration-200",
                "active:scale-[0.98]",
                "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
        >
            <div className="absolute inset-0 p-2 flex flex-col justify-between">
                <div className="flex items-center gap-1">
                    <Radio className="w-2.5 h-2.5 text-white/70" />
                    <span className="text-[7px] text-white/70 font-semibold uppercase tracking-wider">
                        Radio
                    </span>
                </div>
                <div>
                    <h3 className="text-[11px] font-bold text-white truncate leading-tight">
                        {station.name}
                    </h3>
                    <p className="text-[9px] text-white/60 truncate">
                        {station.description}
                    </p>
                </div>
            </div>

            {(loadingStation === station.id ||
                (showSpinner && playFeedbackStationId === station.id)) && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Loader2 className="w-4 h-4 text-white animate-spin" />
                </div>
            )}
        </button>
    );

    // Desktop layout: single row horizontal carousel
    if (!isMobileOrTablet) {
        return (
            <div className="relative group/carousel">
                {canScrollLeft && (
                    <button
                        onClick={() => scroll("left")}
                        className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-black/80  flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black hover:scale-105 border border-white/10 shadow-lg -translate-x-1/2"
                        aria-label="Scroll left"
                    >
                        <ChevronLeft className="w-5 h-5 text-white" />
                    </button>
                )}

                <div
                    ref={scrollRef}
                    className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-3 px-1"
                >
                    {allStations.map((station) => renderDesktopCard(station))}

                    {isLoading &&
                        Array.from({ length: 6 }).map((_, i) => (
                            <div
                                key={i}
                                className="flex-shrink-0 w-[160px] h-[72px] rounded-lg bg-white/5 animate-pulse"
                            />
                        ))}
                </div>

                {canScrollRight && (
                    <button
                        onClick={() => scroll("right")}
                        className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-black/80  flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black hover:scale-105 border border-white/10 shadow-lg translate-x-1/2"
                        aria-label="Scroll right"
                    >
                        <ChevronRight className="w-5 h-5 text-white" />
                    </button>
                )}
            </div>
        );
    }

    // Mobile/Tablet layout: 2x3 grid pages
    return (
        <div className="relative">
            <div
                ref={scrollRef}
                className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-3"
            >
                {stationPages.map((page, pageIndex) => (
                    <div
                        key={pageIndex}
                        className="flex-shrink-0 snap-start w-full grid grid-cols-3 grid-rows-2 gap-2"
                    >
                        {page.map((station) => renderMobileCard(station))}
                        {page.length < 6 &&
                            Array.from({ length: 6 - page.length }).map(
                                (_, i) => (
                                    <div
                                        key={`empty-${i}`}
                                        className="aspect-[5/3]"
                                    />
                                )
                            )}
                    </div>
                ))}

                {isLoading && (
                    <div className="flex-shrink-0 snap-start w-full grid grid-cols-3 grid-rows-2 gap-2">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div
                                key={i}
                                className="aspect-[5/3] rounded-lg bg-white/5 animate-pulse"
                            />
                        ))}
                    </div>
                )}
            </div>

            {stationPages.length > 1 && (
                <div className="flex justify-center gap-1.5 mt-3">
                    {stationPages.map((_, index) => (
                        <button
                            key={index}
                            onClick={() => {
                                const el = scrollRef.current;
                                if (el) {
                                    el.scrollTo({
                                        left: index * el.clientWidth,
                                        behavior: "smooth",
                                    });
                                }
                            }}
                            className={cn(
                                "w-1.5 h-1.5 rounded-full transition-colors",
                                index === currentPage
                                    ? "bg-white"
                                    : "bg-white/30 hover:bg-white/50"
                            )}
                            aria-label={`Go to page ${index + 1}`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
