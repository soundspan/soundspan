/**
 * TIDAL Featured Shelves section for the Explore page.
 *
 * Shows TIDAL curated home + explore shelves combined.
 */

import { SectionHeader } from "@/features/home/components/SectionHeader";
import { api } from "@/lib/api";
import { TidalBadge } from "@/components/ui/TidalBadge";
import type { TidalBrowseShelf, TidalBrowseShelfItem } from "@/hooks/useQueries";
import { BrowseCard } from "./BrowseCard";

interface TidalFeaturedShelvesSectionProps {
    homeShelves: TidalBrowseShelf[];
    exploreShelves: TidalBrowseShelf[];
}

/**
 * Builds the link href for a TIDAL shelf item based on available IDs.
 */
function getItemHref(item: TidalBrowseShelfItem): string | null {
    if (item.playlistId) {
        return `/explore/tidal-playlist/${encodeURIComponent(item.playlistId)}`;
    }
    if (item.mixId) {
        return `/explore/tidal-mix/${encodeURIComponent(item.mixId)}`;
    }
    return null;
}

/**
 * Returns a stable key for a shelf item.
 */
function getItemKey(item: TidalBrowseShelfItem, index: number): string {
    return item.playlistId ?? item.mixId ?? item.albumId ?? String(index);
}

/**
 * Renders the TIDAL Featured Shelves section content.
 */
export function TidalFeaturedShelvesSection({
    homeShelves,
    exploreShelves,
}: TidalFeaturedShelvesSectionProps) {
    const HIDDEN_SHELVES = ["shortcuts"];

    const allShelves = [...homeShelves, ...exploreShelves].filter(
        (s) => s.contents && s.contents.length > 0 && !HIDDEN_SHELVES.includes((s.title ?? "").trim().toLowerCase())
    );

    if (allShelves.length === 0) return null;

    return (
        <>
            {allShelves.map((shelf, idx) => (
                <section key={shelf.title ?? idx}>
                    <SectionHeader
                        title={shelf.title ?? "Featured"}
                        badge={<TidalBadge />}
                    />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                        {shelf.contents?.slice(0, 12).map((item, i) => (
                            <BrowseCard
                                key={getItemKey(item, i)}
                                href={getItemHref(item)}
                                imageUrl={item.thumbnailUrl ? api.getTidalBrowseImageUrl(item.thumbnailUrl) : null}
                                title={item.title ?? ""}
                                subtitle={item.subtitle}
                            />
                        ))}
                    </div>
                </section>
            ))}
        </>
    );
}
