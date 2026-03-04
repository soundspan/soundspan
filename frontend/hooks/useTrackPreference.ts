"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    api,
    type TrackPreferenceResponse,
    type TrackPreferenceSignal,
} from "@/lib/api";
import { getNextTrackPreferenceSignal } from "@/hooks/trackPreferenceSignals";
import {
    applyOptimisticTrackPreferenceMutation,
    type TrackPreferenceOptimisticQueryClient,
} from "@/hooks/trackPreferenceOptimistic";

export interface TrackPreferenceMetadata {
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    thumbnailUrl?: string;
}

/**
 * Builds preference metadata from a track-like object for remote tracks.
 * Returns undefined for local tracks so no metadata is sent.
 */
export function buildPreferenceMetadata(track: {
    id?: string | null;
    title?: string;
    duration?: number;
    artist?: { name?: string } | string | null;
    album?: { title?: string } | string | null;
    streamSource?: string | null;
    thumbnailUrl?: string;
} | null | undefined): TrackPreferenceMetadata | undefined {
    if (!track) return undefined;
    const id = track.id;
    if (!id) return undefined;
    // Only send metadata for remote tracks (prefixed ids)
    if (!id.startsWith("yt:") && !id.startsWith("tidal:")) return undefined;

    const artistName = typeof track.artist === "string" ? track.artist : track.artist?.name;
    const albumTitle = typeof track.album === "string" ? track.album : track.album?.title;

    return {
        title: track.title,
        artist: artistName ?? undefined,
        album: albumTitle ?? undefined,
        duration: track.duration,
        thumbnailUrl: track.thumbnailUrl,
    };
}

/**
 * Executes useTrackPreference.
 */
export function useTrackPreference(trackId?: string | null, metadata?: TrackPreferenceMetadata) {
    const queryClient = useQueryClient();
    const normalizedTrackId = trackId ?? "";
    const queryKey = useMemo(
        () => ["track-preference", normalizedTrackId] as const,
        [normalizedTrackId]
    );

    const preferenceQuery = useQuery({
        queryKey,
        queryFn: () => api.getTrackPreference(normalizedTrackId),
        enabled: Boolean(trackId),
        staleTime: 120_000,
    });

    const preferenceMutation = useMutation({
        mutationFn: async (signal: TrackPreferenceSignal) => {
            if (!trackId) {
                throw new Error("Track ID is required");
            }
            return api.setTrackPreference(trackId, signal, metadata);
        },
        onMutate: async (nextSignal) => {
            if (!trackId) return null;
            return applyOptimisticTrackPreferenceMutation(
                queryClient as TrackPreferenceOptimisticQueryClient,
                trackId,
                nextSignal
            );
        },
        onSuccess: (data, _signal, context) => {
            const canonicalQueryKey =
                context?.canonicalQueryKey || (["track-preference", data.trackId] as const);
            queryClient.setQueryData(canonicalQueryKey, data);
            queryClient.invalidateQueries({ queryKey: ["library", "liked-playlist"] });
        },
        onError: (_error, _signal, context) => {
            if (!context?.canonicalQueryKey) return;
            queryClient.setQueryData(
                context.canonicalQueryKey,
                context.previousPreference ?? null
            );
        },
    });

    const preference: TrackPreferenceResponse | null =
        preferenceQuery.data ?? null;
    const signal = preference?.signal ?? "clear";

    const setSignal = async (nextSignal: TrackPreferenceSignal) => {
        if (!trackId) {
            return null;
        }
        return preferenceMutation.mutateAsync(nextSignal);
    };

    const toggleLike = async () => {
        const nextSignal = getNextTrackPreferenceSignal(signal);
        return setSignal(nextSignal);
    };

    return {
        preference,
        signal,
        score: preference?.score ?? 0,
        isLoading: preferenceQuery.isLoading,
        isSaving: preferenceMutation.isPending,
        error: preferenceQuery.error || preferenceMutation.error || null,
        setSignal,
        toggleLike,
    };
}
