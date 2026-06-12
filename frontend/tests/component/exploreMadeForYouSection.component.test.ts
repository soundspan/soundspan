import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
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
    mixes: [{ id: "mix-1", name: "Daily Mix 1", description: "desc", coverUrls: [], trackCount: 10 }],
    isRefreshingMixes: false,
};

const marker = (label: string) => {
    const Component = () => React.createElement("div", null, label);
    Component.displayName = `Mock${label.replace(/[^a-zA-Z0-9]/g, "")}`;
    return Component;
};

const Icon = () => React.createElement("i");

mock.module("@/features/home/components/SectionHeader", {
    namedExports: {
        SectionHeader: ({ title, rightAction }: { title: string; rightAction?: React.ReactNode }) =>
            React.createElement("h2", null, title, rightAction),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: marker("gradient-spinner") },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ alt }: { alt?: string }) =>
            React.createElement("img", { alt: alt ?? "" }),
    },
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

mock.module("next/link", {
    defaultExport: ({ children, href }: { children: React.ReactNode; href: string }) =>
        React.createElement("a", { href }, children),
});

mock.module("lucide-react", {
    namedExports: { RefreshCw: Icon, AudioWaveform: Icon, Heart: Icon, Compass: Icon },
});

beforeEach(() => {
    state.likedSummary = { total: 42, coverUrl: "/covers/liked.jpg" };
    state.discoverWeekly = {
        weekStart: "2026-02-24",
        weekEnd: "2026-03-02",
        totalCount: 25,
        coverUrl: "/covers/discover.jpg",
    };
    state.mixes = [{ id: "mix-1", name: "Daily Mix 1", description: "desc", coverUrls: [], trackCount: 10 }];
    state.isRefreshingMixes = false;
});

test("MadeForYouSection renders My Liked card in Made For You carousel", async () => {
    const { MadeForYouSection } = await import(
        "../../features/explore/components/MadeForYouSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            mixes: state.mixes,
            isRefreshingMixes: state.isRefreshingMixes,
            handleRefreshMixes: async () => undefined,
        })
    );

    assert.match(html, /Made For You/);
    assert.match(html, /My Liked/);
    assert.match(html, /42 tracks/);
});

test("MadeForYouSection renders Discover Weekly card in Made For You carousel", async () => {
    const { MadeForYouSection } = await import(
        "../../features/explore/components/MadeForYouSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            mixes: state.mixes,
            isRefreshingMixes: state.isRefreshingMixes,
            handleRefreshMixes: async () => undefined,
        })
    );

    assert.match(html, /Discover Weekly/);
    assert.match(html, /25 tracks/);
});

test("MadeForYouSection renders mix cards alongside static cards in carousel", async () => {
    const { MadeForYouSection } = await import(
        "../../features/explore/components/MadeForYouSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            mixes: state.mixes,
            isRefreshingMixes: state.isRefreshingMixes,
            handleRefreshMixes: async () => undefined,
        })
    );

    assert.match(html, /My Liked/);
    assert.match(html, /Discover Weekly/);
    assert.match(html, /mix-card:Daily Mix 1/);
});

test("MadeForYouSection returns null when all sources empty", async () => {
    state.likedSummary = null;
    state.discoverWeekly = null;
    state.mixes = [];
    const { MadeForYouSection } = await import(
        "../../features/explore/components/MadeForYouSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            mixes: state.mixes,
            isRefreshingMixes: false,
            handleRefreshMixes: async () => undefined,
        })
    );

    assert.doesNotMatch(html, /Made For You/);
});

test("MadeForYouSection shows Made For You with only static cards (no mixes)", async () => {
    state.mixes = [];
    const { MadeForYouSection } = await import(
        "../../features/explore/components/MadeForYouSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            mixes: state.mixes,
            isRefreshingMixes: false,
            handleRefreshMixes: async () => undefined,
        })
    );

    assert.match(html, /Made For You/);
    assert.match(html, /My Liked/);
    assert.match(html, /Discover Weekly/);
});

test("MadeForYouSection shows Made For You with only mixes (no static cards)", async () => {
    state.likedSummary = null;
    state.discoverWeekly = null;
    const { MadeForYouSection } = await import(
        "../../features/explore/components/MadeForYouSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            mixes: state.mixes,
            isRefreshingMixes: false,
            handleRefreshMixes: async () => undefined,
        })
    );

    assert.match(html, /Made For You/);
    assert.match(html, /mix-card:Daily Mix 1/);
});

test("MadeForYouSection shows spinner and Refreshing text when refreshing mixes", async () => {
    state.isRefreshingMixes = true;
    const { MadeForYouSection } = await import(
        "../../features/explore/components/MadeForYouSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(MadeForYouSection, {
            likedSummary: state.likedSummary,
            discoverWeekly: state.discoverWeekly,
            mixes: state.mixes,
            isRefreshingMixes: state.isRefreshingMixes,
            handleRefreshMixes: async () => undefined,
        })
    );

    assert.match(html, /gradient-spinner/);
    assert.match(html, /Refreshing\.\.\./);
    assert.match(html, /disabled/);
});

