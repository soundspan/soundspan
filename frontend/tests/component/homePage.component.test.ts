import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    isLoading: false,
    isRefreshingMixes: false,
    isBrowseLoading: false,
    recentlyListened: [{ id: "listen-1" }],
    recentlyAdded: [{ id: "artist-1" }],
    recommended: [{ id: "artist-2" }],
    mixes: [{ id: "mix-1" }],
    popularArtists: [{ id: "artist-3" }],
    recentPodcasts: [{ id: "podcast-1" }],
    recentAudiobooks: [{ id: "book-1" }],
    featuredPlaylists: [{ id: "playlist-1" }],
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
            popularArtists: state.popularArtists,
            recentPodcasts: state.recentPodcasts,
            recentAudiobooks: state.recentAudiobooks,
            featuredPlaylists: state.featuredPlaylists,
            isLoading: state.isLoading,
            isRefreshingMixes: state.isRefreshingMixes,
            isBrowseLoading: state.isBrowseLoading,
            handleRefreshMixes: async () => undefined,
        }),
    },
});

mock.module("@/components/ui/LoadingScreen", {
    namedExports: {
        LoadingScreen: marker("loading-screen"),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: marker("gradient-spinner"),
    },
});

mock.module("@/features/home/components/HomeHero", {
    namedExports: {
        HomeHero: marker("home-hero"),
    },
});

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("@/features/home/components/ContinueListening", {
    namedExports: {
        ContinueListening: marker("continue-listening"),
    },
});

mock.module("@/features/home/components/ArtistsGrid", {
    namedExports: {
        ArtistsGrid: marker("artists-grid"),
    },
});

mock.module("@/features/home/components/MixesGrid", {
    namedExports: {
        MixesGrid: marker("mixes-grid"),
    },
});

mock.module("@/features/home/components/PopularArtistsGrid", {
    namedExports: {
        PopularArtistsGrid: marker("popular-artists-grid"),
    },
});

mock.module("@/features/home/components/PodcastsGrid", {
    namedExports: {
        PodcastsGrid: marker("podcasts-grid"),
    },
});

mock.module("@/features/home/components/AudiobooksGrid", {
    namedExports: {
        AudiobooksGrid: marker("audiobooks-grid"),
    },
});

mock.module("@/features/home/components/FeaturedPlaylistsGrid", {
    namedExports: {
        FeaturedPlaylistsGrid: marker("featured-playlists-grid"),
    },
});

mock.module("@/features/home/components/LibraryRadioStations", {
    namedExports: {
        LibraryRadioStations: marker("library-radio-stations"),
    },
});

mock.module("lucide-react", {
    namedExports: {
        RefreshCw: Icon,
        AudioWaveform: Icon,
    },
});

beforeEach(() => {
    state.isLoading = false;
    state.isRefreshingMixes = false;
    state.isBrowseLoading = false;
    state.recentlyListened = [{ id: "listen-1" }];
    state.recentlyAdded = [{ id: "artist-1" }];
    state.recommended = [{ id: "artist-2" }];
    state.mixes = [{ id: "mix-1" }];
    state.popularArtists = [{ id: "artist-3" }];
    state.recentPodcasts = [{ id: "podcast-1" }];
    state.recentAudiobooks = [{ id: "book-1" }];
    state.featuredPlaylists = [{ id: "playlist-1" }];
});

test("home page renders loading screen while home data is loading", async () => {
    state.isLoading = true;
    const HomePage = (await import("../../app/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /loading-screen/);
    assert.doesNotMatch(html, /Library Radio/);
});

test("home page keeps all visible sections with populated data", async () => {
    const HomePage = (await import("../../app/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /Library Radio/);
    assert.match(html, /Continue Listening/);
    assert.match(html, /Recently Added/);
    assert.match(html, /Made For You/);
    assert.match(html, /Recommended For You/);
    assert.match(html, /Popular Artists/);
    assert.match(html, /Featured Playlists/);
    assert.match(html, /Popular Podcasts/);
    assert.match(html, /Audiobooks/);
    assert.match(html, /featured-playlists-grid/);
    assert.match(html, /audiobooks-grid/);
});

test("featured playlists section remains visible while browse data is loading", async () => {
    state.isBrowseLoading = true;
    state.featuredPlaylists = [];

    const HomePage = (await import("../../app/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(HomePage));

    assert.match(html, /Featured Playlists/);
});
