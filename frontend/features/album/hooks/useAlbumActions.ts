import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TrackPreferenceSignal } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-context";
import { useListenTogether } from "@/lib/listen-together-context";
import { useDownloadContext } from "@/lib/download-context";
import { buildOptimisticTrackPreferenceResponse } from "@/hooks/trackPreferenceOptimistic";
import { shuffleArray } from "@/utils/shuffle";
import { toast } from "sonner";
import { Album, Track } from "../types";

export function useAlbumActions() {
    const queryClient = useQueryClient();
    const [isApplyingAlbumPreference, setIsApplyingAlbumPreference] =
        useState(false);
    // Use controls-only hook to avoid re-renders from playback state changes
    const {
        playTracks,
        playTrack: playTrackAudio,
        playNow: playNowAudio,
        addToQueue: addToQueueAudio,
        addTracksToQueue: addTracksToQueueAudio,
    } = useAudioControls();
    const { isInGroup } = useListenTogether();
    const { addPendingDownload, isPendingByMbid } = useDownloadContext();

    const toPlaybackTrack = (track: Track, album: Album) => ({
        id: track.id,
        title: track.title,
        duration: track.duration,
        artist: {
            name: track.artist?.name || album.artist?.name || "",
            id: track.artist?.id || album.artist?.id || "",
        },
        album: {
            title: album.title,
            id: album.id,
            coverArt: album.coverArt || album.coverUrl,
        },
        filePath: track.filePath,
        ...(track.streamSource === "tidal" && {
            streamSource: "tidal" as const,
            tidalTrackId: track.tidalTrackId,
        }),
        ...(track.streamSource === "youtube" && {
            streamSource: "youtube" as const,
            youtubeVideoId: track.youtubeVideoId,
        }),
    });

    const playAlbum = (album: Album | null, startIndex: number = 0) => {
        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const formattedTracks =
            album.tracks &&
            album.tracks.map((track) => toPlaybackTrack(track, album));

        if (formattedTracks) {
            playTracks(formattedTracks, startIndex);
        }
    };

    const shufflePlay = (album: Album | null) => {
        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const formattedTracks =
            album.tracks &&
            album.tracks.map((track) => toPlaybackTrack(track, album));

        if (formattedTracks) {
            // Shuffle the tracks array
            const shuffled = shuffleArray(formattedTracks);
            playTracks(shuffled, 0);
        }
    };

    const playTrack = (track: Track, album: Album | null) => {
        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const formattedTrack = toPlaybackTrack(track, album);

        playTrackAudio(formattedTrack);
    };

    const playTrackNow = (track: Track, album: Album | null) => {
        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const formattedTrack = toPlaybackTrack(track, album);
        playNowAudio(formattedTrack);
    };

    const addToQueue = (track: Track, album: Album | null) => {
        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const formattedTrack = toPlaybackTrack(track, album);

        addToQueueAudio(formattedTrack);
    };

    const addAllToQueue = (album: Album | null) => {
        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const formattedTracks =
            album.tracks &&
            album.tracks.map((track) => toPlaybackTrack(track, album));

        if (!formattedTracks || formattedTracks.length === 0) {
            toast.info("No tracks available to add");
            return;
        }

        if (isInGroup) {
            playTracks(formattedTracks, 0);
            return;
        }

        addTracksToQueueAudio(formattedTracks, { silent: true });

        toast.success(
            formattedTracks.length === 1
                ? "Added 1 track to queue"
                : `Added ${formattedTracks.length} tracks to queue`
        );
    };

    const downloadAlbum = async (album: Album | null, e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation();
        }

        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const mbid = album.rgMbid || album.mbid || album.id;
        if (!mbid) {
            toast.error("Album MBID not available");
            return;
        }

        if (isPendingByMbid(mbid)) {
            toast.info("Album is already being downloaded");
            return;
        }

        try {
            addPendingDownload("album", album.title, mbid);

            // Show immediate feedback to user
            toast.loading(`Preparing download: "${album.title}"...`, {
                id: `download-${mbid}`,
            });

            await api.downloadAlbum(
                album.artist?.name || "Unknown Artist",
                album.title,
                mbid
            );

            // Update the loading toast to success
            toast.success(`Downloading "${album.title}"`, {
                id: `download-${mbid}`,
            });
        } catch {
            toast.error("Failed to start album download", {
                id: `download-${mbid}`,
            });
        }
    };

    const setAlbumPreference = async (
        album: Album | null,
        signal: TrackPreferenceSignal
    ) => {
        if (!album) {
            toast.error("Album data not available");
            return;
        }

        const trackIds = Array.from(
            new Set(
                (album.tracks || [])
                    .map((track) => track.id)
                    .filter(
                        (trackId): trackId is string =>
                            typeof trackId === "string" &&
                            trackId.trim().length > 0
                    )
            )
        );

        if (trackIds.length === 0) {
            toast.info("No tracks available for album preference update");
            return;
        }

        setIsApplyingAlbumPreference(true);
        try {
            await api.setAlbumPreference(album.id, signal);

            for (const trackId of trackIds) {
                queryClient.setQueryData(
                    ["track-preference", trackId],
                    buildOptimisticTrackPreferenceResponse(trackId, signal)
                );
            }

            if (signal === "thumbs_up") {
                toast.success(
                    trackIds.length === 1 ?
                        "Liked 1 track from this album"
                    :   `Liked ${trackIds.length} tracks from this album`
                );
            } else if (signal === "thumbs_down") {
                toast.success(
                    trackIds.length === 1 ?
                        "Disliked 1 track from this album"
                    :   `Disliked ${trackIds.length} tracks from this album`
                );
            } else {
                toast.success(
                    trackIds.length === 1 ?
                        "Cleared preference for 1 album track"
                    :   `Cleared preferences for ${trackIds.length} album tracks`
                );
            }
        } catch {
            toast.error("Failed to update album track preferences");
        } finally {
            setIsApplyingAlbumPreference(false);
        }
    };

    return {
        playAlbum,
        shufflePlay,
        playTrack,
        playTrackNow,
        addToQueue,
        addAllToQueue,
        downloadAlbum,
        setAlbumPreference,
        isApplyingAlbumPreference,
    };
}
