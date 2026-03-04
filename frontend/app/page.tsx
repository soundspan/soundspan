"use client";

import { Heart, Compass, RefreshCw } from "lucide-react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { MixCard } from "@/components/MixCard";
import { HomeHero } from "@/features/home/components/HomeHero";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { ContinueListening } from "@/features/home/components/ContinueListening";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { PopularArtistsGrid } from "@/features/home/components/PopularArtistsGrid";
import { FeaturedPlaylistsGrid } from "@/features/home/components/FeaturedPlaylistsGrid";
import { PodcastsGrid } from "@/features/home/components/PodcastsGrid";
import { AudiobooksGrid } from "@/features/home/components/AudiobooksGrid";
import { StaticPlaylistCard } from "@/features/home/components/StaticPlaylistCard";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { LastFmBadge } from "@/components/ui/LastFmBadge";
import { useHomeData } from "@/features/home/hooks/useHomeData";

// Loading skeleton for playlist cards
function PlaylistSkeleton() {
    return (
        <div className="flex gap-3 overflow-hidden">
            {[...Array(8)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px] p-3">
                    <div className="aspect-square rounded-md bg-white/5 animate-pulse mb-3" />
                    <div className="h-4 bg-white/5 rounded animate-pulse w-3/4 mb-2" />
                    <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                </div>
            ))}
        </div>
    );
}

/**
 * Home page — library-focused landing with Made For You and trending
 * community playlists. The Explore page (/explore) serves as the
 * separate discovery tab with full trending/moods browsing.
 */
export default function HomePage() {
    const {
        recentlyListened,
        recentlyAdded,
        recommended,
        mixes,
        likedSummary,
        discoverWeekly,
        popularArtists,
        communityPlaylists,
        recentPodcasts,
        recentAudiobooks,
        isLoading,
        isRefreshingMixes,
        isCommunityPlaylistsLoading,
        handleRefreshMixes,
    } = useHomeData();

    if (isLoading) {
        return <LoadingScreen />;
    }

    const hasMadeForYou = likedSummary !== null || discoverWeekly !== null || mixes.length > 0;

    return (
        <div className="relative">
            <HomeHero />

            <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 pb-8">
                <div className="space-y-8">
                    {/* Continue Listening */}
                    {recentlyListened.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Continue Listening"
                                showAllHref="/library?tab=artists"
                            />
                            <ContinueListening items={recentlyListened} />
                        </section>
                    )}

                    {/* Recently Added */}
                    {recentlyAdded.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Recently Added"
                                showAllHref="/library?tab=artists"
                            />
                            <ArtistsGrid artists={recentlyAdded} />
                        </section>
                    )}

                    {/* Made For You */}
                    {hasMadeForYou && (
                        <section>
                            <SectionHeader
                                title="Made For You"
                                rightAction={
                                    <button
                                        onClick={handleRefreshMixes}
                                        disabled={isRefreshingMixes}
                                        className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors font-semibold group bg-white/5 hover:bg-white/10 rounded-full disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isRefreshingMixes ? (
                                            <GradientSpinner size="sm" />
                                        ) : (
                                            <RefreshCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" />
                                        )}
                                        <span className="hidden sm:inline">
                                            {isRefreshingMixes ? "Refreshing..." : "Refresh"}
                                        </span>
                                    </button>
                                }
                            />
                            <HorizontalCarousel>
                                {likedSummary && (
                                    <CarouselItem key="my-liked">
                                        <StaticPlaylistCard
                                            href="/playlist/my-liked"
                                            coverUrl={likedSummary.coverUrl}
                                            title="My Liked"
                                            subtitle={`${likedSummary.total} tracks`}
                                            placeholderIcon={
                                                <Heart className="w-12 h-12 text-pink-500 fill-pink-500" />
                                            }
                                            index={0}
                                        />
                                    </CarouselItem>
                                )}
                                {discoverWeekly && (
                                    <CarouselItem key="discover-weekly">
                                        <StaticPlaylistCard
                                            href="/discover"
                                            coverUrl={discoverWeekly.coverUrl}
                                            title="Discover Weekly"
                                            subtitle={`${discoverWeekly.totalCount} tracks`}
                                            placeholderIcon={
                                                <Compass className="w-12 h-12 text-blue-400" />
                                            }
                                            index={1}
                                        />
                                    </CarouselItem>
                                )}
                                {mixes.map((mix, index) => (
                                    <CarouselItem key={mix.id}>
                                        <MixCard mix={mix} index={index + 2} />
                                    </CarouselItem>
                                ))}
                            </HorizontalCarousel>
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

                    {/* Popular Artists */}
                    {popularArtists.length > 0 && (
                        <section>
                            <SectionHeader title="Popular Artists" badge={<LastFmBadge />} />
                            <PopularArtistsGrid artists={popularArtists} />
                        </section>
                    )}

                    {/* Trending Community Playlists */}
                    {(isCommunityPlaylistsLoading || communityPlaylists.length > 0) && (
                        <section>
                            <SectionHeader
                                title="Trending Community Playlists"
                                badge={<YouTubeBadge />}
                            />
                            {isCommunityPlaylistsLoading && communityPlaylists.length === 0 ? (
                                <PlaylistSkeleton />
                            ) : (
                                <FeaturedPlaylistsGrid playlists={communityPlaylists} />
                            )}
                        </section>
                    )}

                    {/* Popular Podcasts */}
                    {recentPodcasts.length > 0 && (
                        <section>
                            <SectionHeader title="Popular Podcasts" showAllHref="/podcasts" />
                            <PodcastsGrid podcasts={recentPodcasts} />
                        </section>
                    )}

                    {/* Audiobooks */}
                    {recentAudiobooks.length > 0 && (
                        <section>
                            <SectionHeader title="Audiobooks" showAllHref="/audiobooks" />
                            <AudiobooksGrid audiobooks={recentAudiobooks} />
                        </section>
                    )}
                </div>
            </div>

        </div>
    );
}
