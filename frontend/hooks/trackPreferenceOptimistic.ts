import type {
    TrackPreferenceResponse,
    TrackPreferenceSignal,
} from "../lib/api";

export function buildOptimisticTrackPreferenceResponse(
    trackId: string,
    signal: TrackPreferenceSignal
): TrackPreferenceResponse {
    const now = new Date().toISOString();
    const state =
        signal === "thumbs_up" ? "liked"
        : signal === "thumbs_down" ? "disliked"
        : "neutral";

    return {
        trackId,
        signal,
        state,
        score:
            signal === "thumbs_up" ? 1
            : signal === "thumbs_down" ? -1
            : 0,
        likedAt: signal === "thumbs_up" ? now : null,
        dislikedAt: signal === "thumbs_down" ? now : null,
        updatedAt: now,
    };
}

export interface TrackPreferenceOptimisticQueryClient {
    cancelQueries: (options: { queryKey: readonly [string, string]; exact: boolean }) => Promise<unknown>;
    getQueryData: <T>(queryKey: readonly [string, string]) => T | undefined;
    setQueryData: (
        queryKey: readonly [string, string],
        data: TrackPreferenceResponse
    ) => void;
}

export function applyOptimisticTrackPreferenceMutation(
    queryClient: TrackPreferenceOptimisticQueryClient,
    trackId: string,
    nextSignal: TrackPreferenceSignal
) {
    const canonicalQueryKey = ["track-preference", trackId] as const;

    // Fire cancellation in the background so optimistic UI updates are immediate.
    void queryClient.cancelQueries({
        queryKey: canonicalQueryKey,
        exact: true,
    });

    const previousPreference =
        queryClient.getQueryData<TrackPreferenceResponse>(canonicalQueryKey);
    queryClient.setQueryData(
        canonicalQueryKey,
        buildOptimisticTrackPreferenceResponse(trackId, nextSignal)
    );

    return { canonicalQueryKey, previousPreference };
}
