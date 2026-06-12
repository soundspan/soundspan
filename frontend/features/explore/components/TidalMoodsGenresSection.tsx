/**
 * TIDAL Moods & Genres section for the Explore page.
 *
 * Shows TIDAL mood and genre pills with inline drilldown to playlists.
 */

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Music2 } from "lucide-react";
import { api } from "@/lib/api";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { frontendLogger } from "@/lib/logger";
import type { TidalGenre } from "@/hooks/useQueries";

interface GenrePlaylist {
    playlistId: string;
    title: string;
    thumbnailUrl: string | null;
    numTracks: number;
}

interface TidalMoodsGenresSectionProps {
    genres: TidalGenre[];
    moods: TidalGenre[];
}

/**
 * Renders a flat row of genre/mood pills with gradient backgrounds.
 */
function PillRow({
    items,
    onPillClick,
}: {
    items: TidalGenre[];
    onPillClick: (path: string, name: string) => void;
}) {
    if (items.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2">
            {items.map((item, i) => {
                const hue = (i * 37 + 180) % 360;
                return (
                    <button
                        key={item.path ?? i}
                        onClick={() => {
                            if (item.path && item.hasPlaylists) {
                                onPillClick(item.path, item.name);
                            }
                        }}
                        disabled={!item.hasPlaylists}
                        className="flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                            background: `linear-gradient(135deg, hsl(${hue}, 60%, 35%), hsl(${(hue + 40) % 360}, 50%, 25%))`,
                        }}
                    >
                        {item.name}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Renders the TIDAL Moods & Genres section content with drilldown.
 */
export function TidalMoodsGenresSection({
    genres,
    moods,
}: TidalMoodsGenresSectionProps) {
    const [activeTitle, setActiveTitle] = useState<string | null>(null);
    const [playlists, setPlaylists] = useState<GenrePlaylist[]>([]);
    const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const requestIdRef = useRef(0);

    const handlePillClick = useCallback(async (path: string, name: string) => {
        const normalizedPath = path.trim();
        if (!normalizedPath) return;

        const thisRequest = ++requestIdRef.current;
        setActiveTitle(name);
        setPlaylists([]);
        setLoadError(null);
        setIsLoadingPlaylists(true);

        try {
            const response = await api.getTidalGenrePlaylists(normalizedPath);
            if (thisRequest !== requestIdRef.current) return;
            setPlaylists(Array.isArray(response.playlists) ? response.playlists : []);
        } catch (error) {
            if (thisRequest !== requestIdRef.current) return;
            frontendLogger.warn("Failed to load TIDAL genre playlists", error);
            setPlaylists([]);
            setLoadError("Failed to load playlists. Try another mood or genre.");
        } finally {
            if (thisRequest === requestIdRef.current) {
                setIsLoadingPlaylists(false);
            }
        }
    }, []);

    const handleBack = useCallback(() => {
        setActiveTitle(null);
        setPlaylists([]);
        setLoadError(null);
    }, []);

    // No content available — render nothing
    if (moods.length === 0 && genres.length === 0) return null;

    // Drilldown view: show playlists for the selected mood/genre
    if (activeTitle) {
        return (
            <div className="space-y-8">
                <div>
                    <div className="flex items-center gap-3 mb-6">
                        <button
                            type="button"
                            onClick={handleBack}
                            className="px-3 py-1.5 rounded-full bg-white/10 text-white text-xs font-medium hover:bg-white/20 transition-colors"
                        >
                            &larr; Back
                        </button>
                        <h2 className="text-xl font-bold text-white">
                            {activeTitle}
                        </h2>
                    </div>

                    {isLoadingPlaylists && (
                        <div className="flex items-center justify-center py-20">
                            <GradientSpinner size="md" />
                        </div>
                    )}

                    {!isLoadingPlaylists && playlists.length > 0 && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                            {playlists.map((item) => (
                                <Link
                                    key={item.playlistId}
                                    href={`/explore/tidal-playlist/${encodeURIComponent(item.playlistId)}`}
                                    className="group cursor-pointer"
                                >
                                    <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                                        {item.thumbnailUrl ? (
                                            <img
                                                src={api.getTidalBrowseImageUrl(item.thumbnailUrl)}
                                                alt={item.title}
                                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-cyan-500/30 to-cyan-500/10">
                                                <Music2 className="w-12 h-12 text-gray-600" />
                                            </div>
                                        )}
                                    </div>
                                    <h3 className="text-sm font-semibold text-white truncate mb-1">
                                        {item.title}
                                    </h3>
                                    {item.numTracks > 0 && (
                                        <p className="text-xs text-gray-400 truncate">
                                            {item.numTracks} tracks
                                        </p>
                                    )}
                                </Link>
                            ))}
                        </div>
                    )}

                    {!isLoadingPlaylists && loadError && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <Music2 className="w-12 h-12 text-gray-500 mb-4" />
                            <h3 className="text-lg font-medium text-white mb-2">
                                Unable to load playlists
                            </h3>
                            <p className="text-sm text-gray-400">{loadError}</p>
                        </div>
                    )}

                    {!isLoadingPlaylists && !loadError && playlists.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <Music2 className="w-12 h-12 text-gray-500 mb-4" />
                            <h3 className="text-lg font-medium text-white mb-2">
                                No playlists found
                            </h3>
                            <p className="text-sm text-gray-400">
                                Try another mood or genre.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Mood Pills */}
            {moods.length > 0 && (
                <section>
                    <SectionHeader title="Moods" badge={<TidalBadge />} />
                    <PillRow items={moods} onPillClick={handlePillClick} />
                </section>
            )}

            {/* Genre Pills */}
            {genres.length > 0 && (
                <section>
                    <SectionHeader title="Genres" badge={<TidalBadge />} />
                    <PillRow items={genres} onPillClick={handlePillClick} />
                </section>
            )}

        </div>
    );
}
