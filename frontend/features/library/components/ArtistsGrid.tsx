import React, { memo, useCallback, useMemo } from "react";
import Link from "next/link";
import { Music, Play, Trash2, Loader2 } from "lucide-react";
import { Artist } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { getArtistHref } from "@/utils/artistRoute";

interface ArtistsGridProps {
    artists: Artist[];
    onPlay: (artistId: string) => Promise<void>;
    onDelete: (artistId: string, artistName: string) => void;
    canDelete?: boolean;
    isLoading?: boolean;
    hidePlayButtons?: boolean;
}

const getArtistImageSrc = (coverArt?: string): string | null => {
    if (!coverArt) return null;
    return api.getCoverArtUrl(coverArt, 200);
};

interface ArtistCardItemProps {
    artist: Artist;
    index: number;
    onPlay: (artistId: string) => Promise<void>;
    onDelete: (artistId: string, artistName: string) => void;
    canDelete: boolean;
    hidePlayButtons: boolean;
}

const ArtistCardItem = memo(
    function ArtistCardItem({
        artist,
        index,
        onPlay,
        onDelete,
        canDelete,
        hidePlayButtons,
    }: ArtistCardItemProps) {
        const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
            usePlayButtonFeedback();

        const handlePlay = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                triggerPlayFeedback();
                onPlay(artist.id);
            },
            [artist.id, onPlay, triggerPlayFeedback],
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(artist.id, artist.name);
            },
            [artist.id, artist.name, onDelete],
        );

        const coverArtUrl = useMemo(
            () => getArtistImageSrc(artist.coverArt),
            [artist.coverArt],
        );
        const artistHref =
            getArtistHref({
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
            }) || "/artist";

        return (
            <Link
                href={artistHref}
                prefetch={false}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="group"
            >
                <div className="p-3 rounded-md cursor-pointer hover:bg-white/5 transition-colors" style={{ transform: "translateZ(0)" }}>
                    <div className="relative aspect-square mb-3">
                        <div className="w-full h-full bg-[#282828] rounded-full flex items-center justify-center overflow-hidden" style={{ contain: "content" }}>
                            {coverArtUrl ? (
                                <CachedImage
                                    src={coverArtUrl}
                                    alt={artist.name}
                                    fill
                                    className="object-cover group-hover:scale-105 transition-transform"
                                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                                />
                            ) : (
                                <Music className="w-10 h-10 text-gray-600" />
                            )}
                        </div>
                        {/* Play button */}
                        {!hidePlayButtons && (
                            <button
                                onClick={handlePlay}
                                className="absolute bottom-1 right-1 w-10 h-10 rounded-full bg-[#60a5fa] flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                {showPlaySpinner ? (
                                    <Loader2 className="w-4 h-4 animate-spin text-black" />
                                ) : (
                                    <Play className="w-4 h-4 fill-current ml-0.5 text-black" />
                                )}
                            </button>
                        )}
                        {/* Delete button */}
                        {canDelete && (
                            <button
                                onClick={handleDelete}
                                className="absolute top-1 right-1 w-7 h-7 rounded-full bg-black/60 hidden md:flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-opacity"
                                title="Delete artist"
                            >
                                <Trash2 className="w-3.5 h-3.5 text-white" />
                            </button>
                        )}
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {artist.name}
                    </h3>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {artist.albumCount || 0} albums
                    </p>
                </div>
            </Link>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.artist.id === nextProps.artist.id;
    },
);

const ArtistsGrid = memo(function ArtistsGrid({
    artists,
    onPlay,
    onDelete,
    canDelete = false,
    isLoading = false,
    hidePlayButtons = false,
}: ArtistsGridProps) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (artists.length === 0) {
        return (
            <EmptyState
                icon={<Music className="w-12 h-12" />}
                title="No artists yet"
                description="Your library is empty. Sync your music to get started."
            />
        );
    }

    return (
        <div
            data-tv-section="library-artists"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4"
        >
            {artists.map((artist, index) => (
                <ArtistCardItem
                    key={artist.id}
                    artist={artist}
                    index={index}
                    onPlay={onPlay}
                    onDelete={onDelete}
                    canDelete={canDelete}
                    hidePlayButtons={hidePlayButtons}
                />
            ))}
        </div>
    );
});

export { ArtistsGrid };
