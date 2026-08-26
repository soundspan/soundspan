import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("renders the title at the shared section scale", async () => {
    const { SectionHeader } =
        await import("../../components/layout/SectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SectionHeader, { title: "Top Podcasts" }),
    );
    assert.match(html, /<h2 class="text-2xl font-bold text-white">/);
    assert.match(html, /Top Podcasts/);
});

test("renders a Show all link when showAllHref is set", async () => {
    const { SectionHeader } =
        await import("../../components/layout/SectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SectionHeader, {
            title: "Made For You",
            showAllHref: "/explore/playlists",
        }),
    );
    assert.match(html, /href="\/explore\/playlists"/);
    assert.match(html, /Show all/);
});

test("rightAction replaces the Show all link", async () => {
    const { SectionHeader } =
        await import("../../components/layout/SectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SectionHeader, {
            title: "By Genre",
            showAllHref: "/never",
            rightAction: React.createElement("button", null, "Refresh"),
        }),
    );
    assert.doesNotMatch(html, /href="\/never"/);
    assert.match(html, /Refresh/);
});

test("renders an optional description under the title row", async () => {
    const { SectionHeader } =
        await import("../../components/layout/SectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SectionHeader, {
            title: "Quick Start",
            description: "Open a ready-made station from your library",
        }),
    );
    assert.match(html, /Open a ready-made station from your library/);
    assert.match(html, /text-sm text-white\/50/);
});

test("accepts a ReactNode title for linked section headings", async () => {
    const { SectionHeader } =
        await import("../../components/layout/SectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SectionHeader, {
            title: React.createElement(
                "a",
                { href: "/search?view=tracks" },
                "Songs",
            ),
        }),
    );
    assert.match(
        html,
        /<h2[^>]*><a href="\/search\?view=tracks">Songs<\/a><\/h2>/,
    );
});

test("sm size renders the subsection scale", async () => {
    const { SectionHeader } =
        await import("../../components/layout/SectionHeader");
    const html = renderToStaticMarkup(
        React.createElement(SectionHeader, {
            title: "Linked Devices",
            size: "sm",
        }),
    );
    assert.match(html, /<h2 class="text-xl font-bold text-white">/);
    const md = renderToStaticMarkup(
        React.createElement(SectionHeader, { title: "Linked Devices" }),
    );
    assert.match(md, /<h2 class="text-2xl font-bold text-white">/);
});
