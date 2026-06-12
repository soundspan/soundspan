"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { memo, useMemo } from "react";
import { CoverMosaic } from "@/components/ui/CoverMosaic";

interface MixCardProps {
    mix: {
        id: string;
        name: string;
        description: string;
        coverUrls: string[];
        trackCount: number;
    };
    index?: number;
}

const MixCard = memo(
    function MixCard({ mix, index }: MixCardProps) {
        const proxiedUrls = useMemo(
            () => mix.coverUrls.slice(0, 4).map((url) => api.getCoverArtUrl(url, 300)),
            [mix.coverUrls],
        );

        return (
            <Link
                href={`/mix/${mix.id}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    {/* Mosaic cover art */}
                    <div className="aspect-square bg-[#282828] rounded-lg mb-3 overflow-hidden relative shadow-lg">
                        <CoverMosaic
                            coverUrls={proxiedUrls}
                            hoverScale
                            imageSizes="180px"
                            showEmptyCellIcon
                        />
                    </div>

                    <h3 className="text-sm font-semibold text-white truncate">
                        {mix.name}
                    </h3>
                    <p className="text-xs text-gray-400 line-clamp-2 mt-0.5">
                        {mix.description}
                    </p>
                </div>
            </Link>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.mix.id === nextProps.mix.id &&
            prevProps.mix.name === nextProps.mix.name &&
            prevProps.mix.description === nextProps.mix.description &&
            prevProps.mix.trackCount === nextProps.mix.trackCount &&
            prevProps.mix.coverUrls.length === nextProps.mix.coverUrls.length &&
            prevProps.mix.coverUrls.every(
                (url, i) => url === nextProps.mix.coverUrls[i]
            )
        );
    }
);

export { MixCard };
