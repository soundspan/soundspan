/**
 * Made For You section for the Explore page.
 *
 * Shows a unified carousel with My Liked, Discover Weekly, and generated mixes.
 */

import { RefreshCw, Heart, Zap } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { MixCard } from "@/components/MixCard";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { StaticPlaylistCard } from "@/features/home/components/StaticPlaylistCard";
import type { Mix } from "@/features/home/types";
import type {
    LikedPlaylistSummary,
    DiscoverWeeklySummary,
} from "@/features/explore/hooks/useExploreData";

interface MadeForYouSectionProps {
    likedSummary: LikedPlaylistSummary | null;
    discoverWeekly: DiscoverWeeklySummary | null;
    mixes: Mix[];
    isRefreshingMixes: boolean;
    handleRefreshMixes: () => Promise<void>;
}

/**
 * Renders the Made For You section content.
 */
export function MadeForYouSection({
    likedSummary,
    discoverWeekly,
    mixes,
    isRefreshingMixes,
    handleRefreshMixes,
}: MadeForYouSectionProps) {
    const hasMadeForYou = likedSummary !== null || discoverWeekly !== null || mixes.length > 0;

    if (!hasMadeForYou) return null;

    return (
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
                            {isRefreshingMixes
                                ? "Refreshing..."
                                : "Refresh"}
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
                                overlayIcon={
                                    <Heart className="w-6 h-6 text-pink-500" strokeWidth={2.5} />
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
                                    <Zap className="w-12 h-12 text-blue-400" />
                                }
                                overlayIcon={
                                    <Zap className="w-6 h-6 text-pink-500" strokeWidth={2.5} />
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
    );
}
