/**
 * Hook providing data for the Explore page.
 * Composes from existing React Query hooks to serve all sections.
 */

import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { frontendLogger as log } from "@/lib/logger";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Artist, Mix, PopularArtist } from "@/features/home/types";
import {
    useRecommendationsQuery,
    useLikedPlaylistQuery,
    useDiscoverWeeklySummaryQuery,
    useMixesQuery,
    usePopularArtistsQuery,
    useRefreshMixesMutation,
    useYtMusicHomeShelvesQuery,
    useYtMusicChartsQuery,
    useYtMusicCategoriesQuery,
    useTidalHomeShelvesQuery,
    useTidalExploreShelvesQuery,
    useTidalGenresQuery,
    useTidalMoodsQuery,
    useTidalMixesQuery,
    queryKeys,
    type YtMusicHomeShelf,
    type YtMusicCategory,
    type YtMusicChartEntry,
    type TidalBrowseShelf,
    type TidalGenre,
    type TidalMixPreview,
} from "@/hooks/useQueries";

/** Summary data for the user's liked-tracks playlist. */
export interface LikedPlaylistSummary {
    total: number;
    coverUrl: string | null;
}

/** Summary data for the weekly discovery playlist. */
export interface DiscoverWeeklySummary {
    weekStart: string;
    weekEnd: string;
    totalCount: number;
    coverUrl: string | null;
}

/** Return shape for {@link useExploreData}. */
export interface UseExploreDataReturn {
    /** My Liked playlist summary. */
    likedSummary: LikedPlaylistSummary | null;
    /** Discover Weekly summary. */
    discoverWeekly: DiscoverWeeklySummary | null;
    /** Made For You mixes. */
    mixes: Mix[];
    /** Recommended artists from Last.fm. */
    recommended: Artist[];
    /** YT Music home shelves. */
    homeShelves: YtMusicHomeShelf[];
    /** YT Music charts by section. */
    charts: Record<string, YtMusicChartEntry[]>;
    /** Popular artists from Last.fm. */
    popularArtists: PopularArtist[];
    /** YT Music mood categories. */
    moodCategories: YtMusicCategory[];
    /** YT Music genre categories. */
    genreCategories: YtMusicCategory[];
    /** TIDAL home shelves (personalized). */
    tidalHomeShelves: TidalBrowseShelf[];
    /** TIDAL explore shelves (editorial). */
    tidalExploreShelves: TidalBrowseShelf[];
    /** TIDAL genre categories. */
    tidalGenres: TidalGenre[];
    /** TIDAL mood categories. */
    tidalMoods: TidalGenre[];
    /** TIDAL personal mixes (Daily Discovery, etc.). */
    tidalMixes: TidalMixPreview[];
    /** True while initial critical data is loading. */
    isLoading: boolean;
    /** True while mixes are being refreshed. */
    isRefreshingMixes: boolean;
    /** True while moods/genres data is loading. */
    isMoodsLoading: boolean;
    /** Whether YT Music Explore content is enabled. */
    showYtMusicExplore: boolean;
    /** Whether TIDAL Explore content is enabled. */
    showTidalExplore: boolean;
    /** Trigger a mixes refresh. */
    handleRefreshMixes: () => Promise<void>;
}

/**
 * Provides all data for the Explore page sections.
 *
 * Composes from existing React Query hooks:
 * - Made For You: mixes, recommendations, liked, discover weekly
 * - Featured Shelves: YT Music shelves
 * - Charts: YT Music charts
 * - Moods & Genres: YT Music categories (split into moods vs genres)
 * - Popular Artists: Last.fm
 */
export function useExploreData(options?: { showYtMusicExplore?: boolean; showTidalExplore?: boolean }): UseExploreDataReturn {
    const showYtMusicExplore = options?.showYtMusicExplore ?? true;
    const showTidalExplore = options?.showTidalExplore ?? false;
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();

    // Event listeners for cross-component updates
    useEffect(() => {
        const handleMixesUpdated = () => {
            queryClient.refetchQueries({ queryKey: queryKeys.mixes() });
        };
        window.addEventListener("mixes-updated", handleMixesUpdated);
        return () =>
            window.removeEventListener("mixes-updated", handleMixesUpdated);
    }, [queryClient]);

    // ── For You queries ──────────────────────────────────────────────────
    const { data: likedData } = useLikedPlaylistQuery(4);
    const { data: discoverData } = useDiscoverWeeklySummaryQuery();
    const { data: mixesData, isLoading: isLoadingMixes } = useMixesQuery();
    const { data: recommendedData, isLoading: isLoadingRecommended } =
        useRecommendationsQuery(10);
    const { mutateAsync: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    // ── Trending queries ─────────────────────────────────────────────────
    const { data: shelvesData } = useYtMusicHomeShelvesQuery({ enabled: showYtMusicExplore });
    const { data: chartsData } = useYtMusicChartsQuery({ enabled: showYtMusicExplore });
    const { data: popularData } = usePopularArtistsQuery(20);

    // ── Moods & Genres queries ───────────────────────────────────────────
    const { data: categoriesData, isLoading: isLoadingCategories } =
        useYtMusicCategoriesQuery({ enabled: showYtMusicExplore });

    // ── TIDAL Browse queries ─────────────────────────────────────────────
    const { data: tidalHomeData } = useTidalHomeShelvesQuery({ enabled: showTidalExplore });
    const { data: tidalExploreData } = useTidalExploreShelvesQuery({ enabled: showTidalExplore });
    const { data: tidalGenresData } = useTidalGenresQuery({ enabled: showTidalExplore });
    const { data: tidalMoodsData } = useTidalMoodsQuery({ enabled: showTidalExplore });
    const { data: tidalMixesData } = useTidalMixesQuery({ enabled: showTidalExplore });

    // ── Loading states ───────────────────────────────────────────────────
    const hasPrimaryData =
        (Array.isArray(mixesData) ? mixesData.length : 0) > 0 ||
        (recommendedData?.artists?.length ?? 0) > 0;

    const allPrimaryLoading = isLoadingMixes && isLoadingRecommended;

    const isLoading =
        !isAuthenticated || (!hasPrimaryData && allPrimaryLoading);

    const isMoodsLoading = isLoadingCategories;

    // ── Refresh handler ──────────────────────────────────────────────────
    const handleRefreshMixes = async () => {
        try {
            await refreshMixes();
            toast.success("Mixes refreshed! Check out your new daily picks");
        } catch (error) {
            log.error("Failed to refresh mixes:", error);
            toast.error("Failed to refresh mixes");
        }
    };

    // ── Derived summaries ────────────────────────────────────────────────
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

    return {
        likedSummary,
        discoverWeekly,
        mixes: Array.isArray(mixesData) ? mixesData : [],
        recommended: recommendedData?.artists ?? [],
        homeShelves: shelvesData ?? [],
        charts: chartsData ?? {},
        popularArtists: popularData?.artists ?? [],
        moodCategories: categoriesData?.moodCategories ?? [],
        genreCategories: categoriesData?.genreCategories ?? [],
        tidalHomeShelves: tidalHomeData ?? [],
        tidalExploreShelves: tidalExploreData ?? [],
        tidalGenres: tidalGenresData ?? [],
        tidalMoods: tidalMoodsData ?? [],
        tidalMixes: tidalMixesData ?? [],
        isLoading,
        isRefreshingMixes,
        isMoodsLoading,
        showYtMusicExplore,
        showTidalExplore,
        handleRefreshMixes,
    };
}
