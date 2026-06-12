import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    moodCategories: [{ title: "Chill", items: [{ title: "Lo-Fi", params: "chill-lofi" }] }],
    genreCategories: [{ title: "Rock", items: [{ title: "Classic Rock", params: "classic-rock" }] }],
    isLoading: false,
};

const marker = (label: string) => {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

const Icon = () => React.createElement("i");

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Music2: Icon,
    },
});

mock.module("next/link", {
    defaultExport: ({ children, href }: { children: React.ReactNode; href: string }) =>
        React.createElement("a", { href }, children),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            get: async () => ({
                playlists: [
                    { playlistId: "pl-1", title: "Chill Vibes", thumbnailUrl: null, author: "YT Music" },
                ],
                source: "ytmusic",
            }),
            getBrowseImageUrl: (url: string) => `/api/browse/image?url=${encodeURIComponent(url)}`,
        },
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: marker("spinner"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: marker("yt-badge") },
});

beforeEach(() => {
    state.moodCategories = [{ title: "Chill", items: [{ title: "Lo-Fi", params: "chill-lofi" }] }];
    state.genreCategories = [{ title: "Rock", items: [{ title: "Classic Rock", params: "classic-rock" }] }];
    state.isLoading = false;
});

test("MoodsGenresSection renders mood categories section", async () => {
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: state.isLoading,
        })
    );

    assert.match(html, /Moods/);
});

test("MoodsGenresSection renders genre categories section", async () => {
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: state.isLoading,
        })
    );

    assert.match(html, /Genres/);
});

test("MoodsGenresSection hides moods section when no mood categories", async () => {
    state.moodCategories = [];
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: false,
        })
    );

    assert.doesNotMatch(html, /Moods/);
    assert.match(html, /Genres/);
});

test("MoodsGenresSection hides genres section when no genre categories", async () => {
    state.genreCategories = [];
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: false,
        })
    );

    assert.match(html, /Moods/);
    assert.doesNotMatch(html, /Genres/);
});

test("MoodsGenresSection renders category pill buttons with params", async () => {
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: false,
        })
    );

    assert.match(html, /Lo-Fi/);
    assert.match(html, /Classic Rock/);
});

test("MoodsGenresSection does not contain /browse links in initial render", async () => {
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: false,
        })
    );

    assert.doesNotMatch(html, /\/browse/);
});

test("MoodsGenresSection returns null when both categories empty and not loading", async () => {
    state.moodCategories = [];
    state.genreCategories = [];
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: false,
        })
    );

    assert.equal(html, "");
});

test("MoodsGenresSection does not return null while loading (preserves layout space)", async () => {
    state.moodCategories = [];
    state.genreCategories = [];
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: true,
        })
    );

    // While loading with empty data, component renders container (not null)
    assert.ok(html.length > 0, "renders non-empty HTML while loading");
});

test("MoodsGenresSection does not render radio stations section", async () => {
    const { MoodsGenresSection } = await import(
        "../../features/explore/components/MoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MoodsGenresSection, {
            moodCategories: state.moodCategories,
            genreCategories: state.genreCategories,
            isLoading: false,
        })
    );

    assert.doesNotMatch(html, /Radio Stations/);
    assert.doesNotMatch(html, /library-radio-stations/);
});
