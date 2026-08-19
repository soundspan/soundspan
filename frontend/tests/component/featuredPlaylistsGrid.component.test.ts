import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    GlobalRegistrator.unregister();
});

const pushCalls: string[] = [];

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: (url: string) => {
                pushCalls.push(url);
            },
        }),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Music2: () => React.createElement("svg", { "data-icon": "music2" }),
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

beforeEach(() => {
    pushCalls.length = 0;
});

const playlists = [
    {
        id: "pl-1",
        title: "Community Favorites",
        type: "playlist",
        imageUrl: "",
        trackCount: 12,
    },
];

async function renderGrid() {
    const { FeaturedPlaylistsGrid } =
        await import("../../features/home/components/FeaturedPlaylistsGrid");
    return renderToStaticMarkup(
        React.createElement(FeaturedPlaylistsGrid, {
            playlists,
        } as never),
    );
}

test("renders playlist cards without a play-button affordance", async () => {
    const html = await renderGrid();

    assert.match(html, /Community Favorites/);
    assert.match(html, /12 songs/);
    assert.match(html, /data-tv-card/);
    assert.match(html, /tabindex="0"/i);
    assert.doesNotMatch(html, /bg-brand-hover/);
    assert.doesNotMatch(html, /M8 5v14l11-7z/);
    assert.doesNotMatch(html, /animate-spin/);
});

test("clicking a card navigates to the playlist page", async () => {
    const { createRoot } = await import("react-dom/client");
    const { FeaturedPlaylistsGrid } =
        await import("../../features/home/components/FeaturedPlaylistsGrid");
    const container = document.createElement("div");
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(FeaturedPlaylistsGrid, {
                playlists,
            } as never),
        );
    });

    const card = container.querySelector("[data-tv-card]");
    assert.ok(card, "expected a playlist card to render");

    await React.act(async () => {
        card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(pushCalls, ["/explore/yt-playlist/pl-1"]);

    await React.act(async () => {
        root.unmount();
    });
});
