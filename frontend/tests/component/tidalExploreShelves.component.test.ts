import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const marker = (label: string) => {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
    },
});

mock.module("lucide-react", {
    namedExports: {},
});

mock.module("next/link", {
    defaultExport: ({ children, href }: { children: React.ReactNode; href: string }) =>
        React.createElement("a", { href }, children),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTidalBrowseImageUrl: (url: string) => `/api/browse/tidal/image?url=${encodeURIComponent(url)}`,
        },
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: { TidalBadge: marker("tidal-badge") },
});

test("TidalFeaturedShelvesSection renders home + explore shelves", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [
                { title: "For You", contents: [{ type: "playlist", playlistId: "abc", title: "Playlist A", thumbnailUrl: "http://img.test/a.jpg" }] },
            ],
            exploreShelves: [
                { title: "New Releases", contents: [{ type: "album", albumId: "xyz", title: "Album X", thumbnailUrl: null }] },
            ],
        })
    );

    assert.match(html, /For You/);
    assert.match(html, /New Releases/);
    assert.match(html, /Playlist A/);
    assert.match(html, /Album X/);
});

test("TidalFeaturedShelvesSection returns null when no shelves", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [],
            exploreShelves: [],
        })
    );
    assert.equal(html, "");
});

test("TidalFeaturedShelvesSection links playlists to /explore/tidal-playlist", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [
                { title: "Shelf", contents: [{ type: "playlist", playlistId: "PL1", title: "P", thumbnailUrl: null }] },
            ],
            exploreShelves: [],
        })
    );
    assert.match(html, /\/explore\/tidal-playlist\/PL1/);
});

test("TidalFeaturedShelvesSection links mixes to /explore/tidal-mix", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [
                { title: "Shelf", contents: [{ type: "mix", mixId: "MX1", title: "M", thumbnailUrl: null }] },
            ],
            exploreShelves: [],
        })
    );
    assert.match(html, /\/explore\/tidal-mix\/MX1/);
});

test("TidalFeaturedShelvesSection uses tidal image proxy for thumbnails", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [
                { title: "Shelf", contents: [{ type: "playlist", playlistId: "PL1", title: "P", thumbnailUrl: "https://resources.tidal.com/images/abc/123x123.jpg" }] },
            ],
            exploreShelves: [],
        })
    );
    assert.match(html, /\/api\/browse\/tidal\/image/);
});

test("TidalFeaturedShelvesSection hides Shortcuts shelf from homeShelves", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [
                { title: "Shortcuts", contents: [{ type: "playlist", playlistId: "sc1", title: "Shortcut Playlist", thumbnailUrl: null }] },
                { title: "For You", contents: [{ type: "playlist", playlistId: "fy1", title: "Good Playlist", thumbnailUrl: null }] },
            ],
            exploreShelves: [],
        })
    );
    assert.doesNotMatch(html, /Shortcut Playlist/, "Shortcuts shelf content is hidden");
    assert.match(html, /For You/, "Other shelves still render");
    assert.match(html, /Good Playlist/, "Other shelf content still renders");
});

test("TidalFeaturedShelvesSection hides Shortcuts shelf from exploreShelves (case-insensitive)", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [],
            exploreShelves: [
                { title: " shortcuts ", contents: [{ type: "playlist", playlistId: "sc2", title: "Explore Shortcut", thumbnailUrl: null }] },
                { title: "New Releases", contents: [{ type: "album", albumId: "nr1", title: "Album Z", thumbnailUrl: null }] },
            ],
        })
    );
    assert.doesNotMatch(html, /Explore Shortcut/, "Shortcuts content from exploreShelves is hidden");
    assert.match(html, /New Releases/, "Other explore shelves still render");
});

test("TidalFeaturedShelvesSection returns null when all shelves are hidden", async () => {
    const { TidalFeaturedShelvesSection } = await import(
        "../../features/explore/components/TidalFeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalFeaturedShelvesSection, {
            homeShelves: [
                { title: "Shortcuts", contents: [{ type: "playlist", playlistId: "sc1", title: "Only Shortcut", thumbnailUrl: null }] },
            ],
            exploreShelves: [],
        })
    );
    assert.equal(html, "", "returns null when only shelf is hidden");
});
