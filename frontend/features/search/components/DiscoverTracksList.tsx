import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";
import { getArtistRouteParam } from "@/utils/artistRoute";

interface DiscoverTracksListProps {
    tracks: DiscoverResult[];
    limit?: number | null;
}

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 100);
};

const getTrackArtistHref = (track: DiscoverResult): string | null => {
    if (!track.artist) return null;
    const routeParam =
        getArtistRouteParam(
            { name: track.artist },
            { preferLibraryId: false },
        ) || encodeURIComponent(track.artist);
    return `/artist/${routeParam}`;
};

/**
 * Renders external (Last.fm) track search results so users can discover
 * songs that are not in their library and jump to the artist page.
 */
export function DiscoverTracksList({
    tracks,
    limit = 10,
}: DiscoverTracksListProps) {
    if (tracks.length === 0) {
        return null;
    }

    const visibleTracks = limit === null ? tracks : tracks.slice(0, limit);

    return (
        <div className="space-y-1" data-tv-section="search-discover-tracks">
            {visibleTracks.map((track, index) => {
                const imageUrl = getProxiedImageUrl(track.image);
                const artistHref = getTrackArtistHref(track);
                const key = `discover-track-${track.id || track.name}-${index}`;

                const artwork = (
                    <div className="relative w-10 h-10 rounded bg-surface-elevated flex items-center justify-center overflow-hidden shrink-0">
                        {imageUrl ? (
                            <Image
                                src={imageUrl}
                                alt={track.name}
                                fill
                                sizes="40px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <Music className="w-5 h-5 text-gray-400" />
                        )}
                    </div>
                );

                const body = (
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">
                            {track.name}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                            {track.artist}
                            {track.album ? ` — ${track.album}` : ""}
                        </p>
                    </div>
                );

                if (!artistHref) {
                    return (
                        <div
                            key={key}
                            className="flex items-center gap-4 p-3 rounded-lg"
                        >
                            {artwork}
                            {body}
                        </div>
                    );
                }

                return (
                    <Link
                        key={key}
                        href={artistHref}
                        className="flex items-center gap-4 p-3 rounded-lg hover:bg-white/5 transition-colors"
                        data-tv-card
                        data-tv-card-index={index}
                        tabIndex={0}
                    >
                        {artwork}
                        {body}
                    </Link>
                );
            })}
        </div>
    );
}
