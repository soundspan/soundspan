"use client";

import Link from "next/link";

/** Normalized data for one Explore browse card (thumbnail + title + optional subtitle). */
export interface BrowseCardProps {
    href: string | null;
    imageUrl: string | null;
    title: string;
    subtitle?: string | null;
}

/** Renders a square-thumbnail browse card, linked when href is provided. */
export function BrowseCard({ href, imageUrl, title, subtitle }: BrowseCardProps) {
    const inner = (
        <>
            <div className="aspect-square rounded-md bg-white/5 overflow-hidden mb-2">
                {imageUrl && (
                    <img
                        src={imageUrl}
                        alt={title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                )}
            </div>
            <p className="text-sm text-white truncate">{title}</p>
            {subtitle && <p className="text-xs text-gray-400 truncate">{subtitle}</p>}
        </>
    );
    if (href) {
        return <Link href={href} className="group cursor-pointer">{inner}</Link>;
    }
    return <div className="group">{inner}</div>;
}
