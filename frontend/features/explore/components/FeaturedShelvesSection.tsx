/**
 * Featured Shelves section for the Explore page.
 *
 * Shows YT Music curated featured shelves.
 */

import Link from "next/link";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { api } from "@/lib/api";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import type { YtMusicHomeShelf } from "@/hooks/useQueries";

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
                            const inner = (
                                <>
                                    <div className="aspect-square rounded-md bg-white/5 overflow-hidden mb-2">
                                        {item.thumbnailUrl && (
                                            <img
                                                src={api.getBrowseImageUrl(item.thumbnailUrl)}
                                                alt={item.title ?? ""}
                                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                            />
                                        )}
                                    </div>
                                    <p className="text-sm text-white truncate">
                                        {item.title}
                                    </p>
                                    {item.subtitle && (
                                        <p className="text-xs text-gray-400 truncate">
                                            {item.subtitle}
                                        </p>
                                    )}
                                </>
                            );
                            return href ? (
                                <Link
                                    key={item.playlistId ?? item.browseId ?? item.videoId ?? i}
                                    href={href}
                                    className="group cursor-pointer"
                                >
                                    {inner}
                                </Link>
                            ) : (
                                <div
                                    key={item.playlistId ?? item.browseId ?? item.videoId ?? i}
                                    className="group"
                                >
                                    {inner}
                                </div>
                            );
                        })}
                    </div>
                </section>
            ))}
        </>
    );
}
