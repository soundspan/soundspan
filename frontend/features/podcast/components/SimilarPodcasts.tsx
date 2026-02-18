"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { Mic2 } from "lucide-react";
import { SimilarPodcast } from "../types";
import { api } from "@/lib/api";

interface SimilarPodcastsProps {
    podcasts: SimilarPodcast[];
}

// Always proxy images through the backend for caching and mobile compatibility
const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

export function SimilarPodcasts({ podcasts }: SimilarPodcastsProps) {
    const router = useRouter();

    if (!podcasts || podcasts.length === 0) {
        return null;
    }

    return (
        <section>
            <h2 className="text-xl font-bold mb-4">Fans Also Like</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {podcasts.map((podcast) => {
                    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
                    return (
                        <div
                            key={podcast.id}
                            className="bg-transparent hover:bg-white/5 transition-all p-3 rounded-md cursor-pointer group"
                            onClick={() =>
                                router.push(`/podcasts/${podcast.id}`)
                            }
                        >
                            <div className="w-full aspect-square bg-[#282828] rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                {imageUrl ? (
                                    <Image
                                        src={imageUrl}
                                        alt={podcast.title}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                        className="object-cover group-hover:scale-105 transition-transform"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Mic2 className="w-10 h-10 text-gray-600" />
                                    </div>
                                )}
                            </div>
                            <h3 className="font-semibold text-white truncate text-sm mb-0.5">
                                {podcast.title}
                            </h3>
                            <p className="text-xs text-white/50 truncate">
                                {podcast.author}
                            </p>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
