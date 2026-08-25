"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Track } from "@/lib/audio-state-context";
import {
    buildStreamMatchQuery,
    getRelatedTrackKey,
    partitionTidalBatchMatches,
    selectTracksNeedingStreamMatch,
    sortRelatedTracksByRelevance,
    type RelatedStreamMatch,
} from "@/lib/overlay-related-matching";
import { buildTabTransitionProps } from "./overlayTabMotion";
import {
    MoreFromArtistGrid,
    RelatedSectionShell,
    SimilarArtistsGrid,
    SimilarSongsList,
} from "./OverlayRelatedSections";
import type {
    RelatedAlbum,
    RelatedArtist,
    RelatedTrack,
} from "./overlayRelatedTypes";

/**
 * Stream matches survive tab switches and track changes without re-calling
 * the match sidecars. Bounded so a long session cannot grow it unchecked.
 */
const STREAM_MATCH_CACHE_LIMIT = 200;
const streamMatchCache = new Map<string, RelatedStreamMatch>();

function rememberStreamMatches(
    matches: Readonly<Record<string, RelatedStreamMatch>>,
): void {
    for (const [key, match] of Object.entries(matches)) {
        if (streamMatchCache.size >= STREAM_MATCH_CACHE_LIMIT) {
            const oldestKey = streamMatchCache.keys().next().value;
            if (oldestKey !== undefined) streamMatchCache.delete(oldestKey);
        }
        streamMatchCache.set(key, match);
    }
}

/** TIDAL first, YouTube Music second; null when neither service matches. */
async function resolveSingleStreamMatch(
    track: RelatedTrack,
): Promise<RelatedStreamMatch | null> {
    const query = buildStreamMatchQuery(track);
    const artist = query.artist.trim();
    const title = query.title.trim();
    if (!artist || !title) return null;

    try {
        const tidalResponse = await api.matchTidalTrack(
            artist,
            title,
            query.albumTitle,
            query.duration,
        );
        if (tidalResponse.match?.id) {
            return {
                streamSource: "tidal",
                tidalTrackId: tidalResponse.match.id,
                title: tidalResponse.match.title,
                artist: tidalResponse.match.artist,
                duration: tidalResponse.match.duration,
            };
        }
    } catch {
        // Ignore TIDAL single-match failures and try YT.
    }

    try {
        const ytResponse = await api.matchYtMusicTrack(
            artist,
            title,
            query.albumTitle,
            query.duration,
        );
        if (ytResponse.match?.videoId) {
            return {
                streamSource: "youtube",
                youtubeVideoId: ytResponse.match.videoId,
                title: ytResponse.match.title,
                duration: ytResponse.match.duration,
            };
        }
    } catch {
        // Ignore YT single-match failures and fall through to info.
    }
    return null;
}

function buildLibraryPlaybackTrack(
    track: RelatedTrack,
    artistName: string,
): Track {
    return {
        id: track.id as string,
        title: track.title,
        artist: {
            id: track.album?.artist?.id,
            mbid: track.album?.artist?.mbid,
            name: artistName,
        },
        album: {
            id: track.album?.id,
            title: track.album?.title || "Unknown album",
            coverArt: track.album?.coverArt || track.album?.coverUrl,
        },
        duration: track.duration || 0,
        filePath: track.filePath,
        streamSource: track.streamSource,
        tidalTrackId: track.tidalTrackId,
        youtubeVideoId: track.youtubeVideoId,
    } as Track;
}

function buildStreamPlaybackTrack(
    track: RelatedTrack,
    match: RelatedStreamMatch,
    artistName: string,
): Track {
    return {
        id:
            match.streamSource === "tidal"
                ? `related-tidal-${match.tidalTrackId}`
                : `related-yt-${match.youtubeVideoId}`,
        title: track.title,
        artist: { name: artistName },
        album: {
            title: track.album?.title || "Related Tracks",
            coverArt: track.album?.coverArt || track.album?.coverUrl,
        },
        duration: match.duration || track.duration || 0,
        streamSource: match.streamSource,
        tidalTrackId: match.tidalTrackId,
        youtubeVideoId: match.youtubeVideoId,
    } as Track;
}

interface OverlayRelatedTabProps {
    currentTrack: Track | null;
    /** Related content only applies to library/stream track playback. */
    isTrackPlayback: boolean;
    playTrack: (track: Track) => void;
    /** Close the overlay before navigating to an artist/album page. */
    onNavigate: () => void;
}

/**
 * The overlay drawer's Related tab (GH #787): similar songs, similar
 * artists, and more albums from the playing artist. Owns its three fetches
 * and the stream-match hydration, so none of it runs unless this panel is
 * mounted.
 */
export const OverlayRelatedTab = memo(function OverlayRelatedTab({
    currentTrack,
    isTrackPlayback,
    playTrack,
    onNavigate,
}: OverlayRelatedTabProps) {
    const shouldReduceMotion = useReducedMotion();
    const queryClient = useQueryClient();
    const [streamMatches, setStreamMatches] = useState<
        Record<string, RelatedStreamMatch>
    >(() => Object.fromEntries(streamMatchCache));
    const [matchingTrackKey, setMatchingTrackKey] = useState<string | null>(
        null,
    );

    const addStreamMatches = useCallback(
        (found: Record<string, RelatedStreamMatch>) => {
            rememberStreamMatches(found);
            setStreamMatches((prev) => ({ ...prev, ...found }));
        },
        [],
    );

    const {
        data: relatedTrackData,
        isLoading: isRelatedTracksLoading,
        isError: isRelatedTracksError,
    } = useQuery({
        queryKey: queryKeys.playerRelatedTracks(currentTrack?.id),
        queryFn: async () => {
            if (!currentTrack?.id) return [];
            const response = await api.getSimilarTracks(
                currentTrack.id,
                12,
                currentTrack.artist?.name,
                currentTrack.displayTitle || currentTrack.title,
            );
            return response.recommendations || [];
        },
        enabled: isTrackPlayback && !!currentTrack?.id,
        staleTime: 5 * 60 * 1000,
        retry: 1,
    });

    const {
        data: relatedArtistsData,
        isLoading: isRelatedArtistsLoading,
        isError: isRelatedArtistsError,
    } = useQuery({
        queryKey: queryKeys.playerRelatedArtists(
            currentTrack?.artist?.name,
            currentTrack?.artist?.mbid,
        ),
        queryFn: async () => {
            if (!currentTrack?.artist?.name) return [];
            const response = await api.discoverSimilarArtists(
                currentTrack.artist.name,
                currentTrack.artist.mbid || "",
                8,
            );
            return response.similarArtists || [];
        },
        enabled: isTrackPlayback && !!currentTrack?.artist?.name,
        staleTime: 30 * 60 * 1000,
        retry: 1,
    });

    const {
        data: moreFromArtistData,
        isLoading: isMoreFromArtistLoading,
        isError: isMoreFromArtistError,
    } = useQuery({
        queryKey: queryKeys.playerRelatedAlbums(currentTrack?.artist?.id),
        queryFn: async () => {
            if (!currentTrack?.artist?.id) return [];
            const response = await api.getAlbums({
                artistId: currentTrack.artist.id,
                limit: 8,
                sortBy: "recent",
            });
            return response.albums || [];
        },
        enabled: isTrackPlayback && !!currentTrack?.artist?.id,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    const relatedTracks = useMemo<RelatedTrack[]>(
        () =>
            Array.isArray(relatedTrackData)
                ? (relatedTrackData as RelatedTrack[])
                : [],
        [relatedTrackData],
    );
    const relatedArtists = useMemo<RelatedArtist[]>(
        () =>
            Array.isArray(relatedArtistsData)
                ? (relatedArtistsData as RelatedArtist[])
                : [],
        [relatedArtistsData],
    );
    const moreFromArtist = useMemo<RelatedAlbum[]>(
        () =>
            Array.isArray(moreFromArtistData)
                ? (moreFromArtistData as RelatedAlbum[])
                : [],
        [moreFromArtistData],
    );
    const sortedRelatedTracks = useMemo(
        () => sortRelatedTracksByRelevance(relatedTracks),
        [relatedTracks],
    );
    const visibleRelatedTracks = useMemo(
        () => sortedRelatedTracks.slice(0, 8),
        [sortedRelatedTracks],
    );

    useEffect(() => {
        if (!isTrackPlayback) return;
        const missingTracks = selectTracksNeedingStreamMatch(
            visibleRelatedTracks,
            streamMatches,
        );
        if (missingTracks.length === 0) return;

        let cancelled = false;

        const hydrateMissingRelatedStreams = async () => {
            let tidalMatches: Array<{
                id: number;
                title: string;
                artist: string;
                duration: number;
                isrc?: string;
            } | null> = [];
            try {
                const tidalResponse = await api.matchTidalBatch(
                    missingTracks.map(buildStreamMatchQuery),
                );
                tidalMatches = Array.isArray(tidalResponse.matches)
                    ? tidalResponse.matches
                    : [];
            } catch {
                tidalMatches = [];
            }

            const { foundMatches, youtubePayload, youtubeTrackKeys } =
                partitionTidalBatchMatches(missingTracks, tidalMatches);

            if (youtubePayload.length > 0) {
                try {
                    const ytResponse =
                        await api.matchYtMusicBatch(youtubePayload);
                    const ytMatches = Array.isArray(ytResponse.matches)
                        ? ytResponse.matches
                        : [];
                    youtubeTrackKeys.forEach((trackKey, index) => {
                        const ytMatch = ytMatches[index];
                        if (!ytMatch?.videoId) return;
                        foundMatches[trackKey] = {
                            streamSource: "youtube",
                            youtubeVideoId: ytMatch.videoId,
                            title: ytMatch.title,
                            duration: ytMatch.duration,
                        };
                    });
                } catch {
                    // Ignore YT matching failures; rows still fall back to info links.
                }
            }

            if (cancelled || Object.keys(foundMatches).length === 0) return;
            addStreamMatches(foundMatches);
        };

        hydrateMissingRelatedStreams();

        return () => {
            cancelled = true;
        };
    }, [
        addStreamMatches,
        isTrackPlayback,
        streamMatches,
        visibleRelatedTracks,
    ]);

    const playRelatedTrack = useCallback(
        async (track: RelatedTrack) => {
            const artistName =
                track.album?.artist?.name || track.artist || "Unknown artist";

            if (track.inLibrary && track.id) {
                playTrack(buildLibraryPlaybackTrack(track, artistName));
                return;
            }

            const trackKey = getRelatedTrackKey(track);
            setMatchingTrackKey(trackKey);
            try {
                let resolvedMatch: RelatedStreamMatch | null =
                    streamMatches[trackKey] ?? null;
                if (!resolvedMatch) {
                    resolvedMatch = await resolveSingleStreamMatch(track);
                }

                if (resolvedMatch) {
                    addStreamMatches({ [trackKey]: resolvedMatch });
                    playTrack(
                        buildStreamPlaybackTrack(
                            track,
                            resolvedMatch,
                            artistName,
                        ),
                    );
                    return;
                }

                if (track.lastFmUrl) {
                    window.open(
                        track.lastFmUrl,
                        "_blank",
                        "noopener,noreferrer",
                    );
                    return;
                }

                toast.error(
                    "No playable stream found for this related track yet",
                );
            } finally {
                setMatchingTrackKey(null);
            }
        },
        [addStreamMatches, playTrack, streamMatches],
    );

    return (
        <motion.section
            key="related"
            {...buildTabTransitionProps(shouldReduceMotion)}
            className="h-full space-y-5 overflow-y-auto px-4 py-3"
        >
            <RelatedSectionShell
                title="Similar Songs"
                isLoading={isRelatedTracksLoading}
                isError={isRelatedTracksError}
                errorText="Failed to load similar songs."
                onRetry={() =>
                    queryClient.invalidateQueries({
                        queryKey: queryKeys.playerRelatedTracks(
                            currentTrack?.id,
                        ),
                    })
                }
                isEmpty={sortedRelatedTracks.length === 0}
                emptyText="No similar songs found."
            >
                <SimilarSongsList
                    tracks={visibleRelatedTracks}
                    streamMatches={streamMatches}
                    matchingTrackKey={matchingTrackKey}
                    onPlayRelatedTrack={playRelatedTrack}
                />
            </RelatedSectionShell>

            <RelatedSectionShell
                title="Similar Artists"
                isLoading={isRelatedArtistsLoading}
                isError={isRelatedArtistsError}
                errorText="Failed to load similar artists."
                onRetry={() =>
                    queryClient.invalidateQueries({
                        queryKey: queryKeys.playerRelatedArtists(
                            currentTrack?.artist?.name,
                            currentTrack?.artist?.mbid,
                        ),
                    })
                }
                isEmpty={relatedArtists.length === 0}
                emptyText="No similar artists found."
            >
                <SimilarArtistsGrid
                    artists={relatedArtists}
                    onNavigate={onNavigate}
                />
            </RelatedSectionShell>

            <RelatedSectionShell
                title="More From This Artist"
                isLoading={isMoreFromArtistLoading}
                isError={isMoreFromArtistError}
                errorText="Failed to load albums."
                onRetry={() =>
                    queryClient.invalidateQueries({
                        queryKey: queryKeys.playerRelatedAlbums(
                            currentTrack?.artist?.id,
                        ),
                    })
                }
                isEmpty={moreFromArtist.length === 0}
                emptyText="No albums found."
            >
                <MoreFromArtistGrid
                    albums={moreFromArtist}
                    onNavigate={onNavigate}
                />
            </RelatedSectionShell>
        </motion.section>
    );
});
