"use client";

import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { memo } from "react";

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
        return (
            <Link
                href={`/mix/${mix.id}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    {/* Circular mosaic cover art */}
                    <div className="aspect-square bg-[#282828] rounded-full mb-3 overflow-hidden relative shadow-lg">
                        {mix.coverUrls.length > 0 ? (
                            <div className="grid grid-cols-2 gap-0 w-full h-full">
                                {mix.coverUrls.slice(0, 4).map((url, idx) => {
                                    const proxiedUrl = api.getCoverArtUrl(
                                        url,
                                        300
                                    );
                                    return (
                                        <div
                                            key={idx}
                                            className="relative bg-[#282828]"
                                        >
                                            <Image
                                                src={proxiedUrl}
                                                alt=""
                                                fill
                                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                                sizes="180px"
                                                unoptimized
                                            />
                                        </div>
                                    );
                                })}
                                {/* Fill remaining cells if less than 4 covers */}
                                {Array.from({
                                    length: Math.max(
                                        0,
                                        4 - mix.coverUrls.length
                                    ),
                                }).map((_, idx) => (
                                    <div
                                        key={`empty-${idx}`}
                                        className="relative bg-[#282828] flex items-center justify-center"
                                    >
                                        <Music className="w-6 h-6 text-gray-600" />
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-10 h-10 text-gray-600" />
                            </div>
                        )}
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
        // Compare id, name, description, trackCount, and coverUrls to detect content changes
        // This ensures the card re-renders when mood mix content changes even if ID is the same
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
