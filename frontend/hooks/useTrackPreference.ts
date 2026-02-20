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
        staleTime: 120_000,
    });

    const preferenceMutation = useMutation({
        mutationFn: async (signal: TrackPreferenceSignal) => {
            if (!trackId) {
                throw new Error("Track ID is required");
            }
            return api.setTrackPreference(trackId, signal);
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

    const toggleThumbsUp = async () => {
        const nextSignal = getNextTrackPreferenceSignal(signal, "thumbs_up");
        return setSignal(nextSignal);
    };

    const toggleThumbsDown = async () => {
        const nextSignal = getNextTrackPreferenceSignal(signal, "thumbs_down");
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
