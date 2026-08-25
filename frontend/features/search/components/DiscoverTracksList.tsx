"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Music, Play } from "lucide-react";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { getArtistRouteParam } from "@/utils/artistRoute";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import {
    useSearchTrackMatches,
    type SearchMatchTarget,
    type SearchProviderMatch,
} from "../hooks/useSearchTrackMatches";

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

function rowKey(track: DiscoverResult, index: number): string {
    return `discover-track-${track.id || track.name}-${index}`;
}

function toPlaybackTrack(
    track: DiscoverResult,
    key: string,
    match: SearchProviderMatch,
) {
    return {
        id: key,
        title: track.name,
        artist: { name: track.artist ?? "" },
        album: { title: track.album ?? "" },
        duration: match.duration ?? 0,
        streamSource: match.source,
        ...(match.source === "tidal"
            ? { tidalTrackId: match.tidalTrackId }
            : { youtubeVideoId: match.youtubeVideoId }),
    };
}

/**
 * Renders external (Last.fm) track search results. Rows matched against an
 * enabled streaming provider play in place; unmatched rows link to the
 * artist page as before.
 */
export function DiscoverTracksList({
    tracks,
    limit = 10,
}: DiscoverTracksListProps) {
    const router = useRouter();
    const { playTracks } = useAudioControls();

    const visibleTracks = useMemo(
        () => (limit === null ? tracks : tracks.slice(0, limit)),
        [tracks, limit],
    );

    const matchTargets = useMemo(
        (): SearchMatchTarget[] =>
            visibleTracks
                .filter((track) => track.artist)
                .map((track, index) => ({
                    key: rowKey(track, index),
                    artist: track.artist!,
                    title: track.name,
                    album: track.album ?? undefined,
                })),
        [visibleTracks],
    );
    const { matches } = useSearchTrackMatches(matchTargets);

    const handleRowClick = useCallback(
        (track: DiscoverResult, key: string) => {
            const match = matches.get(key);
            if (match) {
                playTracks([toPlaybackTrack(track, key, match)], 0);
                return;
            }
            const artistHref = getTrackArtistHref(track);
            if (artistHref) router.push(artistHref);
        },
        [matches, playTracks, router],
    );

    if (tracks.length === 0) {
        return null;
    }

    return (
        <div className="space-y-1" data-tv-section="search-discover-tracks">
            {visibleTracks.map((track, index) => {
                const imageUrl = getProxiedImageUrl(track.image);
                const key = rowKey(track, index);
                const match = matches.get(key);
                const isPlayable = Boolean(match);

                return (
                    <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        data-tv-card
                        data-tv-card-index={index}
                        onClick={() => handleRowClick(track, key)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleRowClick(track, key);
                            }
                        }}
                        className="group flex items-center gap-4 p-3 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                        aria-label={
                            isPlayable
                                ? `Play ${track.name} by ${track.artist ?? ""}`
                                : `Go to ${track.artist ?? "artist"}`
                        }
                    >
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
                            {isPlayable && (
                                <div className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/50">
                                    <Play className="w-4 h-4 text-white" />
                                </div>
                            )}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white truncate flex items-center gap-1.5">
                                <span className="truncate">{track.name}</span>
                                {match?.source === "tidal" && <TidalBadge />}
                                {match?.source === "youtube" && (
                                    <YouTubeBadge />
                                )}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                                {track.artist}
                                {track.album ? ` — ${track.album}` : ""}
                            </p>
                        </div>
                        <div
                            className="flex items-center"
                            role="presentation"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                        >
                            <TrackOverflowMenu
                                track={{
                                    id: key,
                                    title: track.name,
                                    artist: { name: track.artist ?? "" },
                                    album: { title: track.album ?? "" },
                                    duration: match?.duration ?? 0,
                                    streamSource: match?.source,
                                }}
                                showPlayNext={isPlayable}
                                showAddToQueue={isPlayable}
                                showAddToPlaylist={isPlayable}
                                showMatchVibe={false}
                                showVibeMap={false}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
