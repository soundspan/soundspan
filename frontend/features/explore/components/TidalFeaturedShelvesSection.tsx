/**
 * TIDAL Featured Shelves section for the Explore page.
 *
 * Shows TIDAL curated home + explore shelves combined.
 */

import Link from "next/link";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { api } from "@/lib/api";
import { TidalBadge } from "@/components/ui/TidalBadge";
import type { TidalBrowseShelf, TidalBrowseShelfItem } from "@/hooks/useQueries";

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
                        {shelf.contents?.slice(0, 12).map((item, i) => {
                            const href = getItemHref(item);
                            const inner = (
                                <>
                                    <div className="aspect-square rounded-md bg-white/5 overflow-hidden mb-2">
                                        {item.thumbnailUrl && (
                                            <img
                                                src={api.getTidalBrowseImageUrl(item.thumbnailUrl)}
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
                                    key={getItemKey(item, i)}
                                    href={href}
                                    className="group cursor-pointer"
                                >
                                    {inner}
                                </Link>
                            ) : (
                                <div
                                    key={getItemKey(item, i)}
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
