/**
 * YouTube Music personalized mixes section for the Explore page.
 *
 * Shows a carousel of personal YT Music mixes using HorizontalCarousel.
 * Only renders when the user has YT Music OAuth and mixes are available.
 *
 * TODO(#813): Currently dormant. The sidecar's get_library_playlists() fails
 * due to ytmusicapi #813 (OAuth + WEB_REMIX → HTTP 400). The backend route
 * gracefully returns an empty array on 401, so this section simply doesn't
 * render. Revisit when ytmusicapi resolves #813.
 */

import { SectionHeader } from "@/components/layout/SectionHeader";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { api } from "@/lib/api";
import type { YtMusicMixPreview } from "@/hooks/useQueries";
import { BrowseCard } from "./BrowseCard";

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
                    const thumbnail =
                        mix.thumbnails?.find((t) => t.width >= 200) ??
                        mix.thumbnails?.[0];
                    return (
                        <CarouselItem key={mix.playlistId}>
                            <BrowseCard
                                href={`/explore/yt-playlist/${encodeURIComponent(mix.playlistId)}`}
                                imageUrl={
                                    thumbnail?.url
                                        ? api.getBrowseImageUrl(thumbnail.url)
                                        : null
                                }
                                title={mix.title}
                                subtitle={mix.description}
                            />
                        </CarouselItem>
                    );
                })}
            </HorizontalCarousel>
        </section>
    );
}
