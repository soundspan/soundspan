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
import { YtMusicMixesSection } from "./YtMusicMixesSection";
import { TidalMixesSection } from "./TidalMixesSection";
import { TidalMoodsGenresSection } from "./TidalMoodsGenresSection";
import { TidalFeaturedShelvesSection } from "./TidalFeaturedShelvesSection";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { FeaturedPlaylistsGrid } from "@/features/home/components/FeaturedPlaylistsGrid";
import { FilterPills } from "@/components/ui/FilterPills";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TidalBadge } from "@/components/ui/TidalBadge";
import type { ExploreProviderFailures } from "../hooks/useExploreData";
import type {
    YtMusicCategory,
    YtMusicHomeShelf,
    YtMusicMixPreview,
    PlaylistPreview,
    TidalMixPreview,
    TidalBrowseShelf,
    TidalGenre,
} from "@/hooks/useQueries";

type TabId = "youtube" | "tidal";

interface ProviderTabSectionProps {
    showYtMusicExplore: boolean;
    showTidalExplore: boolean;
    // YouTube Music data
    ytMusicMixes: YtMusicMixPreview[];
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
    providerFailures: ExploreProviderFailures;
}

/** Replaces one failed provider section without escalating the page. */
function ProviderFailureNote({
    title,
    note,
    provider,
}: {
    title: string;
    note: string;
    provider: TabId;
}) {
    return (
        <section>
            <SectionHeader
                title={title}
                badge={
                    provider === "youtube" ? <YouTubeBadge /> : <TidalBadge />
                }
            />
            <p role="status" className="-mt-2 text-sm text-gray-400">
                {note}
            </p>
        </section>
    );
}

/**
 * Renders the YouTube Music tab content.
 */
function YouTubeContent({
    ytMusicMixes,
    moodCategories,
    genreCategories,
    isMoodsLoading,
    homeShelves,
    chartPlaylists,
    providerFailures,
}: Pick<
    ProviderTabSectionProps,
    | "ytMusicMixes"
    | "moodCategories"
    | "genreCategories"
    | "isMoodsLoading"
    | "homeShelves"
    | "chartPlaylists"
    | "providerFailures"
>) {
    const failures = providerFailures.ytMusic;
    return (
        <div className="space-y-8">
            {failures.mixes ? (
                <ProviderFailureNote
                    title="Your Mixes"
                    note="YouTube Music mixes aren't available right now."
                    provider="youtube"
                />
            ) : (
                <YtMusicMixesSection mixes={ytMusicMixes} />
            )}
            {failures.categories ? (
                <ProviderFailureNote
                    title="Moods & Genres"
                    note="YouTube Music moods and genres aren't available right now."
                    provider="youtube"
                />
            ) : (
                <MoodsGenresSection
                    moodCategories={moodCategories}
                    genreCategories={genreCategories}
                    isLoading={isMoodsLoading}
                />
            )}
            {failures.home ? (
                <ProviderFailureNote
                    title="Featured"
                    note="YouTube Music featured shelves aren't available right now."
                    provider="youtube"
                />
            ) : (
                <FeaturedShelvesSection homeShelves={homeShelves} />
            )}
            {failures.charts ? (
                <ProviderFailureNote
                    title="Charts"
                    note="YouTube Music charts aren't available right now."
                    provider="youtube"
                />
            ) : chartPlaylists.length > 0 ? (
                <section>
                    <SectionHeader title="Charts" badge={<YouTubeBadge />} />
                    <FeaturedPlaylistsGrid playlists={chartPlaylists} />
                </section>
            ) : null}
        </div>
    );
}

/** Preserves TIDAL mood/genre order while replacing only failed queries. */
function TidalCategories({
    moods,
    genres,
    failures,
}: {
    moods: TidalGenre[];
    genres: TidalGenre[];
    failures: ExploreProviderFailures["tidal"];
}) {
    if (!failures.moods && !failures.genres) {
        return <TidalMoodsGenresSection genres={genres} moods={moods} />;
    }
    return (
        <>
            {failures.moods ? (
                <ProviderFailureNote
                    title="Moods"
                    note="TIDAL moods aren't available right now."
                    provider="tidal"
                />
            ) : (
                <TidalMoodsGenresSection genres={[]} moods={moods} />
            )}
            {failures.genres ? (
                <ProviderFailureNote
                    title="Genres"
                    note="TIDAL genres aren't available right now."
                    provider="tidal"
                />
            ) : (
                <TidalMoodsGenresSection genres={genres} moods={[]} />
            )}
        </>
    );
}

/** Preserves TIDAL shelf order while replacing only failed queries. */
function TidalShelves({
    homeShelves,
    exploreShelves,
    failures,
}: {
    homeShelves: TidalBrowseShelf[];
    exploreShelves: TidalBrowseShelf[];
    failures: ExploreProviderFailures["tidal"];
}) {
    if (!failures.home && !failures.explore) {
        return (
            <TidalFeaturedShelvesSection
                homeShelves={homeShelves}
                exploreShelves={exploreShelves}
            />
        );
    }
    return (
        <>
            {failures.home ? (
                <ProviderFailureNote
                    title="TIDAL Home"
                    note="TIDAL home shelves aren't available right now."
                    provider="tidal"
                />
            ) : (
                <TidalFeaturedShelvesSection
                    homeShelves={homeShelves}
                    exploreShelves={[]}
                />
            )}
            {failures.explore ? (
                <ProviderFailureNote
                    title="TIDAL Explore"
                    note="TIDAL explore shelves aren't available right now."
                    provider="tidal"
                />
            ) : (
                <TidalFeaturedShelvesSection
                    homeShelves={[]}
                    exploreShelves={exploreShelves}
                />
            )}
        </>
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
    providerFailures,
}: Pick<
    ProviderTabSectionProps,
    | "tidalMixes"
    | "tidalMoods"
    | "tidalGenres"
    | "tidalHomeShelves"
    | "tidalExploreShelves"
    | "providerFailures"
>) {
    const failures = providerFailures.tidal;
    return (
        <div className="space-y-8">
            {failures.mixes ? (
                <ProviderFailureNote
                    title="TIDAL Mixes"
                    note="TIDAL mixes aren't available right now."
                    provider="tidal"
                />
            ) : (
                <TidalMixesSection mixes={tidalMixes} />
            )}
            <TidalCategories
                moods={tidalMoods}
                genres={tidalGenres}
                failures={failures}
            />
            <TidalShelves
                homeShelves={tidalHomeShelves}
                exploreShelves={tidalExploreShelves}
                failures={failures}
            />
        </div>
    );
}

/** Selects one provider's content while keeping tab orchestration small. */
function ProviderContent({
    provider,
    ...props
}: ProviderTabSectionProps & { provider: TabId }) {
    if (provider === "youtube") {
        return (
            <YouTubeContent
                ytMusicMixes={props.ytMusicMixes}
                moodCategories={props.moodCategories}
                genreCategories={props.genreCategories}
                isMoodsLoading={props.isMoodsLoading}
                homeShelves={props.homeShelves}
                chartPlaylists={props.chartPlaylists}
                providerFailures={props.providerFailures}
            />
        );
    }
    return (
        <TidalContent
            tidalMixes={props.tidalMixes}
            tidalMoods={props.tidalMoods}
            tidalGenres={props.tidalGenres}
            tidalHomeShelves={props.tidalHomeShelves}
            tidalExploreShelves={props.tidalExploreShelves}
            providerFailures={props.providerFailures}
        />
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
        return <ProviderContent provider="youtube" {...props} />;
    }

    if (!showYtMusicExplore) {
        return <ProviderContent provider="tidal" {...props} />;
    }

    // Both providers — render tab bar with switching
    return (
        <div>
            <FilterPills
                options={[
                    { value: "youtube", label: "YouTube Music" },
                    { value: "tidal", label: "TIDAL" },
                ]}
                value={activeTab}
                onChange={setActiveTab}
                size="segmented"
                className="mb-6 w-fit"
                aria-label="Explore provider"
            />
            <ProviderContent provider={activeTab} {...props} />
        </div>
    );
}
