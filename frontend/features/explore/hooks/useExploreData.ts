/**
 * Hook providing data for the Explore page.
 * Composes from existing React Query hooks to serve all sections.
 */

import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { frontendLogger as log } from "@/lib/logger";
import { useAuth } from "@/lib/auth-context";
import { useFeatures } from "@/lib/features-context";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Artist, Mix, PopularArtist } from "@/features/home/types";
import {
    useLibraryRadioData,
    type RadioStation,
} from "@/features/home/components/LibraryRadioStations";
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
    useYtMusicMixesQuery,
    useTidalHomeShelvesQuery,
    useTidalExploreShelvesQuery,
    useTidalGenresQuery,
    useTidalMoodsQuery,
    useTidalMixesQuery,
    queryKeys,
    type YtMusicHomeShelf,
    type YtMusicCategory,
    type YtMusicChartEntry,
    type YtMusicMixPreview,
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

/** Provider-backed Explore queries that currently have no usable result. */
export interface ExploreProviderFailures {
    ytMusic: {
        mixes: boolean;
        categories: boolean;
        home: boolean;
        charts: boolean;
    };
    tidal: {
        mixes: boolean;
        moods: boolean;
        genres: boolean;
        home: boolean;
        explore: boolean;
    };
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
    /** Static library radio stations. */
    quickStartStations: RadioStation[];
    /** Library-derived genre radio stations. */
    genreStations: RadioStation[];
    /** Library-derived decade radio stations. */
    decadeStations: RadioStation[];
    /** YT Music mood categories. */
    moodCategories: YtMusicCategory[];
    /** YT Music genre categories. */
    genreCategories: YtMusicCategory[];
    /** YT Music personalized mixes (requires OAuth). */
    ytMusicMixes: YtMusicMixPreview[];
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
    /** True while library radio metadata is loading. */
    isRadioLoading: boolean;
    /** Whether YT Music Explore content is enabled. */
    showYtMusicExplore: boolean;
    /** Whether TIDAL Explore content is enabled. */
    showTidalExplore: boolean;
    /** True when at least one enabled Explore query failed. */
    hasDegradedResults: boolean;
    /** Stable signature identifying the enabled Explore queries in error. */
    degradedFailureSignature: string;
    /** Failed provider-backed sections, rendered as inline availability notes. */
    providerFailures: ExploreProviderFailures;
    /** Trigger a mixes refresh. */
    handleRefreshMixes: () => Promise<void>;
    /** Retry every enabled Explore query that is currently in error. */
    retryAll: () => Promise<void>;
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
export function useExploreData(options?: {
    showYtMusicExplore?: boolean;
    showTidalExplore?: boolean;
}): UseExploreDataReturn {
    const showYtMusicExplore = options?.showYtMusicExplore ?? true;
    const showTidalExplore = options?.showTidalExplore ?? false;
    const { isAuthenticated } = useAuth();
    const { discovery, autoPlaylists } = useFeatures();
    const queryClient = useQueryClient();
    const libraryRadioData = useLibraryRadioData();

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
    const likedQuery = useLikedPlaylistQuery(4);
    const discoverQuery = useDiscoverWeeklySummaryQuery(discovery);
    const mixesQuery = useMixesQuery(autoPlaylists);
    const recommendedQuery = useRecommendationsQuery(10, discovery);
    const { data: likedData } = likedQuery;
    const { data: discoverData } = discoverQuery;
    const { data: mixesData, isLoading: isLoadingMixes } = mixesQuery;
    const { data: recommendedData, isLoading: isLoadingRecommended } =
        recommendedQuery;
    const { mutateAsync: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    // ── Trending queries ─────────────────────────────────────────────────
    const shelvesQuery = useYtMusicHomeShelvesQuery({
        enabled: showYtMusicExplore,
    });
    const chartsQuery = useYtMusicChartsQuery({
        enabled: showYtMusicExplore,
    });
    const popularQuery = usePopularArtistsQuery(20);
    const { data: shelvesData } = shelvesQuery;
    const { data: chartsData } = chartsQuery;
    const { data: popularData } = popularQuery;

    // ── Moods & Genres queries ───────────────────────────────────────────
    const categoriesQuery = useYtMusicCategoriesQuery({
        enabled: showYtMusicExplore,
    });
    const ytMusicMixesQuery = useYtMusicMixesQuery({
        enabled: showYtMusicExplore,
    });
    const { data: categoriesData, isLoading: isLoadingCategories } =
        categoriesQuery;
    const { data: ytMusicMixesData } = ytMusicMixesQuery;

    // ── TIDAL Browse queries ─────────────────────────────────────────────
    const tidalHomeQuery = useTidalHomeShelvesQuery({
        enabled: showTidalExplore,
    });
    const tidalExploreQuery = useTidalExploreShelvesQuery({
        enabled: showTidalExplore,
    });
    const tidalGenresQuery = useTidalGenresQuery({
        enabled: showTidalExplore,
    });
    const tidalMoodsQuery = useTidalMoodsQuery({
        enabled: showTidalExplore,
    });
    const tidalMixesQuery = useTidalMixesQuery({
        enabled: showTidalExplore,
    });
    const { data: tidalHomeData } = tidalHomeQuery;
    const { data: tidalExploreData } = tidalExploreQuery;
    const { data: tidalGenresData } = tidalGenresQuery;
    const { data: tidalMoodsData } = tidalMoodsQuery;
    const { data: tidalMixesData } = tidalMixesQuery;

    const libraryFailures = [
        { key: "liked", enabled: true, query: likedQuery },
        {
            key: "discoverWeekly",
            enabled: discovery,
            query: discoverQuery,
        },
        {
            key: "mixes",
            enabled: autoPlaylists,
            query: mixesQuery,
        },
        {
            key: "recommendations",
            enabled: discovery,
            query: recommendedQuery,
        },
        { key: "popularArtists", enabled: true, query: popularQuery },
        {
            key: "libraryGenres",
            enabled: true,
            query: libraryRadioData.genresQuery,
        },
        {
            key: "libraryDecades",
            enabled: true,
            query: libraryRadioData.decadesQuery,
        },
    ].filter(({ enabled, query }) => enabled && query.isError);
    const providerQueries = [
        {
            key: "ytHome",
            enabled: showYtMusicExplore,
            query: shelvesQuery,
        },
        {
            key: "ytCharts",
            enabled: showYtMusicExplore,
            query: chartsQuery,
        },
        {
            key: "ytCategories",
            enabled: showYtMusicExplore,
            query: categoriesQuery,
        },
        {
            key: "ytMixes",
            enabled: showYtMusicExplore,
            query: ytMusicMixesQuery,
        },
        {
            key: "tidalHome",
            enabled: showTidalExplore,
            query: tidalHomeQuery,
        },
        {
            key: "tidalExplore",
            enabled: showTidalExplore,
            query: tidalExploreQuery,
        },
        {
            key: "tidalGenres",
            enabled: showTidalExplore,
            query: tidalGenresQuery,
        },
        {
            key: "tidalMoods",
            enabled: showTidalExplore,
            query: tidalMoodsQuery,
        },
        {
            key: "tidalMixes",
            enabled: showTidalExplore,
            query: tidalMixesQuery,
        },
    ];
    const providerQueryFailures = providerQueries.filter(
        ({ enabled, query }) => enabled && query.isLoadingError,
    );
    const providerRetryFailures = providerQueries.filter(
        ({ enabled, query }) => enabled && query.isError,
    );
    const failedKeys = new Set(providerQueryFailures.map(({ key }) => key));
    const providerFailures: ExploreProviderFailures = {
        ytMusic: {
            mixes: failedKeys.has("ytMixes"),
            categories: failedKeys.has("ytCategories"),
            home: failedKeys.has("ytHome"),
            charts: failedKeys.has("ytCharts"),
        },
        tidal: {
            mixes: failedKeys.has("tidalMixes"),
            moods: failedKeys.has("tidalMoods"),
            genres: failedKeys.has("tidalGenres"),
            home: failedKeys.has("tidalHome"),
            explore: failedKeys.has("tidalExplore"),
        },
    };
    const hasDegradedResults = libraryFailures.length > 0;
    const degradedFailureSignature = libraryFailures
        .map(({ key }) => key)
        .sort()
        .join("|");
    const retryAll = async (): Promise<void> => {
        await Promise.all(
            [...libraryFailures, ...providerRetryFailures].map(({ query }) =>
                query.refetch(),
            ),
        );
    };

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
        if (!discovery || !discoverData) return null;
        const firstCover = discoverData.tracks?.[0]?.coverUrl ?? null;
        return {
            weekStart: discoverData.weekStart,
            weekEnd: discoverData.weekEnd,
            totalCount: discoverData.totalCount,
            coverUrl: firstCover ? api.getCoverArtUrl(firstCover, 200) : null,
        };
    }, [discovery, discoverData]);

    return {
        likedSummary,
        discoverWeekly,
        mixes: autoPlaylists && Array.isArray(mixesData) ? mixesData : [],
        recommended: discovery ? (recommendedData?.artists ?? []) : [],
        homeShelves: shelvesData ?? [],
        charts: chartsData ?? {},
        popularArtists: popularData?.artists ?? [],
        quickStartStations: libraryRadioData.quickStartStations,
        genreStations: libraryRadioData.genreStations,
        decadeStations: libraryRadioData.decadeStations,
        moodCategories: categoriesData?.moodCategories ?? [],
        genreCategories: categoriesData?.genreCategories ?? [],
        ytMusicMixes: ytMusicMixesData ?? [],
        tidalHomeShelves: tidalHomeData ?? [],
        tidalExploreShelves: tidalExploreData ?? [],
        tidalGenres: tidalGenresData ?? [],
        tidalMoods: tidalMoodsData ?? [],
        tidalMixes: tidalMixesData ?? [],
        isLoading,
        isRefreshingMixes,
        isMoodsLoading,
        isRadioLoading: libraryRadioData.isLoading,
        showYtMusicExplore,
        showTidalExplore,
        hasDegradedResults,
        degradedFailureSignature,
        providerFailures,
        handleRefreshMixes,
        retryAll,
    };
}
