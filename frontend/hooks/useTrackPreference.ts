"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    api,
    type TrackPreferenceResponse,
    type TrackPreferenceSignal,
} from "@/lib/api";

export function useTrackPreference(trackId?: string | null) {
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
        staleTime: 30_000,
    });

    const preferenceMutation = useMutation({
        mutationFn: async (signal: TrackPreferenceSignal) => {
            if (!trackId) {
                throw new Error("Track ID is required");
            }
            return api.setTrackPreference(trackId, signal);
        },
        onSuccess: (data) => {
            const canonicalQueryKey = ["track-preference", data.trackId] as const;
            queryClient.setQueryData(canonicalQueryKey, data);
            void queryClient.invalidateQueries({
                queryKey: canonicalQueryKey,
                exact: true,
            });
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

    const toggleThumbsUp = async () => {
        const nextSignal = signal === "thumbs_up" ? "clear" : "thumbs_up";
        return setSignal(nextSignal);
    };

    const toggleThumbsDown = async () => {
        const nextSignal = signal === "thumbs_down" ? "clear" : "thumbs_down";
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
        toggleThumbsUp,
        toggleThumbsDown,
    };
}
