"use client";

/**
 * Tabbed container for provider-specific Explore content.
 *
 * Groups YouTube Music and TIDAL content under separate tabs.
 * Renders nothing when both providers are disabled, or renders
 * content directly (no tab bar) when only one provider is active.
 */

import { useState } from "react";
import { MoodsGenresSection } from "./MoodsGenresSection";
import { FeaturedShelvesSection } from "./FeaturedShelvesSection";
import { TidalMixesSection } from "./TidalMixesSection";
import { TidalMoodsGenresSection } from "./TidalMoodsGenresSection";
import { TidalFeaturedShelvesSection } from "./TidalFeaturedShelvesSection";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { FeaturedPlaylistsGrid } from "@/features/home/components/FeaturedPlaylistsGrid";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import type { YtMusicCategory, YtMusicHomeShelf, PlaylistPreview, TidalMixPreview, TidalBrowseShelf, TidalGenre } from "@/hooks/useQueries";

type TabId = "youtube" | "tidal";

interface ProviderTabSectionProps {
    showYtMusicExplore: boolean;
    showTidalExplore: boolean;
    // YouTube Music data
    moodCategories: YtMusicCategory[];
    genreCategories: YtMusicCategory[];
    isMoodsLoading: boolean;
    homeShelves: YtMusicHomeShelf[];
    chartPlaylists: PlaylistPreview[];
    // TIDAL data
    tidalMixes: TidalMixPreview[];
    tidalMoods: TidalGenre[];
    tidalGenres: TidalGenre[];
    tidalHomeShelves: TidalBrowseShelf[];
    tidalExploreShelves: TidalBrowseShelf[];
}

/**
 * Renders the YouTube Music tab content.
 */
function YouTubeContent({
    moodCategories,
    genreCategories,
    isMoodsLoading,
    homeShelves,
    chartPlaylists,
}: Pick<ProviderTabSectionProps, "moodCategories" | "genreCategories" | "isMoodsLoading" | "homeShelves" | "chartPlaylists">) {
    return (
        <div className="space-y-8">
            <MoodsGenresSection
                moodCategories={moodCategories}
                genreCategories={genreCategories}
                isLoading={isMoodsLoading}
            />
            <FeaturedShelvesSection homeShelves={homeShelves} />
            {chartPlaylists.length > 0 && (
                <section>
                    <SectionHeader
                        title="Charts"
                        badge={<YouTubeBadge />}
                    />
                    <FeaturedPlaylistsGrid playlists={chartPlaylists} />
                </section>
            )}
        </div>
    );
}

/**
 * Renders the TIDAL tab content.
 */
function TidalContent({
    tidalMixes,
    tidalMoods,
    tidalGenres,
    tidalHomeShelves,
    tidalExploreShelves,
}: Pick<ProviderTabSectionProps, "tidalMixes" | "tidalMoods" | "tidalGenres" | "tidalHomeShelves" | "tidalExploreShelves">) {
    return (
        <div className="space-y-8">
            <TidalMixesSection mixes={tidalMixes} />
            <TidalMoodsGenresSection genres={tidalGenres} moods={tidalMoods} />
            <TidalFeaturedShelvesSection
                homeShelves={tidalHomeShelves}
                exploreShelves={tidalExploreShelves}
            />
        </div>
    );
}

/**
 * Renders provider content in a tabbed layout, single provider layout,
 * or nothing depending on which providers are enabled.
 */
export function ProviderTabSection(props: ProviderTabSectionProps) {
    const { showYtMusicExplore, showTidalExplore } = props;
    const [activeTab, setActiveTab] = useState<TabId>("youtube");

    // Neither provider enabled — render nothing
    if (!showYtMusicExplore && !showTidalExplore) return null;

    // Only one provider — render directly without tab bar
    if (!showTidalExplore) {
        return (
            <YouTubeContent
                moodCategories={props.moodCategories}
                genreCategories={props.genreCategories}
                isMoodsLoading={props.isMoodsLoading}
                homeShelves={props.homeShelves}
                chartPlaylists={props.chartPlaylists}
            />
        );
    }

    if (!showYtMusicExplore) {
        return (
            <TidalContent
                tidalMixes={props.tidalMixes}
                tidalMoods={props.tidalMoods}
                tidalGenres={props.tidalGenres}
                tidalHomeShelves={props.tidalHomeShelves}
                tidalExploreShelves={props.tidalExploreShelves}
            />
        );
    }

    // Both providers — render tab bar with switching
    const tabs: { id: TabId; label: string }[] = [
        { id: "youtube", label: "YouTube Music" },
        { id: "tidal", label: "TIDAL" },
    ];

    return (
        <div>
            {/* Tab bar */}
            <div className="flex gap-1 bg-white/5 rounded-lg p-1 mb-6 w-fit">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                            activeTab === tab.id
                                ? "bg-white/10 text-white"
                                : "text-gray-400 hover:text-white"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Tab content */}
            {activeTab === "youtube" && (
                <YouTubeContent
                    moodCategories={props.moodCategories}
                    genreCategories={props.genreCategories}
                    isMoodsLoading={props.isMoodsLoading}
                    homeShelves={props.homeShelves}
                    chartPlaylists={props.chartPlaylists}
                />
            )}
            {activeTab === "tidal" && (
                <TidalContent
                    tidalMixes={props.tidalMixes}
                    tidalMoods={props.tidalMoods}
                    tidalGenres={props.tidalGenres}
                    tidalHomeShelves={props.tidalHomeShelves}
                    tidalExploreShelves={props.tidalExploreShelves}
                />
            )}
        </div>
    );
}
