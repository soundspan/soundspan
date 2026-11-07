import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
    }: {
        href: string;
        children?: React.ReactNode;
    }) => React.createElement("a", { href }, children),
});

mock.module("next/image", {
    defaultExport: ({ src, alt }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string, size: number) =>
                `/proxy?url=${encodeURIComponent(url)}&size=${size}`,
        },
    },
});

mock.module("@/components/layout/SectionHeader", {
    namedExports: {
        SectionHeader: ({
            title,
            description,
            badge,
        }: {
            title: string;
            description?: string;
            badge?: React.ReactNode;
        }) =>
            React.createElement(
                "header",
                null,
                React.createElement("h2", null, title),
                description
                    ? React.createElement("p", null, description)
                    : null,
                typeof badge === "string"
                    ? React.createElement("span", null, `badge:${badge}`)
                    : badge,
            ),
    },
});

mock.module("@/components/ui/HorizontalCarousel", {
    namedExports: {
        HorizontalCarousel: passthrough,
        CarouselItem: passthrough,
    },
});

mock.module("@/components/ui/LastFmBadge", {
    namedExports: {
        LastFmBadge: () => React.createElement("span", null, "badge:lastfm"),
    },
});

mock.module("@/utils/artistRoute", {
    namedExports: {
        getArtistRouteParam: (artist: { mbid?: string; name: string }) =>
            artist.mbid ?? null,
    },
});

mock.module("@/features/search/components/DiscoverTracksList", {
    namedExports: {
        DiscoverTracksList: ({
            tracks,
            limit,
        }: {
            tracks: Array<{ name: string }>;
            limit: number;
        }) =>
            React.createElement(
                "ol",
                { "data-limit": limit },
                tracks.map((track) =>
                    React.createElement("li", { key: track.name }, track.name),
                ),
            ),
    },
});

const RG_MBID = "6b9a9e04-abd7-4666-86ba-bb220ef4c3b2";

async function render(discovery: Record<string, unknown>) {
    const { ExploreDiscoverySection } =
        await import("../../features/explore/components/ExploreDiscoverySection");
    return renderToStaticMarkup(
        React.createElement(ExploreDiscoverySection, {
            discovery: {
                personalized: true,
                similarArtists: [],
                newReleases: [],
                trendingTracks: [],
                tagShelves: [],
                ...discovery,
            },
        } as never),
    );
}

test("renders nothing when every shelf is empty", async () => {
    assert.equal(await render({}), "");
});

test("renders personalized shelves linking to existing artist and album pages", async () => {
    const html = await render({
        similarArtists: [
            {
                name: "Massive Attack",
                mbid: "ma-mbid",
                image: "https://img/ma.jpg",
                because: "Portishead",
            },
            { name: "Elbow & Co", image: null },
        ],
        newReleases: [
            {
                rgMbid: RG_MBID,
                title: "Fresh LP",
                artistName: "Radiohead",
                releaseDate: "2026-10-01",
                coverUrl: "https://coverartarchive.org/rg/front-250",
            },
        ],
        trendingTracks: [
            { type: "track", id: "t1", name: "Hit", artist: "Pop Star" },
        ],
        tagShelves: [
            { tag: "trip-hop", artists: [{ name: "Tricky", image: null }] },
        ],
    });

    assert.match(html, /Artists You Might Like/);
    assert.match(html, /href="\/artist\/ma-mbid"/);
    assert.match(html, /Because you like Portishead/);
    assert.match(html, /href="\/artist\/Elbow%20%26%20Co"/);
    assert.match(html, /New Releases For You/);
    assert.match(html, /badge:MusicBrainz/);
    assert.match(html, new RegExp(`href="/album/${RG_MBID}"`));
    assert.match(html, /Radiohead • Oct 1, 2026/);
    assert.match(html, /Trending Now/);
    assert.match(html, /data-limit="10"/);
    assert.match(html, /<li>Hit<\/li>/);
    assert.match(html, /More Trip-Hop/);
});

test("labels tag shelves as popular for users without history", async () => {
    const html = await render({
        personalized: false,
        tagShelves: [{ tag: "rock", artists: [{ name: "Band", image: null }] }],
    });

    assert.match(html, /Popular in Rock/);
    assert.doesNotMatch(html, /Artists You Might Like/);
    assert.doesNotMatch(html, /New Releases For You/);
});
