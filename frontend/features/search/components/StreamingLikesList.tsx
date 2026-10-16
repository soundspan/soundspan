"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState } from "@/lib/audio-state-context";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { formatTime } from "@/utils/formatTime";
import { getArtistHref } from "@/utils/artistRoute";
import { TrackList } from "@/components/track";
import type { TrackRowItem, TrackRowSlots } from "@/components/track";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { RemoteSourceBadges } from "@/components/ui/RemoteSourceBadges";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { resolveStreamCoverArtUrl } from "@/lib/streamCoverArt";
import {
    getRemoteLibrarySource,
    toLibraryAudioTrack,
} from "@/features/library/libraryTrackPlayback";
import { RemoteTrackAcquisitionItem } from "@/features/library/components/RemoteTrackAcquisitionItem";
import type {
    RemoteTrackAcquisition,
    RemoteTrackAcquisitionPolicy,
} from "@/features/library/remoteTrackAcquisition";
import type { Track as LibraryBrowseTrack } from "@/features/library/types";
import { SongsSubheading } from "./SongsSubheading";

interface StreamingLikesListProps {
    tracks: LibraryBrowseTrack[];
    limit?: number | null;
    acquisitionPolicy: RemoteTrackAcquisitionPolicy;
    onAcquire: (action: RemoteTrackAcquisition) => void;
}

function toRowItem(track: LibraryBrowseTrack): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        artistName: track.album?.artist?.name ?? "",
        duration: track.duration,
        coverArtUrl: resolveStreamCoverArtUrl(
            track.album?.coverArt,
            getRemoteLibrarySource(track),
            48,
        ),
    };
}

function TrackLinks({ track }: { track: LibraryBrowseTrack }) {
    const artist = track.album?.artist;
    const artistHref = artist
        ? getArtistHref({ id: artist.id, name: artist.name })
        : null;
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    return (
        <p className="text-xs text-gray-400 truncate">
            {artistHref ? (
                <Link
                    href={artistHref}
                    className="hover:underline hover:text-white"
                    onClick={stop}
                >
                    {artist?.name}
                </Link>
            ) : (
                artist?.name
            )}
            {track.album?.title && <span className="mx-1">&bull;</span>}
            {track.album?.id ? (
                <Link
                    href={`/album/${track.album.id}`}
                    className="hover:underline hover:text-white"
                    onClick={stop}
                >
                    {track.album.title}
                </Link>
            ) : (
                track.album?.title
            )}
        </p>
    );
}

/**
 * The search page's "From your streaming services" group: liked TIDAL /
 * YouTube Music songs that are not in the library, kept apart from (and
 * below) the library results and always badged by provider.
 */
export function StreamingLikesList({
    tracks,
    limit = 5,
    acquisitionPolicy,
    onAcquire,
}: StreamingLikesListProps) {
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { playTracks, pause, resume } = useAudioControls();
    const visibleTracks =
        typeof limit === "number" ? tracks.slice(0, limit) : tracks;

    const handlePlay = useCallback(
        (track: LibraryBrowseTrack, index: number) => {
            if (currentTrack?.id !== track.id) {
                playTracks(visibleTracks.map(toLibraryAudioTrack), index);
                return;
            }
            if (isPlaying) pause();
            else resume();
        },
        [currentTrack?.id, isPlaying, pause, playTracks, resume, visibleTracks],
    );

    const rowSlots = useCallback(
        (track: LibraryBrowseTrack): TrackRowSlots => {
            const source = getRemoteLibrarySource(track);
            return {
                titleBadges: source ? (
                    <RemoteSourceBadges sources={[source]} />
                ) : undefined,
                artistContent: <TrackLinks track={track} />,
                trailingActions: (
                    <div
                        className="flex items-center justify-end gap-1 flex-shrink-0"
                        role="presentation"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                    >
                        <span className="text-sm text-gray-400">
                            {formatTime(track.duration)}
                        </span>
                        <TrackPreferenceButtons
                            trackId={track.id}
                            mode="both"
                            buttonSizeClassName="h-8 w-8"
                            iconSizeClassName="h-4 w-4"
                            metadata={buildPreferenceMetadata({
                                id: track.id,
                                title: track.title,
                                duration: track.duration,
                                artist: { name: track.album?.artist?.name },
                                album: { title: track.album?.title },
                            })}
                        />
                        <TrackOverflowMenu
                            track={toLibraryAudioTrack(track)}
                            showMatchVibe={false}
                            extraItemsBefore={
                                <RemoteTrackAcquisitionItem
                                    track={track}
                                    policy={acquisitionPolicy}
                                    onAcquire={onAcquire}
                                />
                            }
                        />
                    </div>
                ),
            };
        },
        [acquisitionPolicy, onAcquire],
    );

    if (visibleTracks.length === 0) return null;

    return (
        <section
            aria-labelledby="search-streaming-likes-heading"
            className="my-4 rounded-lg border border-white/10 pt-3 pb-1"
        >
            <SongsSubheading id="search-streaming-likes-heading">
                From your streaming services
            </SongsSubheading>
            <TrackList
                items={visibleTracks}
                toRowItem={toRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowClassName="grid-cols-[auto_1fr_auto]"
                className="space-y-1"
                preferenceMode={null}
                tvSection="search-streaming-likes"
            />
        </section>
    );
}
