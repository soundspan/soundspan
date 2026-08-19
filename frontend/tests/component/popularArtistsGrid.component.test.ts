import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("lucide-react", {
    namedExports: {
        Music: () => React.createElement("svg", { "data-icon": "music" }),
    },
});

mock.module("next/image", {
    defaultExport: ({ alt }: { alt?: string }) =>
        React.createElement("img", { alt }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => `/proxied/${url}`,
        },
    },
});

mock.module("@/components/ui/HorizontalCarousel", {
    namedExports: {
        HorizontalCarousel: ({ children }: { children?: React.ReactNode }) =>
            React.createElement("div", null, children),
        CarouselItem: ({ children }: { children?: React.ReactNode }) =>
            React.createElement("div", null, children),
    },
});

async function renderGrid(artists: Record<string, unknown>[]) {
    const { PopularArtistsGrid } =
        await import("../../features/home/components/PopularArtistsGrid");
    return renderToStaticMarkup(
        React.createElement(PopularArtistsGrid, { artists } as never),
    );
}

test("routes cards to the artist page by MBID", async () => {
    const html = await renderGrid([
        {
            id: "b49b81cc-d5b7-4bdd-aadb-385df8de69a6",
            name: "Drake",
            mbid: "b49b81cc-d5b7-4bdd-aadb-385df8de69a6",
            listeners: 5000000,
        },
    ]);

    assert.match(html, /href="\/artist\/b49b81cc-d5b7-4bdd-aadb-385df8de69a6"/);
    assert.doesNotMatch(html, /href="\/search/);
});

test("falls back to the encoded artist name without a usable MBID", async () => {
    const html = await renderGrid([
        { name: "AC/DC & Friends", listeners: 1 },
        { name: "Sigur Rós", mbid: "temp-123", listeners: 2 },
    ]);

    assert.match(html, /href="\/artist\/AC%2FDC%20%26%20Friends"/);
    assert.match(html, /href="\/artist\/Sigur%20R%C3%B3s"/);
    assert.doesNotMatch(html, /href="\/search/);
    assert.doesNotMatch(html, /temp-123/);
});
