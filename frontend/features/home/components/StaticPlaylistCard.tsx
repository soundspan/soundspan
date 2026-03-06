/**
 * Shared static playlist card matching MixCard visual style.
 *
 * Used by MadeForYouSection (explore) and the Home page "Made For You" row for
 * items like My Liked and Discover Weekly that are not generated mixes.
 */

import { memo, type ReactNode } from "react";
import Link from "next/link";
import { CachedImage } from "@/components/ui/CachedImage";

export interface StaticPlaylistCardProps {
    href: string;
    coverUrl: string | null;
    title: string;
    subtitle: string;
    placeholderIcon: ReactNode;
    /** Optional icon rendered in the bottom-right corner of the cover art. */
    overlayIcon?: ReactNode;
    index?: number;
}

/**
 * Renders a static playlist card matching MixCard visual style.
 */
export const StaticPlaylistCard = memo(function StaticPlaylistCard({
    href,
    coverUrl,
    title,
    subtitle,
    placeholderIcon,
    overlayIcon,
    index,
}: StaticPlaylistCardProps) {
    return (
        <Link href={href} data-tv-card data-tv-card-index={index} tabIndex={0}>
            <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                <div className="aspect-square bg-[#282828] rounded-lg mb-3 overflow-hidden relative shadow-lg">
                    {coverUrl ? (
                        <CachedImage
                            src={coverUrl}
                            alt={title}
                            fill
                            className="object-cover group-hover:scale-105 transition-transform duration-300"
                            sizes="180px"
                        />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                            {placeholderIcon}
                        </div>
                    )}
                    {overlayIcon && (
                        <div className="absolute bottom-1.5 right-1.5 drop-shadow-lg">
                            {overlayIcon}
                        </div>
                    )}
                </div>
                <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
                <p className="text-xs text-gray-400 line-clamp-2 mt-0.5">{subtitle}</p>
            </div>
        </Link>
    );
});
