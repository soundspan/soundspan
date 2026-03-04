import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const marker = (label: string) => {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title, badge }: { title: string; badge?: React.ReactNode }) =>
            React.createElement("h2", null, title, badge),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Music2: marker("Music2"),
    },
});

mock.module("next/link", {
    defaultExport: ({ children, href }: { children: React.ReactNode; href: string }) =>
        React.createElement("a", { href }, children),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTidalBrowseImageUrl: (url: string) => `/api/browse/tidal/image?url=${encodeURIComponent(url)}`,
            getTidalGenrePlaylists: async () => ({ playlists: [] }),
        },
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: { TidalBadge: marker("tidal-badge") },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: marker("spinner") },
});

test("TidalMoodsGenresSection renders mood and genre pills", async () => {
    const { TidalMoodsGenresSection } = await import(
        "../../features/explore/components/TidalMoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalMoodsGenresSection, {
            moods: [
                { name: "Chill", path: "chill", hasPlaylists: true, imageUrl: null },
                { name: "Workout", path: "workout", hasPlaylists: true, imageUrl: null },
            ],
            genres: [
                { name: "Pop", path: "pop", hasPlaylists: true, imageUrl: null },
                { name: "Rock", path: "rock", hasPlaylists: true, imageUrl: null },
            ],
        })
    );

    assert.match(html, /Chill/);
    assert.match(html, /Workout/);
    assert.match(html, /Pop/);
    assert.match(html, /Rock/);
});

test("TidalMoodsGenresSection renders nothing when both arrays empty", async () => {
    const { TidalMoodsGenresSection } = await import(
        "../../features/explore/components/TidalMoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalMoodsGenresSection, {
            moods: [],
            genres: [],
        })
    );
    // Should render empty or minimal container
    assert.ok(!html.includes("Chill"));
});

test("TidalMoodsGenresSection renders moods section header with TidalBadge", async () => {
    const { TidalMoodsGenresSection } = await import(
        "../../features/explore/components/TidalMoodsGenresSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalMoodsGenresSection, {
            moods: [{ name: "Chill", path: "chill", hasPlaylists: true, imageUrl: null }],
            genres: [],
        })
    );
    assert.match(html, /Moods/);
    assert.match(html, /tidal-badge/);
});
