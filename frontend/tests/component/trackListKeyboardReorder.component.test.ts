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

const items = [
    { id: "track-1", title: "First Track", artist: "First Artist" },
    { id: "track-2", title: "Second Track", artist: "Second Artist" },
    { id: "track-3", title: "Third Track", artist: "Third Artist" },
];

function toRowItem(item: (typeof items)[number]) {
    return {
        id: item.id,
        title: item.title,
        artistName: item.artist,
        duration: 180,
        coverArtUrl: null,
    };
}

async function mountTrackList(
    reorderCalls: Array<[number, number]>,
    playCalls: string[],
) {
    const { createRoot } = await import("react-dom/client");
    const { TrackList } = await import("../../components/track");
    const TypedTrackList = TrackList<(typeof items)[number]>;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(TypedTrackList, {
                items,
                toRowItem,
                onPlay: (item: (typeof items)[number]) =>
                    playCalls.push(item.id),
                reorder: {
                    onReorder: (from: number, to: number) =>
                        reorderCalls.push([from, to]),
                },
            }),
        );
    });

    return { container, root };
}

async function unmount(mounted: Awaited<ReturnType<typeof mountTrackList>>) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

test("each reorder grip is a labelled button", async () => {
    const mounted = await mountTrackList([], []);
    const grips = mounted.container.querySelectorAll(
        'button[aria-label*="Reorder"]',
    );

    assert.equal(grips.length, 3);
    await unmount(mounted);
});

test("reorder grip supports ArrowDown and ignores ArrowUp at the first boundary", async () => {
    const reorderCalls: Array<[number, number]> = [];
    const mounted = await mountTrackList(reorderCalls, []);
    const grip = mounted.container.querySelector(
        'button[aria-label*="Reorder"]',
    ) as HTMLButtonElement | null;
    assert.ok(grip);

    grip.focus();
    await React.act(async () => {
        grip.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    await React.act(async () => {
        grip.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
        );
    });

    assert.deepEqual(reorderCalls, [[0, 1]]);
    await unmount(mounted);
});

test("track row exposes button semantics and plays on Space", async () => {
    const playCalls: string[] = [];
    const mounted = await mountTrackList([], playCalls);
    const row = mounted.container.querySelector(
        '[data-tv-card][role="button"][aria-label^="Play"]',
    ) as HTMLElement | null;
    assert.ok(row);

    await React.act(async () => {
        row.dispatchEvent(
            new KeyboardEvent("keydown", { key: " ", bubbles: true }),
        );
    });

    assert.deepEqual(playCalls, ["track-1"]);
    await unmount(mounted);
});
