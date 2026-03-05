/**
 * YouTube Music personalized mixes section for the Explore page.
 *
 * Shows a carousel of personal YT Music mixes using HorizontalCarousel.
 * Only renders when the user has YT Music OAuth and mixes are available.
 */

import Link from "next/link";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { api } from "@/lib/api";
import type { YtMusicMixPreview } from "@/hooks/useQueries";

interface YtMusicMixesSectionProps {
    mixes: YtMusicMixPreview[];
}

/**
 * Renders a carousel of YT Music personalized mixes.
 */
export function YtMusicMixesSection({ mixes }: YtMusicMixesSectionProps) {
    if (mixes.length === 0) return null;

    return (
        <section>
            <SectionHeader title="Your Mixes" badge={<YouTubeBadge />} />
            <HorizontalCarousel gap="lg">
                {mixes.map((mix) => {
                    const thumbnail = mix.thumbnails?.find((t) => t.width >= 200)
                        ?? mix.thumbnails?.[0];
                    return (
                        <CarouselItem key={mix.playlistId}>
                            <Link
                                href={`/explore/yt-playlist/${encodeURIComponent(mix.playlistId)}`}
                                className="group"
                            >
                                <div className="aspect-square rounded-md bg-white/5 overflow-hidden mb-2">
                                    {thumbnail?.url && (
                                        <img
                                            src={api.getBrowseImageUrl(thumbnail.url)}
                                            alt={mix.title}
                                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                        />
                                    )}
                                </div>
                                <p className="text-sm text-white truncate">{mix.title}</p>
                                {mix.description && (
                                    <p className="text-xs text-gray-400 truncate">{mix.description}</p>
                                )}
                            </Link>
                        </CarouselItem>
                    );
                })}
            </HorizontalCarousel>
        </section>
    );
}
