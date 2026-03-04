import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    isLoading: false,
    isRefreshingMixes: false,
    recentlyListened: [{ id: "listen-1" }] as unknown[],
    recentlyAdded: [{ id: "artist-1" }] as unknown[],
    recommended: [{ id: "artist-2" }] as unknown[],
    mixes: [{ id: "mix-1", name: "Daily Mix 1", description: "desc", coverUrls: [], trackCount: 10 }] as unknown[],
    likedSummary: { total: 42, coverUrl: "/covers/liked.jpg" } as {
        total: number;
        coverUrl: string | null;
    } | null,
    discoverWeekly: {
        weekStart: "2026-02-24",
        weekEnd: "2026-03-02",
        totalCount: 25,
        coverUrl: "/covers/discover.jpg",
    } as { weekStart: string; weekEnd: string; totalCount: number; coverUrl: string | null } | null,
    communityPlaylists: [
        { id: "pl-1", source: "ytmusic", type: "playlist", title: "Community Hits", description: "Popular", creator: "", imageUrl: null, url: "" },
    ] as unknown[],
    popularArtists: [{ id: "pop-1" }] as unknown[],
    recentPodcasts: [] as unknown[],
    recentAudiobooks: [] as unknown[],
    isCommunityPlaylistsLoading: false,
};

const marker = (label: string) => {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

const Icon = () => React.createElement("i");

mock.module("@/features/home/hooks/useHomeData", {
    namedExports: {
        useHomeData: () => ({
            recentlyListened: state.recentlyListened,
            recentlyAdded: state.recentlyAdded,
            recommended: state.recommended,
            mixes: state.mixes,
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            communityPlaylists: state.communityPlaylists,
            popularArtists: state.popularArtists,
            recentPodcasts: state.recentPodcasts,
            recentAudiobooks: state.recentAudiobooks,
            isLoading: state.isLoading,
            isRefreshingMixes: state.isRefreshingMixes,
            isCommunityPlaylistsLoading: state.isCommunityPlaylistsLoading,
            handleRefreshMixes: async () => undefined,
        }),
    },
});

mock.module("@/components/ui/LoadingScreen", {
    namedExports: { LoadingScreen: marker("loading-screen") },
});

mock.module("@/features/home/components/HomeHero", {
    namedExports: { HomeHero: marker("home-hero") },
});

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("@/features/home/components/ContinueListening", {
    namedExports: { ContinueListening: marker("continue-listening") },
});

mock.module("@/features/home/components/ArtistsGrid", {
    namedExports: { ArtistsGrid: marker("artists-grid") },
});

mock.module("@/features/home/components/PopularArtistsGrid", {
    namedExports: { PopularArtistsGrid: marker("popular-artists-grid") },
});

mock.module("@/features/home/components/PodcastsGrid", {
    namedExports: { PodcastsGrid: marker("podcasts-grid") },
});

mock.module("@/features/home/components/AudiobooksGrid", {
    namedExports: { AudiobooksGrid: marker("audiobooks-grid") },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: () => React.createElement("span", null, "YT") },
});

mock.module("@/components/ui/LastFmBadge", {
    namedExports: { LastFmBadge: () => React.createElement("span", null, "Last.fm") },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: marker("gradient-spinner") },
});

mock.module("@/features/home/components/FeaturedPlaylistsGrid", {
    namedExports: { FeaturedPlaylistsGrid: marker("featured-playlists-grid") },
});

mock.module("@/features/home/components/StaticPlaylistCard", {
    namedExports: {
        StaticPlaylistCard: ({ title, subtitle }: { title: string; subtitle: string }) =>
            React.createElement("div", null, `${title} — ${subtitle}`),
    },
});

mock.module("@/components/ui/HorizontalCarousel", {
    namedExports: {
        HorizontalCarousel: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "carousel" }, children),
        CarouselItem: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "carousel-item" }, children),
    },
});

mock.module("@/components/MixCard", {
    namedExports: {
        MixCard: ({ mix }: { mix: { name: string } }) =>
            React.createElement("div", null, `mix-card:${mix.name}`),
    },
});

mock.module("lucide-react", {
    namedExports: { Heart: Icon, Compass: Icon, RefreshCw: Icon },
});

beforeEach(() => {
    state.isLoading = false;
    state.isRefreshingMixes = false;
    state.recentlyListened = [{ id: "listen-1" }];
    state.recentlyAdded = [{ id: "artist-1" }];
    state.recommended = [{ id: "artist-2" }];
    state.mixes = [{ id: "mix-1", name: "Daily Mix 1", description: "desc", coverUrls: [], trackCount: 10 }];
    state.likedSummary = { total: 42, coverUrl: "/covers/liked.jpg" };
    state.discoverWeekly = {
        weekStart: "2026-02-24",
        weekEnd: "2026-03-02",
        totalCount: 25,
        coverUrl: "/covers/discover.jpg",
    };
    state.communityPlaylists = [
        { id: "pl-1", source: "ytmusic", type: "playlist", title: "Community Hits", description: "Popular", creator: "", imageUrl: null, url: "" },
    ];
    state.popularArtists = [{ id: "pop-1" }];
    state.recentPodcasts = [];
    state.recentAudiobooks = [];
    state.isCommunityPlaylistsLoading = false;
});

test("home page renders loading screen while data is loading", async () => {
    state.isLoading = true;
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /loading-screen/);
    assert.doesNotMatch(html, /Continue Listening/);
});

test("home page renders hero and all sections with data", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /home-hero/);
    assert.match(html, /Continue Listening/);
    assert.match(html, /Recently Added/);
    assert.match(html, /Made For You/);
    assert.match(html, /Trending Community Playlists/);
    assert.match(html, /Recommended For You/);
});

test("home page shows My Liked and Discover Weekly in Made For You", async () => {
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /My Liked/);
    assert.match(html, /42 tracks/);
    assert.match(html, /Discover Weekly/);
    assert.match(html, /25 tracks/);
    assert.match(html, /mix-card:Daily Mix 1/);
});

test("home page hides Continue Listening when empty", async () => {
    state.recentlyListened = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Continue Listening/);
    assert.match(html, /Recently Added/);
});

test("home page hides Recently Added when empty", async () => {
    state.recentlyAdded = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Recently Added/);
    assert.match(html, /Continue Listening/);
});

test("home page hides Made For You when all sources empty", async () => {
    state.likedSummary = null;
    state.discoverWeekly = null;
    state.mixes = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Made For You/);
});

test("home page hides Trending Community Playlists when empty", async () => {
    state.communityPlaylists = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Trending Community Playlists/);
});

test("home page hides Recommended For You when empty", async () => {
    state.recommended = [];
    const HomePage = (await import("../../app/page")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.doesNotMatch(html, /Recommended For You/);
});

