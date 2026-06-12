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
        SectionHeader: ({ title }: { title: string }) =>
            React.createElement("h2", null, title),
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
        },
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: { TidalBadge: marker("tidal-badge") },
});

mock.module("@/components/ui/HorizontalCarousel", {
    namedExports: {
        HorizontalCarousel: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "carousel" }, children),
        CarouselItem: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "carousel-item" }, children),
    },
});

test("TidalMixesSection renders mixes with links to /explore/tidal-mix", async () => {
    const { TidalMixesSection } = await import(
        "../../features/explore/components/TidalMixesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalMixesSection, {
            mixes: [
                { mixId: "mix1", title: "My Daily Discovery", subTitle: "Updated daily", thumbnailUrl: "https://img.test/1.jpg" },
                { mixId: "mix2", title: "My Mix #1", subTitle: "Based on your taste", thumbnailUrl: null },
            ],
        })
    );

    assert.match(html, /TIDAL Mixes/);
    assert.match(html, /My Daily Discovery/);
    assert.match(html, /My Mix #1/);
    assert.match(html, /\/explore\/tidal-mix\/mix1/);
    assert.match(html, /\/explore\/tidal-mix\/mix2/);
});

test("TidalMixesSection returns null when mixes are empty", async () => {
    const { TidalMixesSection } = await import(
        "../../features/explore/components/TidalMixesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalMixesSection, { mixes: [] })
    );
    assert.equal(html, "");
});

test("TidalMixesSection proxies thumbnails through tidal image endpoint", async () => {
    const { TidalMixesSection } = await import(
        "../../features/explore/components/TidalMixesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalMixesSection, {
            mixes: [
                { mixId: "m1", title: "Mix", subTitle: "", thumbnailUrl: "https://resources.tidal.com/img.jpg" },
            ],
        })
    );
    assert.match(html, /\/api\/browse\/tidal\/image/);
});

test("TidalMixesSection uses HorizontalCarousel with CarouselItem wrappers", async () => {
    const { TidalMixesSection } = await import(
        "../../features/explore/components/TidalMixesSection"
    );
    const html = renderToStaticMarkup(
        React.createElement(TidalMixesSection, {
            mixes: [
                { mixId: "m1", title: "Mix A", subTitle: "", thumbnailUrl: null },
                { mixId: "m2", title: "Mix B", subTitle: "", thumbnailUrl: null },
            ],
        })
    );
    assert.match(html, /data-testid="carousel"/, "uses HorizontalCarousel");
    const itemCount = (html.match(/data-testid="carousel-item"/g) ?? []).length;
    assert.equal(itemCount, 2, "one CarouselItem per mix");
});
