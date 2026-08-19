import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(async () => {
    await GlobalRegistrator.unregister();
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
        imageUrl: "https://example.com/cover.jpg",
        trackCount: 12,
    },
];

async function renderIntoDom(t: {
    after: (fn: () => Promise<void> | void) => void;
}) {
    const { createRoot } = await import("react-dom/client");
    const { FeaturedPlaylistsGrid } =
        await import("../../features/home/components/FeaturedPlaylistsGrid");
    const container = document.createElement("div");
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => {
            root.unmount();
        });
    });
    await React.act(async () => {
        root.render(
            React.createElement(FeaturedPlaylistsGrid, {
                playlists,
            } as never),
        );
    });
    return container;
}

test("renders playlist cards with artwork only — no overlaid controls", async (t) => {
    const container = await renderIntoDom(t);

    const card = container.querySelector("[data-tv-card]");
    assert.ok(card, "expected a playlist card to render");
    assert.match(card.textContent ?? "", /Community Favorites/);
    assert.match(card.textContent ?? "", /12 songs/);
    assert.equal(card.getAttribute("tabindex"), "0");

    // Behavioral invariant: nothing interactive or decorative sits on top
    // of the artwork. The artwork wrapper holds exactly the image (or the
    // fallback icon) and no buttons or overlay elements of any styling.
    const artworkWrapper = card.querySelector("img")?.parentElement;
    assert.ok(artworkWrapper, "expected the artwork wrapper to render");
    assert.equal(artworkWrapper.children.length, 1);
    assert.equal(artworkWrapper.children[0]?.tagName.toLowerCase(), "img");
    assert.equal(card.querySelectorAll("button").length, 0);
    assert.equal(card.querySelectorAll("svg").length, 0);
});

test("clicking a card navigates to the playlist page", async (t) => {
    const container = await renderIntoDom(t);

    const card = container.querySelector("[data-tv-card]");
    assert.ok(card, "expected a playlist card to render");

    await React.act(async () => {
        card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(pushCalls, ["/explore/yt-playlist/pl-1"]);
});
