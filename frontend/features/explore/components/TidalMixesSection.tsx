/**
 * TIDAL Mixes section for the Explore page.
 *
 * Shows a carousel of personal TIDAL mixes using HorizontalCarousel.
 */

import { SectionHeader } from "@/components/layout/SectionHeader";
import { TidalBadge } from "@/components/ui/TidalBadge";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { api } from "@/lib/api";
import type { TidalMixPreview } from "@/hooks/useQueries";
import { BrowseCard } from "./BrowseCard";

interface TidalMixesSectionProps {
    mixes: TidalMixPreview[];
}

/**
 * Renders a carousel of TIDAL personal mixes.
 */
export function TidalMixesSection({ mixes }: TidalMixesSectionProps) {
    if (mixes.length === 0) return null;

    return (
        <section>
            <SectionHeader title="TIDAL Mixes" badge={<TidalBadge />} />
            <HorizontalCarousel gap="lg">
                {mixes.map((mix) => (
                    <CarouselItem key={mix.mixId}>
                        <BrowseCard
                            href={`/explore/tidal-mix/${encodeURIComponent(mix.mixId)}`}
                            imageUrl={
                                mix.thumbnailUrl
                                    ? api.getTidalBrowseImageUrl(
                                          mix.thumbnailUrl,
                                      )
                                    : null
                            }
                            title={mix.title}
                            subtitle={mix.subTitle}
                        />
                    </CarouselItem>
                ))}
            </HorizontalCarousel>
        </section>
    );
}
