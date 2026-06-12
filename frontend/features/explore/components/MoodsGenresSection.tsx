/**
 * Moods & Genres section for the Explore page.
 *
 * Shows YT Music mood/genre categories with inline drilldown.
 */

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Music2 } from "lucide-react";
import { api } from "@/lib/api";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { frontendLogger } from "@/lib/logger";
import type { YtMusicCategory } from "@/hooks/useQueries";

interface MoodPlaylist {
    playlistId: string;
    title: string;
    thumbnailUrl: string | null;
    author: string;
}

interface MoodsGenresSectionProps {
    moodCategories: YtMusicCategory[];
    genreCategories: YtMusicCategory[];
    isLoading: boolean;
}

/**
 * Renders a horizontal row of category pills with gradient backgrounds.
 */
function CategoryRow({
    category,
    onPillClick,
}: {
    category: YtMusicCategory;
    onPillClick: (params: string, title: string) => void;
}) {
    const items = category.items ?? [];
    if (items.length === 0) return null;

    return (
        <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-300 mb-3">
                {category.title}
            </h3>
            <div className="flex flex-wrap gap-2">
                {items.map((item, i) => {
                    const hue = (i * 37 + 180) % 360;
                    return (
                        <button
                            key={item.params ?? i}
                            onClick={() => {
                                if (item.params) {
                                    onPillClick(item.params, item.title);
                                }
                            }}
                            className="flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium text-white transition-opacity hover:opacity-80"
                            style={{
                                background: `linear-gradient(135deg, hsl(${hue}, 60%, 35%), hsl(${(hue + 40) % 360}, 50%, 25%))`,
                            }}
                        >
                            {item.title}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * Renders the Moods & Genres section content.
 */
export function MoodsGenresSection({
    moodCategories,
    genreCategories,
    isLoading,
}: MoodsGenresSectionProps) {
    const [activeMoodTitle, setActiveMoodTitle] = useState<string | null>(null);
    const [moodPlaylists, setMoodPlaylists] = useState<MoodPlaylist[]>([]);
    const [isLoadingMood, setIsLoadingMood] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const requestIdRef = useRef(0);

    const handlePillClick = useCallback(async (params: string, title: string) => {
        const normalizedParams = params.trim();
        if (!normalizedParams) return;

        const thisRequest = ++requestIdRef.current;
        setActiveMoodTitle(title);
        setMoodPlaylists([]);
        setLoadError(null);
        setIsLoadingMood(true);

        try {
            const response = await api.get<{
                playlists: MoodPlaylist[];
                source: string;
            }>(`/browse/ytmusic/mood-playlists?params=${encodeURIComponent(normalizedParams)}`);
            if (thisRequest !== requestIdRef.current) return;
            setMoodPlaylists(Array.isArray(response.playlists) ? response.playlists : []);
        } catch (error) {
            if (thisRequest !== requestIdRef.current) return;
            frontendLogger.warn("Failed to load YT mood playlists", error);
            setMoodPlaylists([]);
            setLoadError("Failed to load playlists. Try another mood or genre.");
        } finally {
            if (thisRequest === requestIdRef.current) {
                setIsLoadingMood(false);
            }
        }
    }, []);

    const handleBack = useCallback(() => {
        setActiveMoodTitle(null);
        setMoodPlaylists([]);
        setLoadError(null);
    }, []);

    // No content available — render nothing
    if (!isLoading && moodCategories.length === 0 && genreCategories.length === 0) return null;

    // Drilldown view: show playlists for the selected mood/genre
    if (activeMoodTitle) {
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
                            {activeMoodTitle}
                        </h2>
                    </div>

                    {isLoadingMood && (
                        <div className="flex items-center justify-center py-20">
                            <GradientSpinner size="md" />
                        </div>
                    )}

                    {!isLoadingMood && moodPlaylists.length > 0 && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                            {moodPlaylists.map((item) => (
                                <Link
                                    key={item.playlistId}
                                    href={`/explore/yt-playlist/${encodeURIComponent(item.playlistId)}`}
                                    className="group cursor-pointer"
                                >
                                    <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                                        {item.thumbnailUrl ? (
                                            <img
                                                src={api.getBrowseImageUrl(item.thumbnailUrl)}
                                                alt={item.title}
                                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-purple-500/30 to-purple-500/10">
                                                <Music2 className="w-12 h-12 text-gray-600" />
                                            </div>
                                        )}
                                    </div>
                                    <h3 className="text-sm font-semibold text-white truncate mb-1">
                                        {item.title}
                                    </h3>
                                    {item.author && (
                                        <p className="text-xs text-gray-400 truncate">
                                            {item.author}
                                        </p>
                                    )}
                                </Link>
                            ))}
                        </div>
                    )}

                    {!isLoadingMood && loadError && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <Music2 className="w-12 h-12 text-gray-500 mb-4" />
                            <h3 className="text-lg font-medium text-white mb-2">
                                Unable to load playlists
                            </h3>
                            <p className="text-sm text-gray-400">{loadError}</p>
                        </div>
                    )}

                    {!isLoadingMood && !loadError && moodPlaylists.length === 0 && (
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
            {/* Mood Categories */}
            {moodCategories.length > 0 && (
                <section>
                    <SectionHeader title="Moods" badge={<YouTubeBadge />} />
                    {moodCategories.map((cat, i) => (
                        <CategoryRow
                            key={cat.title ?? i}
                            category={cat}
                            onPillClick={handlePillClick}
                        />
                    ))}
                </section>
            )}

            {/* Genre Categories */}
            {genreCategories.length > 0 && (
                <section>
                    <SectionHeader title="Genres" badge={<YouTubeBadge />} />
                    {genreCategories.map((cat, i) => (
                        <CategoryRow
                            key={cat.title ?? i}
                            category={cat}
                            onPillClick={handlePillClick}
                        />
                    ))}
                </section>
            )}

        </div>
    );
}
