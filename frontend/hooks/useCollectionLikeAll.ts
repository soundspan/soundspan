import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TrackPreferenceResponse } from "@/lib/api";
import { buildOptimisticTrackPreferenceResponse } from "@/hooks/trackPreferenceOptimistic";
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

export interface LikeableTrack {
    id: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    thumbnailUrl?: string;
}

/** Process items in batches of `size` with concurrency control. */
async function batchProcess<T>(
    items: T[],
    size: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    for (let i = 0; i < items.length; i += size) {
        await Promise.all(items.slice(i, i + size).map(fn));
    }
}

const BATCH_SIZE = 8;

/**
 * Returns de-duplicated non-empty track IDs in original order.
 */
export function collectLikeableTrackIds(tracks: LikeableTrack[]): string[] {
    const seen = new Set<string>();
    const uniqueIds: string[] = [];
    for (const track of tracks) {
        const id = typeof track.id === "string" ? track.id.trim() : "";
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        uniqueIds.push(id);
    }
    return uniqueIds;
}

/**
 * Shared hook for "Like All" toggle on collection pages (playlist, yt-playlist, etc.).
 * Checks each track's preference via React Query cache and provides a toggle function.
 */
export function useCollectionLikeAll(tracks: LikeableTrack[]) {
    const queryClient = useQueryClient();
    const [isApplying, setIsApplying] = useState(false);

    const trackIds = useMemo(() => collectLikeableTrackIds(tracks), [tracks]);

    const prefQueries = useQueries({
        queries: trackIds.map((trackId) => ({
            queryKey: ["track-preference", trackId] as const,
            queryFn: () => api.getTrackPreference(trackId),
            staleTime: 120_000,
            enabled: trackIds.length > 0,
        })),
    });

    const isAllLiked = useMemo(() => {
        if (trackIds.length === 0) return false;
        return prefQueries.every(
            (q) => (q.data as TrackPreferenceResponse | undefined)?.signal === "thumbs_up"
        );
    }, [trackIds.length, prefQueries]);

    const toggleLikeAll = async () => {
        if (trackIds.length === 0 || isApplying) return;

        const nextSignal = isAllLiked ? "clear" as const : "thumbs_up" as const;
        setIsApplying(true);

        // Snapshot previous cache values for rollback
        const previousValues = new Map<string, unknown>();
        for (const trackId of trackIds) {
            previousValues.set(
                trackId,
                queryClient.getQueryData(["track-preference", trackId]),
            );
        }

        // Optimistic cache updates
        for (const trackId of trackIds) {
            queryClient.setQueryData(
                ["track-preference", trackId],
                buildOptimisticTrackPreferenceResponse(trackId, nextSignal)
            );
        }

        try {
            // Build metadata lookup for remote tracks
            const trackById = new Map(tracks.map((t) => [t.id, t]));

            await batchProcess(trackIds, BATCH_SIZE, async (trackId) => {
                const track = trackById.get(trackId);
                const metadata = track ? {
                    title: track.title,
                    artist: track.artist,
                    album: track.album,
                    duration: track.duration,
                    thumbnailUrl: track.thumbnailUrl,
                } : undefined;
                await api.setTrackPreference(trackId, nextSignal, metadata);
            });

            queryClient.invalidateQueries({ queryKey: ["library", "liked-playlist"] });

            if (nextSignal === "thumbs_up") {
                toast.success(
                    trackIds.length === 1
                        ? "Liked 1 track"
                        : `Liked ${trackIds.length} tracks`
                );
            } else {
                toast.success(
                    trackIds.length === 1
                        ? "Cleared preference for 1 track"
                        : `Cleared preferences for ${trackIds.length} tracks`
                );
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to toggle like all:", error);
            toast.error("Failed to update track preferences");
            // Rollback: restore previous cache values then refetch
            for (const trackId of trackIds) {
                const prev = previousValues.get(trackId);
                if (prev !== undefined) {
                    queryClient.setQueryData(["track-preference", trackId], prev);
                } else {
                    queryClient.removeQueries({ queryKey: ["track-preference", trackId] });
                }
            }
            for (const trackId of trackIds) {
                queryClient.invalidateQueries({ queryKey: ["track-preference", trackId] });
            }
        } finally {
            setIsApplying(false);
        }
    };

    return { isAllLiked, isApplying, toggleLikeAll };
}
