"use client";

import { Music2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo, useCallback } from "react";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import type { PlaylistPreview } from "@/hooks/useQueries";

export type { PlaylistPreview };

interface FeaturedPlaylistsGridProps {
    playlists: PlaylistPreview[];
}

interface PlaylistCardProps {
    playlist: PlaylistPreview;
    index: number;
    onClick: (playlistId: string) => void;
}

const PlaylistCard = memo(function PlaylistCard({
    playlist,
    index,
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
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors"
            >
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    {playlist.imageUrl ? (
                        <img
                            src={playlist.imageUrl}
                            alt={playlist.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
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
                </div>
                <h3 className="text-sm font-semibold text-white truncate">
                    {playlist.title}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                    {playlist.trackCount != null
                        ? `${playlist.trackCount} songs`
                        : playlist.description ?? ""}
                </p>
            </div>
        </CarouselItem>
    );
});

/**
 * Renders a horizontal carousel of playlist preview cards.
 */
export const FeaturedPlaylistsGrid = memo(function FeaturedPlaylistsGrid({
    playlists
}: FeaturedPlaylistsGridProps) {
    const router = useRouter();

    const handlePlaylistClick = useCallback((playlistId: string) => {
        router.push(`/explore/yt-playlist/${playlistId}`);
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
                    index={index}
                    onClick={handlePlaylistClick}
                />
            ))}
        </HorizontalCarousel>
    );
});
