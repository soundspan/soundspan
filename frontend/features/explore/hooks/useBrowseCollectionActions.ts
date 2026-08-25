"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { useCollectionLikeAll } from "@/hooks/useCollectionLikeAll";
import type { LikeableTrack } from "@/hooks/useCollectionLikeAll";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { shuffleArray } from "@/utils/shuffle";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    browseTrackToQueueTrack,
    type TidalBrowseCollection,
} from "@/features/explore/browseTrack";

/**
 * Playback, queue, playlist, and like actions for a browse collection page.
 * Behavior mirrors the pre-consolidation per-page handlers exactly.
 */
export function useBrowseCollectionActions(
    collection: TidalBrowseCollection | null,
    noPlayableTracksMessage: string,
) {
    const { toast } = useToast();
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, playNow, addTracksToQueue, pause, resume } =
        useAudioControls();
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();

    const isThisCollectionPlaying =
        currentTrack?.id?.startsWith("tidal:") &&
        collection?.tracks.some(
            (t) => `tidal:${t.trackId}` === currentTrack?.id,
        );

    const playableQueueTracks = () =>
        (collection?.tracks || [])
            .filter((t) => t.trackId)
            .map(browseTrackToQueueTrack);

    const handlePlayAll = (startIndex: number = 0) => {
        if (!collection) return;
        const tracks = playableQueueTracks();
        if (tracks.length === 0) {
            toast.error(noPlayableTracksMessage);
            return;
        }
        playTracks(tracks, startIndex);
    };

    const handleTogglePlay = () => {
        if (isThisCollectionPlaying && isPlaying) {
            pause();
        } else if (isThisCollectionPlaying) {
            resume();
        } else {
            triggerPlayFeedback();
            handlePlayAll(0);
        }
    };

    const likeableTracks: LikeableTrack[] = useMemo(
        () =>
            (collection?.tracks || [])
                .filter((t) => t.trackId)
                .map((t) => ({
                    id: `tidal:${t.trackId}`,
                    title: t.title,
                    artist: t.artist,
                    album: t.album,
                    duration: t.duration,
                    thumbnailUrl: t.thumbnailUrl || undefined,
                })),
        [collection?.tracks],
    );
    const {
        isAllLiked,
        isApplying: isApplyingLikeAll,
        toggleLikeAll,
    } = useCollectionLikeAll(likeableTracks);

    const handleAddToQueue = () => {
        if (!collection) return;
        const tracks = playableQueueTracks();
        if (tracks.length === 0) return;
        addTracksToQueue(tracks);
        toast.success(`Added ${tracks.length} tracks to queue`);
    };

    const handleShuffle = () => {
        if (!collection) return;
        const tracks = playableQueueTracks();
        if (tracks.length < 2) return;
        playTracks(shuffleArray(tracks), 0);
    };

    const handlePlaylistSelected = async (targetPlaylistId: string) => {
        if (!collection?.tracks.length) return;
        setIsAddingToPlaylist(true);
        try {
            for (const track of collection.tracks) {
                if (!track.trackId) continue;
                await api.addTrackToPlaylist(
                    targetPlaylistId,
                    toAddToPlaylistRef({
                        id: `tidal:${track.trackId}`,
                        title: track.title,
                        artist: track.artist,
                        album: track.album,
                        duration: track.duration,
                        streamSource: "tidal",
                        tidalTrackId: track.trackId,
                        thumbnailUrl: track.thumbnailUrl || undefined,
                    }),
                );
            }
            toast.success(
                `Added ${collection.tracks.length} tracks to playlist`,
            );
            setShowPlaylistSelector(false);
        } catch (addError) {
            sharedFrontendLogger.error(
                "Failed to add tracks to playlist:",
                addError,
            );
            toast.error("Failed to add some tracks to playlist");
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    const handlePlayTrack = (index: number) => {
        if (!collection) return;
        const track = collection.tracks[index];
        if (!track?.trackId) return;

        if (currentTrack?.id === `tidal:${track.trackId}`) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        playNow(browseTrackToQueueTrack(track));
    };

    return {
        isThisCollectionPlaying,
        isPlaying,
        showPlaySpinner,
        showPlaylistSelector,
        setShowPlaylistSelector,
        isAddingToPlaylist,
        likeableTracks,
        isAllLiked,
        isApplyingLikeAll,
        toggleLikeAll,
        handleTogglePlay,
        handleAddToQueue,
        handleShuffle,
        handlePlaylistSelected,
        handlePlayTrack,
    };
}
