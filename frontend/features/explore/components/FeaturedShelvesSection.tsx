/**
 * Featured Shelves section for the Explore page.
 *
 * Shows YT Music curated featured shelves.
 */

import { SectionHeader } from "@/features/home/components/SectionHeader";
import { api } from "@/lib/api";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import type { YtMusicHomeShelf } from "@/hooks/useQueries";
import { BrowseCard } from "./BrowseCard";

interface FeaturedShelvesSectionProps {
    homeShelves: YtMusicHomeShelf[];
}

/**
 * Renders the Featured Shelves section content.
 */
export function FeaturedShelvesSection({
    homeShelves,
}: FeaturedShelvesSectionProps) {
    // Exclude shelves where no items are navigable (video-only / artist-only shelves)
    const visibleShelves = homeShelves.filter((shelf) =>
        shelf.contents?.some(
            (item) => item.playlistId || (item.browseId && item.type === "album")
        )
    );

    if (visibleShelves.length === 0) return null;

    return (
        <>
            {visibleShelves.map((shelf, idx) => (
                <section key={shelf.title ?? idx}>
                    <SectionHeader
                        title={shelf.title ?? "Featured"}
                        badge={<YouTubeBadge />}
                    />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                        {shelf.contents?.slice(0, 12).map((item, i) => {
                            const href = item.playlistId
                                ? `/explore/yt-playlist/${encodeURIComponent(item.playlistId)}`
                                : item.browseId && item.type === "album"
                                  ? `/explore/yt-playlist/${encodeURIComponent(item.browseId)}?type=album`
                                  : null;
                            return (
                                <BrowseCard
                                    key={item.playlistId ?? item.browseId ?? item.videoId ?? i}
                                    href={href}
                                    imageUrl={item.thumbnailUrl ? api.getBrowseImageUrl(item.thumbnailUrl) : null}
                                    title={item.title ?? ""}
                                    subtitle={item.subtitle}
                                />
                            );
                        })}
                    </div>
                </section>
            ))}
        </>
    );
}
