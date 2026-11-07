/**
 * Explore discovery shelves: music outside the library, tailored to the
 * current user's plays and likes in soundspan (global popular content for
 * users without history). Gated on the discovery feature, matching the
 * backend route.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type ExploreDiscovery } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useFeatures } from "@/lib/features-context";

const EMPTY_DISCOVERY: ExploreDiscovery = {
    personalized: false,
    similarArtists: [],
    newReleases: [],
    trendingTracks: [],
    tagShelves: [],
};

/** Fetches Explore discovery shelves; empty shelves while loading or off. */
export function useExploreDiscovery(): {
    discovery: ExploreDiscovery;
    isLoading: boolean;
} {
    const { discovery: discoveryEnabled } = useFeatures();
    const { data, isLoading } = useQuery({
        queryKey: queryKeys.exploreDiscovery(),
        queryFn: () => api.getExploreDiscovery(),
        enabled: discoveryEnabled,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });
    return {
        discovery: data ?? EMPTY_DISCOVERY,
        isLoading: discoveryEnabled && isLoading,
    };
}
