import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Real provider: module-mocking "@tanstack/react-query" does not intercept the
// hook's own import (project files resolve the package in the CJS realm).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const featuresState = {
    musicCNN: false,
    vibeEmbeddings: false,
    audioAnalysis: true,
    discovery: true,
    autoPlaylists: true,
    showVersion: false,
    loading: false,
};

const queryCalls = {
    recommendations: [] as unknown[][],
    discoverWeekly: [] as unknown[][],
    mixes: [] as unknown[][],
};

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => featuresState,
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: true }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => `cover:${url}`,
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        },
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            error: () => undefined,
        },
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        useRecommendationsQuery: (limit: number, enabled: boolean) => {
            queryCalls.recommendations.push([limit, enabled]);
            return { data: { artists: [{ id: "artist-1" }] }, isLoading: false };
        },
        useDiscoverWeeklySummaryQuery: (enabled: boolean) => {
            queryCalls.discoverWeekly.push([enabled]);
            return {
                data: {
                    weekStart: "2026-06-01",
                    weekEnd: "2026-06-07",
                    totalCount: 25,
                    tracks: [],
                },
                isLoading: false,
            };
        },
        useMixesQuery: (enabled: boolean) => {
            queryCalls.mixes.push([enabled]);
            return { data: [{ id: "mix-1" }], isLoading: false };
        },
        useLikedPlaylistQuery: () => ({ data: { total: 3, tracks: [] } }),
        usePopularArtistsQuery: () => ({ data: { artists: [] } }),
        useRefreshMixesMutation: () => ({
            mutateAsync: async () => undefined,
            isPending: false,
        }),
        useYtMusicHomeShelvesQuery: () => ({ data: [] }),
        useYtMusicChartsQuery: () => ({ data: {} }),
        useYtMusicCategoriesQuery: () => ({
            data: { moodCategories: [], genreCategories: [] },
            isLoading: false,
        }),
        useYtMusicMixesQuery: () => ({ data: [] }),
        useTidalHomeShelvesQuery: () => ({ data: [] }),
        useTidalExploreShelvesQuery: () => ({ data: [] }),
        useTidalGenresQuery: () => ({ data: [] }),
        useTidalMoodsQuery: () => ({ data: [] }),
        useTidalMixesQuery: () => ({ data: [] }),
        queryKeys: { mixes: () => ["mixes"] },
    },
});

async function renderHook() {
    const { useExploreData } = await import(
        "../../features/explore/hooks/useExploreData"
    );
    const capturedRef = {
        current: null as ReturnType<typeof useExploreData> | null,
    };
    const Probe = () => {
        capturedRef.current = useExploreData();
        return null;
    };
    renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(Probe)
        )
    );
    if (!capturedRef.current) throw new Error("useExploreData did not run");
    return capturedRef.current;
}

beforeEach(() => {
    featuresState.audioAnalysis = true;
    featuresState.discovery = true;
    featuresState.autoPlaylists = true;
    queryCalls.recommendations.length = 0;
    queryCalls.discoverWeekly.length = 0;
    queryCalls.mixes.length = 0;
});

test("explore data enables gated queries and passes data through when flags are on", async () => {
    const result = await renderHook();

    assert.deepEqual(queryCalls.recommendations, [[10, true]]);
    assert.deepEqual(queryCalls.discoverWeekly, [[true]]);
    assert.deepEqual(queryCalls.mixes, [[true]]);
    assert.equal(result.recommended.length, 1);
    assert.equal(result.mixes.length, 1);
    assert.notEqual(result.discoverWeekly, null);
});

test("explore data disables discovery queries and hides their data when discovery is off", async () => {
    featuresState.discovery = false;
    const result = await renderHook();

    assert.deepEqual(queryCalls.recommendations, [[10, false]]);
    assert.deepEqual(queryCalls.discoverWeekly, [[false]]);
    assert.deepEqual(result.recommended, []);
    assert.equal(result.discoverWeekly, null);
    // autoPlaylists is untouched
    assert.equal(result.mixes.length, 1);
});

test("explore data disables mixes query and hides mixes when autoPlaylists is off", async () => {
    featuresState.autoPlaylists = false;
    const result = await renderHook();

    assert.deepEqual(queryCalls.mixes, [[false]]);
    assert.deepEqual(result.mixes, []);
    // discovery is untouched
    assert.equal(result.recommended.length, 1);
    assert.notEqual(result.discoverWeekly, null);
});
