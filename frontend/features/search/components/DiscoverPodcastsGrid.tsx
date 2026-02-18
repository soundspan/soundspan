import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";

interface DiscoverPodcastsGridProps {
    podcasts: DiscoverResult[];
    limit?: number | null;
}

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 200);
};

export function DiscoverPodcastsGrid({
    podcasts,
    limit = 6,
}: DiscoverPodcastsGridProps) {
    const items = limit ? podcasts.slice(0, limit) : podcasts;

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-4" data-tv-section="search-results-discover-podcasts">
            {items.map((podcast, index) => {
                const podcastId = podcast.id ? String(podcast.id) : "";
                const imageUrl = getProxiedImageUrl(
                    podcast.coverUrl || podcast.image
                );
                if (!podcastId) return null;

                return (
                    <Link
                        key={`${podcastId}-${index}`}
                        href={`/podcasts/${podcastId}`}
                        data-tv-card
                        data-tv-card-index={index}
                        tabIndex={0}
                    >
                        <div className="bg-[#121212] hover:bg-[#181818] transition-all p-4 rounded-lg group cursor-pointer">
                            <div className="aspect-square bg-[#181818] rounded-md mb-4 flex items-center justify-center overflow-hidden relative">
                                {imageUrl ? (
                                    <Image
                                        src={imageUrl}
                                        alt={podcast.name}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                        className="object-cover"
                                        loading="lazy"
                                        unoptimized
                                    />
                                ) : (
                                    <Music className="w-12 h-12 text-gray-600" />
                                )}
                            </div>
                            <h3 className="text-base font-bold text-white line-clamp-1 mb-1">
                                {podcast.name}
                            </h3>
                            <p className="text-sm text-[#b3b3b3] line-clamp-1">
                                {podcast.artist || "Podcast"}
                            </p>
                            {typeof podcast.trackCount === "number" &&
                                podcast.trackCount > 0 && (
                                    <p className="text-xs text-gray-500 mt-1">
                                        {podcast.trackCount} episodes
                                    </p>
                                )}
                        </div>
                    </Link>
                );
            })}
        </div>
    );
}
