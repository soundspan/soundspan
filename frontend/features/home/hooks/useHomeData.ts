/**
 * useHomeData Hook
 *
 * Manages data loading for the Home page, fetching library-focused sections
 * plus Made For You cards and trending community playlists.
 */

import { frontendLogger as log } from "@/lib/logger";
import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { subscribeQueryEvent } from "@/lib/query-events";
import type { Artist, ListenedItem, Mix, PopularArtist, Podcast, Audiobook } from "../types";
import type { LikedPlaylistSummary, DiscoverWeeklySummary } from "@/features/explore/hooks/useExploreData";
import type { PlaylistPreview } from "@/features/home/components/FeaturedPlaylistsGrid";
import {
    useRecentlyListenedQuery,
    useRecentlyAddedQuery,
    useRecommendationsQuery,
    useLikedPlaylistQuery,
    useDiscoverWeeklySummaryQuery,
    useMixesQuery,
    usePopularArtistsQuery,
    useTopPodcastsQuery,
    useAudiobooksQuery,
    useRefreshMixesMutation,
    useYtMusicHomeShelvesQuery,
    queryKeys,
} from "@/hooks/useQueries";

export interface UseHomeDataReturn {
    /** Continue Listening items. */
    recentlyListened: ListenedItem[];
    /** Recently added artists. */
    recentlyAdded: Artist[];
    /** Recommended artists from Last.fm. */
    recommended: Artist[];
    /** Generated mixes. */
    mixes: Mix[];
    /** My Liked playlist summary. */
    likedSummary: LikedPlaylistSummary | null;
    /** Discover Weekly summary. */
    discoverWeekly: DiscoverWeeklySummary | null;
    /** Popular artists from Last.fm. */
    popularArtists: PopularArtist[];
    /** Trending community playlists from YT Music home shelves. */
    communityPlaylists: PlaylistPreview[];
    /** Popular podcasts. */
    recentPodcasts: Podcast[];
    /** Audiobooks. */
    recentAudiobooks: Audiobook[];

    /** True while initial critical data is loading. */
    isLoading: boolean;
    /** True while mixes are being refreshed. */
    isRefreshingMixes: boolean;
    /** True while community playlists are loading. */
    isCommunityPlaylistsLoading: boolean;

    /** Trigger a mixes refresh. */
    handleRefreshMixes: () => Promise<void>;
}

/**
 * Custom hook to load all Home page data sections using React Query.
 *
 * @returns All home page data and loading states.
 */
export function useHomeData(): UseHomeDataReturn {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();

    // Listen for mixes-updated event (fired when user saves mood preferences)
    useEffect(() => {
        const handleMixesUpdated = () => {
            queryClient.refetchQueries({ queryKey: queryKeys.mixes() });
        };
        window.addEventListener("mixes-updated", handleMixesUpdated);
        return () =>
            window.removeEventListener("mixes-updated", handleMixesUpdated);
    }, [queryClient]);

    // Listen for library-updated event (fired when library scan completes)
    useEffect(() => {
        const unsubscribe = subscribeQueryEvent("library-updated", () => {
            queryClient.refetchQueries({ queryKey: queryKeys.recentlyAdded(10) });
        });
        return unsubscribe;
    }, [queryClient]);

    // ── Library queries ─────────────────────────────────────────────────
    const { data: recentlyListenedData, isLoading: isLoadingListened } =
        useRecentlyListenedQuery(10);
    const { data: recentlyAddedData, isLoading: isLoadingAdded } =
        useRecentlyAddedQuery(10);
    const { data: recommendedData, isLoading: isLoadingRecommended } =
        useRecommendationsQuery(10);
    const { data: mixesData, isLoading: isLoadingMixes } = useMixesQuery();

    // ── Made For You queries ────────────────────────────────────────────
    const { data: likedData } = useLikedPlaylistQuery(4);
    const { data: discoverData } = useDiscoverWeeklySummaryQuery();

    // ── Popular Artists / Podcasts / Audiobooks ──────────────────────────
    const { data: popularData, isLoading: isLoadingPopular } =
        usePopularArtistsQuery(20);
    const { data: podcastsData, isLoading: isLoadingPodcasts } =
        useTopPodcastsQuery(10);
    const { data: audiobooksData, isLoading: isLoadingAudiobooks } =
        useAudiobooksQuery({ limit: 10 });

    // ── Trending Community Playlists ────────────────────────────────────
    const { data: shelvesData, isLoading: isCommunityPlaylistsLoading } = useYtMusicHomeShelvesQuery();

    // Mutation for refreshing mixes
    const { mutateAsync: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    const handleRefreshMixes = async () => {
        try {
            await refreshMixes();
            toast.success("Mixes refreshed! Check out your new daily picks");
        } catch (error) {
            log.error("Failed to refresh mixes:", error);
            toast.error("Failed to refresh mixes");
        }
    };

    // ── Derived summaries ───────────────────────────────────────────────
    const likedSummary = useMemo<LikedPlaylistSummary | null>(() => {
        if (!likedData) return null;
        const firstCover = likedData.tracks?.[0]?.album?.coverArt ?? null;
        return {
            total: likedData.total,
            coverUrl: firstCover ? api.getCoverArtUrl(firstCover, 200) : null,
        };
    }, [likedData]);

    const discoverWeekly = useMemo<DiscoverWeeklySummary | null>(() => {
        if (!discoverData) return null;
        const firstCover = discoverData.tracks?.[0]?.coverUrl ?? null;
        return {
            weekStart: discoverData.weekStart,
            weekEnd: discoverData.weekEnd,
            totalCount: discoverData.totalCount,
            coverUrl: firstCover ? api.getCoverArtUrl(firstCover, 200) : null,
        };
    }, [discoverData]);

    const communityPlaylists = useMemo<PlaylistPreview[]>(() => {
        if (!shelvesData) return [];
        const items: PlaylistPreview[] = [];
        const seen = new Set<string>();
        for (const shelf of shelvesData) {
            for (const item of shelf.contents ?? []) {
                if (!item.playlistId || seen.has(item.playlistId)) continue;
                seen.add(item.playlistId);
                const thumb = item.thumbnailUrl ?? null;
                items.push({
                    id: item.playlistId,
                    source: "ytmusic",
                    type: "playlist",
                    title: item.title ?? "Untitled",
                    description: item.subtitle ?? null,
                    creator: "",
                    imageUrl: thumb ? api.getBrowseImageUrl(thumb) : null,
                    url: "",
                });
                if (items.length >= 12) break;
            }
            if (items.length >= 12) break;
        }
        return items;
    }, [shelvesData]);

    // ── Loading state ───────────────────────────────────────────────────
    const items = recentlyListenedData?.items ?? [];

    const hasPrimaryData =
        items.length > 0 ||
        (recentlyAddedData?.artists?.length ?? 0) > 0 ||
        (recommendedData?.artists?.length ?? 0) > 0 ||
        (Array.isArray(mixesData) ? mixesData.length : 0) > 0 ||
        (popularData?.artists?.length ?? 0) > 0 ||
        (Array.isArray(podcastsData) ? podcastsData.length : 0) > 0 ||
        (Array.isArray(audiobooksData) ? audiobooksData.length : 0) > 0;

    const allPrimaryLoading =
        isLoadingListened &&
        isLoadingAdded &&
        isLoadingRecommended &&
        isLoadingMixes &&
        isLoadingPopular &&
        isLoadingPodcasts &&
        isLoadingAudiobooks;

    const isLoading =
        !isAuthenticated || (!hasPrimaryData && allPrimaryLoading);

    return {
        recentlyListened: items,
        recentlyAdded: recentlyAddedData?.artists ?? [],
        recommended: recommendedData?.artists ?? [],
        mixes: Array.isArray(mixesData) ? mixesData : [],
        likedSummary,
        discoverWeekly,
        popularArtists: popularData?.artists ?? [],
        communityPlaylists,
        recentPodcasts: Array.isArray(podcastsData) ? podcastsData.slice(0, 10) : [],
        recentAudiobooks: Array.isArray(audiobooksData) ? audiobooksData : [],
        isLoading,
        isRefreshingMixes,
        isCommunityPlaylistsLoading,
        handleRefreshMixes,
    };
}
