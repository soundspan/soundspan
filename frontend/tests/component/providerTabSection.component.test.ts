/**
 * Component tests for ProviderTabSection.
 *
 * Verifies tab bar rendering, single-provider direct rendering,
 * and empty output when both providers are disabled.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const marker = (label: string) => {
    const Component = (_props?: Record<string, unknown>) =>
        React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

const Icon = () => React.createElement("i");

mock.module("@/features/explore/components/MoodsGenresSection", {
    namedExports: { MoodsGenresSection: marker("moods-genres-section") },
});

mock.module("@/features/explore/components/FeaturedShelvesSection", {
    namedExports: { FeaturedShelvesSection: marker("featured-shelves-section") },
});

mock.module("@/features/explore/components/YtMusicMixesSection", {
    namedExports: { YtMusicMixesSection: marker("ytmusic-mixes-section") },
});

mock.module("@/features/explore/components/TidalMixesSection", {
    namedExports: { TidalMixesSection: marker("tidal-mixes-section") },
});

mock.module("@/features/explore/components/TidalMoodsGenresSection", {
    namedExports: { TidalMoodsGenresSection: marker("tidal-moods-genres") },
});

mock.module("@/features/explore/components/TidalFeaturedShelvesSection", {
    namedExports: { TidalFeaturedShelvesSection: marker("tidal-featured-shelves") },
});

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("@/features/home/components/FeaturedPlaylistsGrid", {
    namedExports: { FeaturedPlaylistsGrid: marker("featured-playlists-grid") },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: marker("yt-badge") },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        mapYtMusicChartsToFeaturedPlaylists: () => [],
    },
});

mock.module("lucide-react", {
    namedExports: { Music2: Icon },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            get: async () => ({}),
            getBrowseImageUrl: (url: string) => url,
            getTidalBrowseImageUrl: (url: string) => url,
            getTidalGenrePlaylists: async () => ({ playlists: [] }),
        },
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: marker("gradient-spinner") },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: { TidalBadge: marker("tidal-badge") },
});

const baseProps = {
    showYtMusicExplore: true,
    showTidalExplore: true,
    ytMusicMixes: [],
    moodCategories: [],
    genreCategories: [],
    isMoodsLoading: false,
    homeShelves: [],
    chartPlaylists: [{ id: "c1", title: "Chart 1" }],
    tidalMixes: [],
    tidalMoods: [],
    tidalGenres: [],
    tidalHomeShelves: [],
    tidalExploreShelves: [],
};

test("ProviderTabSection: both providers enabled renders tab bar with both labels", async () => {
    const { ProviderTabSection } = await import(
        "../../features/explore/components/ProviderTabSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(ProviderTabSection, baseProps)
    );

    assert.match(html, /YouTube Music/);
    assert.match(html, /TIDAL/);
    // Default tab is YouTube — its content should render
    assert.match(html, /moods-genres-section/);
    assert.match(html, /featured-shelves-section/);
});

test("ProviderTabSection: only YouTube enabled renders content without tab bar", async () => {
    const { ProviderTabSection } = await import(
        "../../features/explore/components/ProviderTabSection"
    );
    const props = { ...baseProps, showTidalExplore: false };
    const html = renderToStaticMarkup(
        React.createElement(ProviderTabSection, props)
    );

    // YouTube content present
    assert.match(html, /moods-genres-section/);
    assert.match(html, /featured-shelves-section/);
    // No tab bar labels
    assert.doesNotMatch(html, /YouTube Music/);
    assert.doesNotMatch(html, /TIDAL/);
    // No TIDAL content
    assert.doesNotMatch(html, /tidal-mixes-section/);
    assert.doesNotMatch(html, /tidal-moods-genres/);
});

test("ProviderTabSection: only TIDAL enabled renders content without tab bar", async () => {
    const { ProviderTabSection } = await import(
        "../../features/explore/components/ProviderTabSection"
    );
    const props = { ...baseProps, showYtMusicExplore: false };
    const html = renderToStaticMarkup(
        React.createElement(ProviderTabSection, props)
    );

    // TIDAL content present
    assert.match(html, /tidal-mixes-section/);
    assert.match(html, /tidal-featured-shelves/);
    // No tab bar labels
    assert.doesNotMatch(html, /YouTube Music/);
    assert.doesNotMatch(html, /TIDAL/);
    // No YouTube content
    assert.doesNotMatch(html, /moods-genres-section/);
    assert.doesNotMatch(html, /featured-shelves-section/);
});

test("ProviderTabSection: neither provider enabled renders empty", async () => {
    const { ProviderTabSection } = await import(
        "../../features/explore/components/ProviderTabSection"
    );
    const props = {
        ...baseProps,
        showYtMusicExplore: false,
        showTidalExplore: false,
    };
    const html = renderToStaticMarkup(
        React.createElement(ProviderTabSection, props)
    );

    assert.equal(html, "");
});
