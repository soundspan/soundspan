import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TrackPreferenceResponse, TrackPreferenceSignal } from "@/lib/api";
import { buildOptimisticTrackPreferenceResponse } from "@/hooks/trackPreferenceOptimistic";
import { toast } from "sonner";
import type { Album } from "../types";

function albumTrackIds(album: Album): string[] {
    return Array.from(
        new Set(
            (album.tracks || [])
                .map((track) => track.id)
                .filter((trackId) => trackId.trim().length > 0),
        ),
    );
}

function preferenceSuccessMessage(
    signal: TrackPreferenceSignal,
    trackCount: number,
): string {
    const noun = trackCount === 1 ? "track" : "tracks";
    if (signal === "thumbs_up")
        return `Liked ${trackCount} ${noun} from this album`;
    if (signal === "thumbs_down")
        return `Disliked ${trackCount} ${noun} from this album`;
    return `Cleared preferences for ${trackCount} album ${noun}`;
}

/** Provides album-wide preference mutation and optimistic cache updates. */
export function useAlbumPreferenceActions() {
    const queryClient = useQueryClient();
    const [isApplyingAlbumPreference, setIsApplyingAlbumPreference] =
        useState(false);

    const setAlbumPreference = async (
        album: Album | null,
        signal: TrackPreferenceSignal,
    ) => {
        if (!album) return toast.error("Album data not available");
        const trackIds = albumTrackIds(album);
        if (trackIds.length === 0) {
            return toast.info(
                "No tracks available for album preference update",
            );
        }
        setIsApplyingAlbumPreference(true);
        try {
            await api.setAlbumPreference(album.id, signal);
            trackIds.forEach((trackId) =>
                queryClient.setQueryData(
                    ["track-preference", trackId],
                    buildOptimisticTrackPreferenceResponse(trackId, signal),
                ),
            );
            await queryClient.invalidateQueries({
                queryKey: ["library", "liked-playlist"],
            });
            toast.success(preferenceSuccessMessage(signal, trackIds.length));
        } catch {
            toast.error("Failed to update album track preferences");
        } finally {
            setIsApplyingAlbumPreference(false);
        }
    };

    return { setAlbumPreference, isApplyingAlbumPreference };
}

/** Returns whether every album track currently has a thumbs-up preference. */
export function useAlbumLikedState(album: Album | null) {
    const trackIds = useMemo(
        () => (album ? albumTrackIds(album) : []),
        [album],
    );
    const preferenceQueries = useQueries({
        queries: trackIds.map((trackId) => ({
            queryKey: ["track-preference", trackId] as const,
            queryFn: () => api.getTrackPreference(trackId),
            staleTime: 120_000,
            enabled: trackIds.length > 0,
        })),
    });

    return useMemo(
        () =>
            trackIds.length > 0 &&
            preferenceQueries.every(
                (query) =>
                    (query.data as TrackPreferenceResponse | undefined)
                        ?.signal === "thumbs_up",
            ),
        [trackIds.length, preferenceQueries],
    );
}
