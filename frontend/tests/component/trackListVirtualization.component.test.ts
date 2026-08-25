import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Icon = (props: Record<string, unknown>) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        AudioLines: Icon,
        GripVertical: Icon,
        Music: Icon,
        Play: Icon,
    },
});

mock.module("@/utils/formatTime", {
    namedExports: { formatTime: (seconds: number) => `t:${seconds}` },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ src, alt }: { src: string; alt: string }) =>
            React.createElement("img", { src, alt }),
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: { TrackOverflowMenu: () => null },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: { TrackPreferenceButtons: () => null },
});

mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: () => ({ currentTrack: null }) },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: { useQueuedTrackIds: () => new Set() },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

interface Item {
    id: string;
    title: string;
    artist: string;
}

function makeItems(count: number): Item[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `track-${i + 1}`,
        title: `Track ${i + 1}`,
        artist: `Artist ${i + 1}`,
    }));
}

function toRowItem(item: Item) {
    return {
        id: item.id,
        title: item.title,
        artistName: item.artist,
        duration: 180,
        coverArtUrl: null,
    };
}

interface MountOptions {
    itemCount: number;
    virtualized?: boolean;
    withReorder?: boolean;
    insideScrollContainer?: boolean;
    tvSection?: string;
    className?: string;
}

async function mountTrackList(options: MountOptions) {
    const { createRoot } = await import("react-dom/client");
    const { TrackList } = await import("../../components/track");
    const TypedTrackList = TrackList<Item>;

    const host = document.createElement("div");
    if (options.insideScrollContainer) {
        host.setAttribute("data-app-scroll-container", "");
    }
    document.body.appendChild(host);
    const container = document.createElement("div");
    host.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(TypedTrackList, {
                items: makeItems(options.itemCount),
                toRowItem,
                onPlay: () => undefined,
                virtualized: options.virtualized,
                tvSection: options.tvSection,
                className: options.className,
                reorder: options.withReorder
                    ? { onReorder: () => undefined }
                    : undefined,
            }),
        );
    });

    return { container, host, root };
}

async function unmount(mounted: Awaited<ReturnType<typeof mountTrackList>>) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.host.remove();
}

function queryScroller(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>("[data-virtuoso-scroller]");
}

test("lists above the threshold window their rows automatically", async () => {
    const mounted = await mountTrackList({ itemCount: 250 });

    assert.ok(
        queryScroller(mounted.container),
        "expected the windowed render path",
    );
    const mountedRows =
        mounted.container.querySelectorAll("[data-track-id]").length;
    assert.equal(
        mountedRows,
        20,
        "the initial pass mounts exactly the 20-row window",
    );
    await unmount(mounted);
});

test("TV sections never auto-virtualize", async () => {
    const mounted = await mountTrackList({
        itemCount: 250,
        tvSection: "tracks",
    });

    assert.equal(queryScroller(mounted.container), null);
    assert.equal(
        mounted.container.querySelectorAll("[data-track-id]").length,
        250,
    );
    await unmount(mounted);
});

test("caller className keeps styling the element that wraps the rows", async () => {
    const mounted = await mountTrackList({
        itemCount: 250,
        className: "space-y-1",
    });
    const list = mounted.container.querySelector(
        '[data-virtuoso-scroller] [data-testid="virtuoso-item-list"]',
    );

    assert.ok(list, "expected Virtuoso's item list");
    assert.ok(
        list.className.includes("space-y-1"),
        "divide/space utilities must land on the row wrapper parent",
    );
    await unmount(mounted);
});

test("small lists render every row without windowing", async () => {
    const mounted = await mountTrackList({ itemCount: 50 });

    assert.equal(queryScroller(mounted.container), null);
    assert.equal(
        mounted.container.querySelectorAll("[data-track-id]").length,
        50,
    );
    await unmount(mounted);
});

test("reorderable lists never auto-virtualize", async () => {
    const mounted = await mountTrackList({ itemCount: 250, withReorder: true });

    assert.equal(queryScroller(mounted.container), null);
    assert.equal(
        mounted.container.querySelectorAll("[data-track-id]").length,
        250,
    );
    await unmount(mounted);
});

test("an explicit virtualized=false pins the plain render path", async () => {
    const mounted = await mountTrackList({
        itemCount: 250,
        virtualized: false,
    });

    assert.equal(queryScroller(mounted.container), null);
    assert.equal(
        mounted.container.querySelectorAll("[data-track-id]").length,
        250,
    );
    await unmount(mounted);
});

test("windowed lists scroll with the app container when one is present", async () => {
    const mounted = await mountTrackList({
        itemCount: 250,
        insideScrollContainer: true,
    });
    const scroller = queryScroller(mounted.container);

    assert.ok(scroller);
    // With a custom scroll parent Virtuoso sizes the scroller to its content
    // so the list participates in the page's own scrolling instead of the
    // 600px bounded box.
    assert.notEqual(scroller.style.height, "600px");
    await unmount(mounted);
});

test("windowed lists fall back to a bounded box without an app scroll container", async () => {
    const mounted = await mountTrackList({ itemCount: 250 });
    const scroller = queryScroller(mounted.container);

    assert.ok(scroller);
    assert.equal(scroller.style.height, "600px");
    await unmount(mounted);
});
