/**
 * TIDAL Mixes section for the Explore page.
 *
 * Shows a carousel of personal TIDAL mixes using HorizontalCarousel.
 */

import Link from "next/link";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { api } from "@/lib/api";
import type { TidalMixPreview } from "@/hooks/useQueries";

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
                        <Link
                            href={`/explore/tidal-mix/${encodeURIComponent(mix.mixId)}`}
                            className="group"
                        >
                            <div className="aspect-square rounded-md bg-white/5 overflow-hidden mb-2">
                                {mix.thumbnailUrl && (
                                    <img
                                        src={api.getTidalBrowseImageUrl(mix.thumbnailUrl)}
                                        alt={mix.title}
                                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                    />
                                )}
                            </div>
                            <p className="text-sm text-white truncate">{mix.title}</p>
                            {mix.subTitle && (
                                <p className="text-xs text-gray-400 truncate">{mix.subTitle}</p>
                            )}
                        </Link>
                    </CarouselItem>
                ))}
            </HorizontalCarousel>
        </section>
    );
}
