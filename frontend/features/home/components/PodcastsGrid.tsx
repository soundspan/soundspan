"use client";

import Link from "next/link";
import Image from "next/image";
import { Disc } from "lucide-react";
import { Podcast } from "../types";
import { memo } from "react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";

interface PodcastsGridProps {
    podcasts: Podcast[];
}

interface PodcastCardProps {
    podcast: Podcast;
    index: number;
}

// Always proxy images through the backend for caching and mobile compatibility
const getProxiedImageUrl = (podcast: Podcast): string | null => {
    const imageUrl = podcast.coverUrl || podcast.coverArt || podcast.imageUrl;
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

const PodcastCard = memo(
    function PodcastCard({ podcast, index }: PodcastCardProps) {
        const imageUrl = getProxiedImageUrl(podcast);

        return (
            <CarouselItem>
                <Link
                    href={`/podcasts/${podcast.id}`}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                >
                    <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                        <div className="aspect-square bg-[#282828] rounded-full mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                            {imageUrl ? (
                                <Image
                                    src={imageUrl}
                                    alt={podcast.title}
                                    fill
                                    sizes="180px"
                                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                                    unoptimized
                                />
                            ) : (
                                <Disc className="w-10 h-10 text-gray-600" />
                            )}
                        </div>
                        <h3 className="text-sm font-semibold text-white truncate">
                            {podcast.title}
                        </h3>
                        <p className="text-xs text-gray-400 truncate mt-0.5">
                            {podcast.author || "Podcast"}
                        </p>
                    </div>
                </Link>
            </CarouselItem>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.podcast.id === nextProps.podcast.id && prevProps.index === nextProps.index;
    }
);

const PodcastsGrid = memo(function PodcastsGrid({
    podcasts,
}: PodcastsGridProps) {
    return (
        <HorizontalCarousel>
            {podcasts.map((podcast, index) => (
                <PodcastCard key={podcast.id} podcast={podcast} index={index} />
            ))}
        </HorizontalCarousel>
    );
});

export { PodcastsGrid };
