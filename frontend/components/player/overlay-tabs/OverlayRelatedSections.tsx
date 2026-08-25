"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { Loader2, Music as MusicIcon, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { getArtistHref } from "@/utils/artistRoute";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackPreferenceButtons } from "../TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import {
    getRelatedTrackKey,
    type RelatedStreamMatch,
} from "@/lib/overlay-related-matching";
import type {
    RelatedAlbum,
    RelatedArtist,
    RelatedTrack,
} from "./overlayRelatedTypes";

interface RelatedSectionShellProps {
    title: string;
    isLoading: boolean;
    isError: boolean;
    onRetry: () => void;
    errorText: string;
    isEmpty: boolean;
    emptyText: string;
    children: ReactNode;
}

/** One Related-tab section: heading plus loading/error/empty/content states. */
export function RelatedSectionShell({
    title,
    isLoading,
    isError,
    onRetry,
    errorText,
    isEmpty,
    emptyText,
    children,
}: RelatedSectionShellProps) {
    return (
        <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-400">
                {title}
            </h3>
            {isLoading ? (
                <div className="flex items-center gap-2 text-gray-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">Loading...</span>
                </div>
            ) : isError ? (
                <div className="flex items-center gap-3">
                    <p className="text-sm text-gray-400">{errorText}</p>
                    <button
                        onClick={onRetry}
                        className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-300 hover:bg-white/10 transition-colors"
                    >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                    </button>
                </div>
            ) : isEmpty ? (
                <p className="text-sm text-gray-400">{emptyText}</p>
            ) : (
                children
            )}
        </section>
    );
}

function SimilarSongBadge({
    track,
    streamMatch,
    isMatching,
}: {
    track: RelatedTrack;
    streamMatch: RelatedStreamMatch | undefined;
    isMatching: boolean;
}) {
    if (track.inLibrary) {
        return (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                In Library
            </span>
        );
    }
    if (isMatching) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-gray-300">
                <Loader2 className="h-3 w-3 animate-spin" />
                Matching
            </span>
        );
    }
    if (streamMatch?.streamSource === "tidal") return <TidalBadge />;
    if (streamMatch?.streamSource === "youtube") return <YouTubeBadge />;
    if (track.lastFmUrl) {
        return (
            <span className="rounded-full border border-white/20 bg-white/[0.04] px-2 py-0.5 text-[10px] text-gray-300">
                Info
            </span>
        );
    }
    return (
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-gray-400">
            Search
        </span>
    );
}

interface SimilarSongsListProps {
    tracks: RelatedTrack[];
    streamMatches: Record<string, RelatedStreamMatch>;
    matchingTrackKey: string | null;
    onPlayRelatedTrack: (track: RelatedTrack) => void;
}

export function SimilarSongsList({
    tracks,
    streamMatches,
    matchingTrackKey,
    onPlayRelatedTrack,
}: SimilarSongsListProps) {
    return (
        <div className="space-y-1.5">
            {tracks.map((track, idx) => {
                const trackKey = getRelatedTrackKey(track);
                const albumCover =
                    track.album?.coverArt || track.album?.coverUrl;
                return (
                    <button
                        key={`${track.id || track.title}-${idx}`}
                        type="button"
                        onClick={() => onPlayRelatedTrack(track)}
                        className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[0.06]"
                    >
                        <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-surface-hover">
                            {albumCover ? (
                                <Image
                                    src={api.getCoverArtUrl(albumCover, 100)}
                                    alt={track.album?.title || track.title}
                                    fill
                                    sizes="40px"
                                    className="object-cover"
                                    unoptimized
                                />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center">
                                    <MusicIcon className="h-4 w-4 text-gray-400" />
                                </div>
                            )}
                        </div>
                        <div className="min-w-0 flex-1 pr-2">
                            <p className="truncate text-sm text-gray-200 group-hover:text-white">
                                {track.title}
                            </p>
                            <p className="truncate text-xs text-gray-400">
                                {track.inLibrary
                                    ? track.album?.artist?.name ||
                                      track.artist ||
                                      "Unknown artist"
                                    : track.artist || "Unknown artist"}
                            </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <SimilarSongBadge
                                track={track}
                                streamMatch={streamMatches[trackKey]}
                                isMatching={matchingTrackKey === trackKey}
                            />
                            {track.inLibrary && track.id && (
                                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
                                <div onClick={(e) => e.stopPropagation()}>
                                    <TrackPreferenceButtons
                                        trackId={track.id}
                                        mode="up-only"
                                        buttonSizeClassName="h-8 w-8"
                                        iconSizeClassName="h-4 w-4"
                                        metadata={buildPreferenceMetadata(
                                            track,
                                        )}
                                    />
                                </div>
                            )}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

interface SimilarArtistsGridProps {
    artists: RelatedArtist[];
    onNavigate: () => void;
}

export function SimilarArtistsGrid({
    artists,
    onNavigate,
}: SimilarArtistsGridProps) {
    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {artists.slice(0, 9).map((artist, idx) => {
                const artistHref =
                    getArtistHref(
                        { mbid: artist.mbid, name: artist.name },
                        { preferLibraryId: false },
                    ) || `/artist/${encodeURIComponent(artist.name)}`;
                const artistId = artist.mbid || encodeURIComponent(artist.name);
                return (
                    <Link
                        key={`${artistId}-${idx}`}
                        href={artistHref}
                        onClick={onNavigate}
                        className="group p-1.5 transition-colors hover:bg-white/[0.06]"
                    >
                        <div className="mb-2 relative mx-auto h-12 w-12 overflow-hidden rounded-full bg-surface-hover">
                            {artist.image ? (
                                <Image
                                    src={artist.image}
                                    alt={artist.name}
                                    fill
                                    sizes="48px"
                                    className="object-cover"
                                    unoptimized
                                />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center">
                                    <MusicIcon className="h-4 w-4 text-gray-400" />
                                </div>
                            )}
                        </div>
                        <p className="truncate text-center text-xs text-gray-200 group-hover:text-white">
                            {artist.name}
                        </p>
                    </Link>
                );
            })}
        </div>
    );
}

interface MoreFromArtistGridProps {
    albums: RelatedAlbum[];
    onNavigate: () => void;
}

export function MoreFromArtistGrid({
    albums,
    onNavigate,
}: MoreFromArtistGridProps) {
    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {albums.slice(0, 6).map((album) => (
                <Link
                    key={album.id}
                    href={`/album/${album.id}`}
                    onClick={onNavigate}
                    className="group p-1.5 transition-colors hover:bg-white/[0.06]"
                >
                    <div className="relative mb-2 aspect-square w-full overflow-hidden rounded bg-surface-hover">
                        {album.coverArt ? (
                            <Image
                                src={api.getCoverArtUrl(album.coverArt, 200)}
                                alt={album.title}
                                fill
                                sizes="140px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center">
                                <MusicIcon className="h-5 w-5 text-gray-400" />
                            </div>
                        )}
                    </div>
                    <p className="truncate text-xs text-gray-200 group-hover:text-white">
                        {album.title}
                    </p>
                    {album.year && (
                        <p className="text-[11px] text-gray-400">
                            {album.year}
                        </p>
                    )}
                </Link>
            ))}
        </div>
    );
}
