"use client";

import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useExploreData } from "@/features/explore/hooks/useExploreData";
import { useUserSettingsExplorePrefs } from "@/features/explore/hooks/useUserSettingsExplorePrefs";
import { HomeHero } from "@/features/home/components/HomeHero";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { LibraryRadioStations, useLibraryRadioData } from "@/features/home/components/LibraryRadioStations";
import { PopularArtistsGrid } from "@/features/home/components/PopularArtistsGrid";
import { MadeForYouSection } from "@/features/explore/components/MadeForYouSection";
import { MoodPills } from "@/features/explore/components/MoodPills";
import { ProviderTabSection } from "@/features/explore/components/ProviderTabSection";
import { LastFmBadge } from "@/components/ui/LastFmBadge";
import { LibraryBadge } from "@/components/ui/LibraryBadge";
import { mapYtMusicChartsToFeaturedPlaylists } from "@/hooks/useQueries";
import { useTidalExploreEnabled } from "@/features/explore/hooks/useTidalExploreEnabled";

/**
 * Explore page — the unified discovery landing that consolidates
 * Home, Browse, Radio, and Discovery into a single scrollable experience.
 */
export default function ExplorePage() {
    const { showYtMusicExplore } = useUserSettingsExplorePrefs();
    const { showTidalExplore } = useTidalExploreEnabled();

    const {
        likedSummary,
        discoverWeekly,
        mixes,
        recommended,
        homeShelves,
        charts,
        popularArtists,
        moodCategories,
        genreCategories,
        tidalHomeShelves,
        tidalExploreShelves,
        tidalGenres,
        tidalMoods,
        ytMusicMixes,
        tidalMixes,
        isLoading,
        isRefreshingMixes,
        isMoodsLoading,
        handleRefreshMixes,
    } = useExploreData({ showYtMusicExplore, showTidalExplore });

    const {
        quickStartStations,
        genreStations,
        decadeStations,
        isLoading: isRadioLoading,
    } = useLibraryRadioData();

    if (isLoading) {
        return <LoadingScreen />;
    }

    const chartPlaylists = mapYtMusicChartsToFeaturedPlaylists(charts, 20);

    return (
        <div className="relative">
            <HomeHero />

            <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 pb-8">
                {/* Mood Pills — between Hero and content sections */}
                <div className="mb-6">
                    <MoodPills />
                </div>

                <div className="space-y-8">
                    {/* Made For You */}
                    <MadeForYouSection
                        likedSummary={likedSummary}
                        discoverWeekly={discoverWeekly}
                        mixes={mixes}
                        isRefreshingMixes={isRefreshingMixes}
                        handleRefreshMixes={handleRefreshMixes}
                    />

                    {/* Quick Start Radio */}
                    <section>
                        <SectionHeader title="Quick Start" showAllHref="/radio" badge={<LibraryBadge />} />
                        <LibraryRadioStations stations={quickStartStations} externalLoading={isRadioLoading} />
                    </section>

                    {/* Library Genres Radio */}
                    {(genreStations.length > 0 || isRadioLoading) && (
                        <section>
                            <SectionHeader title="Genres" showAllHref="/radio" badge={<LibraryBadge />} />
                            <LibraryRadioStations stations={genreStations} externalLoading={isRadioLoading} />
                        </section>
                    )}

                    {/* Library Decades Radio */}
                    {(decadeStations.length > 0 || isRadioLoading) && (
                        <section>
                            <SectionHeader title="Decades" showAllHref="/radio" badge={<LibraryBadge />} />
                            <LibraryRadioStations stations={decadeStations} externalLoading={isRadioLoading} />
                        </section>
                    )}

                    {/* Provider Content (YouTube Music | TIDAL tabs) */}
                    <ProviderTabSection
                        showYtMusicExplore={showYtMusicExplore}
                        showTidalExplore={showTidalExplore}
                        ytMusicMixes={ytMusicMixes}
                        moodCategories={moodCategories}
                        genreCategories={genreCategories}
                        isMoodsLoading={isMoodsLoading}
                        homeShelves={homeShelves}
                        chartPlaylists={chartPlaylists}
                        tidalMixes={tidalMixes}
                        tidalMoods={tidalMoods}
                        tidalGenres={tidalGenres}
                        tidalHomeShelves={tidalHomeShelves}
                        tidalExploreShelves={tidalExploreShelves}
                    />

                    {/* Popular Artists */}
                    {popularArtists.length > 0 && (
                        <section>
                            <SectionHeader title="Popular Artists" badge={<LastFmBadge />} />
                            <PopularArtistsGrid artists={popularArtists} />
                        </section>
                    )}

                    {/* Recommended For You */}
                    {recommended.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Recommended For You"
                                showAllHref="/discover"
                                badge="Last.fm"
                            />
                            <ArtistsGrid artists={recommended} />
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
}
