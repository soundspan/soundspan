import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    homeShelves: [{ title: "Featured", contents: [{ title: "item-1", playlistId: "PL123" }] }] as
        { title: string; contents: { title: string; playlistId?: string; videoId?: string; browseId?: string; type?: string }[] }[],
};

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
            getBrowseImageUrl: (url: string) => `/api/browse/image?url=${encodeURIComponent(url)}`,
        },
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: marker("yt-badge") },
});

beforeEach(() => {
    state.homeShelves = [{ title: "Featured", contents: [{ title: "item-1", playlistId: "PL123" }] }];
});

test("FeaturedShelvesSection renders shelves section when shelves exist", async () => {
    const { FeaturedShelvesSection } = await import(
        "../../features/explore/components/FeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(FeaturedShelvesSection, {
            homeShelves: state.homeShelves,
        })
    );

    assert.match(html, /Featured/);
});

test("FeaturedShelvesSection returns null when shelves empty", async () => {
    state.homeShelves = [];
    const { FeaturedShelvesSection } = await import(
        "../../features/explore/components/FeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(FeaturedShelvesSection, {
            homeShelves: state.homeShelves,
        })
    );

    assert.equal(html, "");
});

test("FeaturedShelvesSection shelf items link to /explore/yt-playlist", async () => {
    const { FeaturedShelvesSection } = await import(
        "../../features/explore/components/FeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(FeaturedShelvesSection, {
            homeShelves: state.homeShelves,
        })
    );

    assert.match(html, /\/explore\/yt-playlist\/PL123/);
    assert.doesNotMatch(html, /\/browse/);
});

test("FeaturedShelvesSection filters out video-only shelves", async () => {
    state.homeShelves = [{ title: "Videos", contents: [{ title: "video-1", videoId: "VID456" }] }];
    const { FeaturedShelvesSection } = await import(
        "../../features/explore/components/FeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(FeaturedShelvesSection, {
            homeShelves: state.homeShelves,
        })
    );

    assert.equal(html, "");
});

test("FeaturedShelvesSection filters out shelves with no navigable items", async () => {
    state.homeShelves = [{ title: "Misc", contents: [{ title: "no-link-item" }] }];
    const { FeaturedShelvesSection } = await import(
        "../../features/explore/components/FeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(FeaturedShelvesSection, {
            homeShelves: state.homeShelves,
        })
    );

    assert.equal(html, "");
});

test("FeaturedShelvesSection links browseId album items with type=album", async () => {
    state.homeShelves = [{ title: "Albums", contents: [{ title: "album-1", browseId: "MPREb_abc", type: "album" }] }];
    const { FeaturedShelvesSection } = await import(
        "../../features/explore/components/FeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(FeaturedShelvesSection, {
            homeShelves: state.homeShelves,
        })
    );

    assert.match(html, /\/explore\/yt-playlist\/MPREb_abc\?type=album/);
});

test("FeaturedShelvesSection filters out browseId shelves that are not albums", async () => {
    state.homeShelves = [{ title: "Artists", contents: [{ title: "artist-1", browseId: "UCabc", type: "artist" }] }];
    const { FeaturedShelvesSection } = await import(
        "../../features/explore/components/FeaturedShelvesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(FeaturedShelvesSection, {
            homeShelves: state.homeShelves,
        })
    );

    assert.equal(html, "");
});
