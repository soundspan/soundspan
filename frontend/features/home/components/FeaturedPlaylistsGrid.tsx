"use client";

import { Music2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo, useCallback } from "react";
import Image from "next/image";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";

interface PlaylistPreview {
    id: string;
    source: string;
    type: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

interface FeaturedPlaylistsGridProps {
    playlists: PlaylistPreview[];
}

// Deezer icon
const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

interface PlaylistCardProps {
    playlist: PlaylistPreview;
    onClick: (playlistId: string) => void;
}

const PlaylistCard = memo(function PlaylistCard({ 
    playlist, 
    onClick 
}: PlaylistCardProps) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();

    const handleClick = () => {
        triggerPlayFeedback();
        onClick(playlist.id);
    };

    return (
        <CarouselItem>
            <div
                onClick={handleClick}
                className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors"
            >
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    {playlist.imageUrl ? (
                        <Image
                            src={playlist.imageUrl}
                            alt={playlist.title}
                            fill
                            className="object-cover group-hover:scale-105 transition-transform duration-300"
                            unoptimized
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#AD47FF]/30 to-[#AD47FF]/10">
                            <Music2 className="w-10 h-10 text-gray-600" />
                        </div>
                    )}
                    {/* Play button on hover */}
                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-200">
                        <div className="w-10 h-10 rounded-full bg-[#60a5fa] flex items-center justify-center shadow-xl hover:scale-105 transition-transform">
                            {showSpinner ? (
                                <Loader2 className="w-4 h-4 text-black animate-spin" />
                            ) : (
                                <svg viewBox="0 0 24 24" className="w-4 h-4 text-black ml-0.5" fill="currentColor">
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            )}
                        </div>
                    </div>
                    {/* Deezer badge */}
                    <div className="absolute top-2 left-2">
                        <DeezerIcon className="w-4 h-4 text-[#AD47FF] drop-shadow-lg" />
                    </div>
                </div>
                <h3 className="text-sm font-semibold text-white truncate">
                    {playlist.title}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                    {playlist.trackCount} songs
                </p>
            </div>
        </CarouselItem>
    );
});

export const FeaturedPlaylistsGrid = memo(function FeaturedPlaylistsGrid({
    playlists
}: FeaturedPlaylistsGridProps) {
    const router = useRouter();

    const handlePlaylistClick = useCallback((playlistId: string) => {
        router.push(`/browse/playlists/${playlistId}`);
    }, [router]);

    if (!playlists || playlists.length === 0) {
        return null;
    }

    return (
        <HorizontalCarousel>
            {playlists.slice(0, 20).map((playlist, index) => (
                <PlaylistCard
                    key={`home-playlist-${playlist.id}-${index}`}
                    playlist={playlist}
                    onClick={handlePlaylistClick}
                />
            ))}
        </HorizontalCarousel>
    );
});
