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
        ListMusic: Icon,
        Music: Icon,
        Trash2: Icon,
        X: Icon,
    },
});

mock.module("next/image", {
    defaultExport: ({ src, alt }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt }),
});

mock.module("@/utils/formatTime", {
    namedExports: { formatTime: (seconds: number) => `t:${seconds}` },
});

mock.module("@/lib/api", {
    namedExports: {
        api: { getCoverArtUrl: (id: string) => `/cover/${id}` },
    },
});

mock.module("@/hooks/useStreamBitrate", {
    namedExports: {
        resolvePlaybackQualityBadgeFromStreamSource: () => null,
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: { TidalBadge: () => null },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: () => null },
});
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: { TrackPreferenceButtons: () => null },
});
mock.module("@/hooks/useTrackPreference", {
    namedExports: { buildPreferenceMetadata: () => ({}) },
});
mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: () => null,
        TrackMenuButton: () => null,
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

interface QueueFixtureTrack {
    id: string;
    title: string;
    itemType?: "track" | "episode";
    podcastTitle?: string;
    coverUrl?: string;
    duration: number;
    artist?: { name: string };
    album?: { title: string; coverArt?: string };
}

function makeQueue(count: number): QueueFixtureTrack[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `track-${i + 1}`,
        title: `Track ${i + 1}`,
        duration: 180,
        artist: { name: `Artist ${i + 1}` },
        album: { title: `Album ${i + 1}` },
    }));
}

interface MountOptions {
    queue: QueueFixtureTrack[];
    currentIndex?: number;
    onPlayFromQueue?: (index: number) => void;
    onRemoveFromQueue?: (index: number) => void;
    onClearQueue?: () => void;
}

async function mountQueueTab(options: MountOptions) {
    const { createRoot } = await import("react-dom/client");
    const { OverlayQueueTab } =
        await import("../../components/player/overlay-tabs/OverlayQueueTab");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(OverlayQueueTab, {
                queueTracks:
                    options.queue as unknown as import("@/lib/queue-item").QueueItem[],
                currentIndex: options.currentIndex ?? 0,
                onPlayFromQueue: options.onPlayFromQueue ?? (() => undefined),
                onRemoveFromQueue:
                    options.onRemoveFromQueue ?? (() => undefined),
                onClearQueue: options.onClearQueue ?? (() => undefined),
            }),
        );
    });

    return { container, root };
}

async function unmount(mounted: Awaited<ReturnType<typeof mountQueueTab>>) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

test("an empty queue shows the empty state and no clear button", async () => {
    const mounted = await mountQueueTab({ queue: [] });

    assert.ok(mounted.container.textContent?.includes("No tracks in queue."));
    assert.ok(mounted.container.textContent?.includes("0 items"));
    assert.equal(
        mounted.container.querySelector('button[title="Clear queue"]'),
        null,
    );
    await unmount(mounted);
});

test("long queues window their rows instead of mounting every row", async () => {
    const mounted = await mountQueueTab({ queue: makeQueue(300) });

    const rows = mounted.container.querySelectorAll("[data-queue-index]");
    assert.ok(rows.length > 0, "expected the initial window to mount rows");
    assert.ok(
        rows.length <= 40,
        `expected a windowed subset of 300 rows, got ${rows.length}`,
    );
    assert.ok(mounted.container.textContent?.includes("300 items"));
    await unmount(mounted);
});

test("the playing row pins Now playing and hides its remove control", async () => {
    const mounted = await mountQueueTab({
        queue: makeQueue(5),
        currentIndex: 1,
    });

    const currentRow = mounted.container.querySelector(
        '[data-queue-index="1"]',
    );
    assert.ok(currentRow, "expected the playing row to be mounted");
    assert.ok(currentRow.querySelector('button[title="Now playing"]'));
    assert.equal(
        currentRow.querySelector('button[title="Remove from queue"]'),
        null,
        "the playing row must not offer removal",
    );
    assert.ok(currentRow.textContent?.includes("Playing"));
    await unmount(mounted);
});

test("row actions dispatch play, remove, and clear callbacks", async () => {
    const played: number[] = [];
    const removed: number[] = [];
    let cleared = 0;
    const mounted = await mountQueueTab({
        queue: makeQueue(5),
        currentIndex: 0,
        onPlayFromQueue: (index) => played.push(index),
        onRemoveFromQueue: (index) => removed.push(index),
        onClearQueue: () => {
            cleared += 1;
        },
    });

    const secondRow = mounted.container.querySelector('[data-queue-index="2"]');
    assert.ok(secondRow);
    await React.act(async () => {
        secondRow
            .querySelector<HTMLButtonElement>(
                'button[title="Play this track now"]',
            )
            ?.click();
        secondRow
            .querySelector<HTMLButtonElement>(
                'button[title="Remove from queue"]',
            )
            ?.click();
        mounted.container
            .querySelector<HTMLButtonElement>('button[title="Clear queue"]')
            ?.click();
    });

    assert.deepEqual(played, [2]);
    assert.deepEqual(removed, [2]);
    assert.equal(cleared, 1);
    await unmount(mounted);
});

test("clicking the playing row does not restart it", async () => {
    const played: number[] = [];
    const mounted = await mountQueueTab({
        queue: makeQueue(3),
        currentIndex: 0,
        onPlayFromQueue: (index) => played.push(index),
    });

    await React.act(async () => {
        mounted.container
            .querySelector<HTMLButtonElement>('button[title="Now playing"]')
            ?.click();
    });

    assert.deepEqual(played, []);
    await unmount(mounted);
});

test("episode rows render podcast identity instead of track identity", async () => {
    const queue: QueueFixtureTrack[] = [
        ...makeQueue(1),
        {
            id: "ep-1",
            itemType: "episode",
            title: "Episode One",
            podcastTitle: "My Podcast",
            duration: 3600,
        },
    ];
    const mounted = await mountQueueTab({ queue, currentIndex: 0 });

    const episodeRow = mounted.container.querySelector(
        '[data-queue-index="1"]',
    );
    assert.ok(episodeRow);
    assert.ok(episodeRow.textContent?.includes("Episode One"));
    assert.ok(episodeRow.textContent?.includes("My Podcast"));
    assert.ok(
        episodeRow.querySelector('button[title="Play this episode now"]'),
    );
    await unmount(mounted);
});
