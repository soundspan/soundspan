import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const copied: string[] = [];

mock.module("lucide-react", {
    namedExports: {
        EllipsisVertical: trackOverflowIcon,
        Link: trackOverflowIcon,
        ListEnd: trackOverflowIcon,
        ListPlus: trackOverflowIcon,
        Map: trackOverflowIcon,
        Plus: trackOverflowIcon,
        Share2: trackOverflowIcon,
        User: trackOverflowIcon,
        Disc3: trackOverflowIcon,
        AudioWaveform: trackOverflowIcon,
        Radio: trackOverflowIcon,
    },
});

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTrack: () => undefined,
        startVibeMode: async () => ({ success: true, trackCount: 10 }),
    }),
    useAudioState: () => ({ playbackType: "track", currentTrack: null }),
});

mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});

mock.module("@/lib/api", {
    namedExports: {
        api: { addTrackToPlaylist: async () => undefined },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    copied.length = 0;
    Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: (text: string) => {
                copied.push(text);
                return Promise.resolve();
            },
        },
    });
    window.location.href = "http://localhost/search";
});

const localTrack = {
    id: "track-1",
    title: "Test Track",
    artist: { name: "Test Artist", id: "artist-1" },
    album: { title: "Test Album", id: "album-1" },
    duration: 240,
};

async function renderMenu(track: unknown): Promise<{
    container: HTMLElement;
    unmount: () => void;
}> {
    const { TrackOverflowMenu } =
        await import("../../components/ui/TrackOverflowMenu");
    const { createRoot } = await import("react-dom/client");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(TrackOverflowMenu, { track: track as never }),
        );
    });
    // Open the menu.
    const trigger = container.querySelector('[aria-haspopup="menu"]');
    assert.ok(trigger, "menu trigger not found");
    await React.act(async () => {
        (trigger as HTMLElement).click();
    });
    return {
        container,
        unmount: () => {
            void React.act(() => {
                root.unmount();
            });
        },
    };
}

function findMenuItem(
    container: HTMLElement,
    label: string,
): HTMLElement | null {
    const buttons = Array.from(container.querySelectorAll("button"));
    return (
        (buttons.find((button) =>
            button.textContent?.includes(label),
        ) as HTMLElement) ?? null
    );
}

test("copies an /album?track= link for a local track", async () => {
    const { container, unmount } = await renderMenu(localTrack);

    const item = findMenuItem(container, "Copy link to song");
    assert.ok(item, "Copy link to song item not found");
    await React.act(async () => {
        item!.click();
    });

    assert.deepEqual(copied, ["http://localhost/album/album-1?track=track-1"]);
    unmount();
});

test("hides the copy item for remote provider tracks", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        streamSource: "youtube",
    });

    assert.equal(findMenuItem(container, "Copy link to song"), null);
    unmount();
});

test("hides the copy item when the track has no album id", async () => {
    const { container, unmount } = await renderMenu({
        ...localTrack,
        album: { title: "Test Album" },
    });

    assert.equal(findMenuItem(container, "Copy link to song"), null);
    unmount();
});
