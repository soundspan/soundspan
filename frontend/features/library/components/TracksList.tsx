"use client";

import { useCallback } from "react";
import { Track } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import Link from "next/link";
import { AudioLines, Trash2 } from "lucide-react";
import { getArtistHref } from "@/utils/artistRoute";
import { resolveStreamCoverArtUrl } from "@/lib/streamCoverArt";
import { TrackMenuButton } from "@/components/ui/TrackOverflowMenu";
import { TrackList, TrackListHeader } from "@/components/track";
import type {
    TrackRowItem,
    OverflowConfig,
    TrackRowSlots,
} from "@/components/track";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { RemoteSourceBadges } from "@/components/ui/RemoteSourceBadges";
import {
    getRemoteLibrarySource,
    toLibraryAudioTrack,
} from "../libraryTrackPlayback";
import type {
    RemoteTrackAcquisition,
    RemoteTrackAcquisitionPolicy,
} from "../remoteTrackAcquisition";
import { RemoteTrackAcquisitionItem } from "./RemoteTrackAcquisitionItem";

/** Empty-state copy for the list. */
export interface TracksListEmptyCopy {
    title: string;
    description: string;
}

interface TracksListProps {
    tracks: Track[];
    onPlay: (tracks: Track[], startIndex?: number) => void;
    onDelete: (trackId: string, trackTitle: string) => void;
    canDelete?: boolean;
    isLoading?: boolean;
    /** What the viewer may do to bring a liked streaming song into the library. */
    acquisitionPolicy?: RemoteTrackAcquisitionPolicy;
    onAcquire?: (action: RemoteTrackAcquisition) => void;
    emptyCopy?: TracksListEmptyCopy;
}

const DEFAULT_EMPTY_COPY: TracksListEmptyCopy = {
    title: "No songs yet",
    description: "Your library is empty. Sync your music to get started.",
};

const NO_ACQUISITION: RemoteTrackAcquisitionPolicy = {
    downloadsEnabled: false,
    tidalDownloadsEnabled: false,
    requestsEnabled: false,
};

function toRowItem(track: Track): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artistName: track.album?.artist?.name ?? "",
        duration: track.duration,
        coverArtUrl: resolveStreamCoverArtUrl(
            track.album?.coverArt,
            getRemoteLibrarySource(track),
            80,
        ),
        isPlayable: track.source !== "federated" || track.peer?.online === true,
        unplayableReason:
            track.source === "federated" && track.peer?.online === false
                ? "peer_offline"
                : undefined,
    };
}

function renderTitleBadges(track: Track) {
    if (track.source === "federated" && track.peer) {
        return (
            <PeerBadge peerName={track.peer.name} online={track.peer.online} />
        );
    }
    const remoteSource = getRemoteLibrarySource(track);
    return remoteSource ? (
        <RemoteSourceBadges sources={[remoteSource]} />
    ) : undefined;
}

/**
 * Renders the TracksList component.
 */
export function TracksList({
    tracks,
    onPlay,
    onDelete,
    canDelete = false,
    isLoading = false,
    acquisitionPolicy = NO_ACQUISITION,
    onAcquire,
    emptyCopy = DEFAULT_EMPTY_COPY,
}: TracksListProps) {
    const handlePlay = useCallback(
        (_item: Track, index: number) => onPlay(tracks, index),
        [tracks, onPlay],
    );

    const rowSlots = useCallback(
        (track: Track): TrackRowSlots => ({
            titleBadges: renderTitleBadges(track),
            artistContent: track.album?.artist
                ? (() => {
                      const href = getArtistHref({
                          id: track.album!.artist!.id,
                          name: track.album!.artist!.name,
                      });
                      return (
                          <p className="text-xs text-gray-400 truncate">
                              {href ? (
                                  <Link
                                      href={href}
                                      className="hover:underline hover:text-white"
                                      onClick={(e) => e.stopPropagation()}
                                  >
                                      {track.album!.artist!.name}
                                  </Link>
                              ) : (
                                  track.album!.artist!.name
                              )}
                          </p>
                      );
                  })()
                : undefined,
            middleColumns: (
                <div className="hidden md:block min-w-0">
                    <p className="text-sm text-gray-400 truncate">
                        {track.album?.title}
                    </p>
                </div>
            ),
        }),
        [],
    );

    const rowOverflow = useCallback(
        (track: Track): OverflowConfig => {
            const isRemote = getRemoteLibrarySource(track) !== null;
            return {
                track: {
                    ...toLibraryAudioTrack(track),
                    title: track.displayTitle ?? track.title,
                },
                showMatchVibe: !isRemote,
                extraItemsBefore: (
                    <RemoteTrackAcquisitionItem
                        track={track}
                        policy={acquisitionPolicy}
                        onAcquire={onAcquire}
                    />
                ),
                extraItemsAfter:
                    canDelete && track.source !== "federated" && !isRemote ? (
                        <TrackMenuButton
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(track.id, track.title);
                            }}
                            icon={<Trash2 className="h-4 w-4" />}
                            label="Delete track"
                            className="text-red-400 hover:text-red-300"
                        />
                    ) : undefined,
            };
        },
        [acquisitionPolicy, canDelete, onAcquire, onDelete],
    );

    return (
        <TrackList
            items={tracks}
            toRowItem={toRowItem}
            onPlay={handlePlay}
            rowSlots={rowSlots}
            rowOverflow={rowOverflow}
            rowClassName="grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto]"
            tvSection="library-tracks"
            preferenceMode="both"
            isLoading={isLoading}
            loadingState={
                <div className="flex items-center justify-center min-h-[400px]">
                    <GradientSpinner size="md" />
                </div>
            }
            emptyState={
                <EmptyState
                    icon={<AudioLines className="w-12 h-12" />}
                    title={emptyCopy.title}
                    description={emptyCopy.description}
                />
            }
            header={
                <TrackListHeader
                    className="grid-cols-[auto_1fr_1fr_auto] gap-3"
                    columns={[
                        { label: "#", className: "w-8 text-center" },
                        { label: "Title" },
                        { label: "Album" },
                        { label: "", className: "w-[230px]" },
                    ]}
                />
            }
        />
    );
}
