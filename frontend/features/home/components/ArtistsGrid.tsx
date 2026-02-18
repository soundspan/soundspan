"use client";

import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { memo } from "react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { getArtistHref } from "@/utils/artistRoute";

interface Artist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string;
    albumCount?: number;
}

interface ArtistsGridProps {
    artists: Artist[];
}

// Helper to get the correct image source
const getArtistImageSrc = (coverArt: string | undefined) => {
    if (!coverArt) {
        return null;
    }
    return api.getCoverArtUrl(coverArt, 300);
};

interface ArtistCardProps {
    artist: Artist;
    index: number;
}

const ArtistCard = memo(
    function ArtistCard({ artist, index }: ArtistCardProps) {
        const imageSrc = getArtistImageSrc(artist.coverArt);
        const artistHref =
            getArtistHref({
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
            }) || "/artist";

        return (
            <CarouselItem>
                <Link
                    href={artistHref}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                >
                    <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                        <div className="aspect-square bg-[#282828] rounded-full mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                            {artist.coverArt && imageSrc ? (
                                <Image
                                    src={imageSrc}
                                    alt={artist.name}
                                    fill
                                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                                    sizes="180px"
                                    priority={false}
                                    unoptimized
                                />
                            ) : (
                                <Music className="w-10 h-10 text-gray-600" />
                            )}
                        </div>
                        <h3 className="text-sm font-semibold text-white truncate">
                            {artist.name}
                        </h3>
                        <p className="text-xs text-gray-400 mt-0.5">Artist</p>
                    </div>
                </Link>
            </CarouselItem>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.artist.id === nextProps.artist.id && prevProps.index === nextProps.index;
    }
);

const ArtistsGrid = memo(function ArtistsGrid({ artists }: ArtistsGridProps) {
    return (
        <HorizontalCarousel>
            {artists.map((artist, index) => (
                <ArtistCard key={artist.id} artist={artist} index={index} />
            ))}
        </HorizontalCarousel>
    );
});

export { ArtistsGrid, getArtistImageSrc };
