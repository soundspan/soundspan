import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const clearDiscoverPlaylist = mock.fn(async () => ({
    success: true,
    message: "",
    likedMoved: 0,
    activeDeleted: 2,
}));

mock.module("@/lib/api", {
    namedExports: {
        api: {
            clearDiscoverPlaylist,
            updateDiscoverConfig: async () => ({}),
        },
    },
});

const toast = Object.assign(() => undefined, {
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
});
mock.module("sonner", { namedExports: { toast } });

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    clearDiscoverPlaylist.mock.resetCalls();
    document.body.replaceChildren();
});

const config = {
    id: "c1",
    userId: "u1",
    playlistSize: 10,
    enabled: true,
    exclusionMonths: 6,
    lastGeneratedAt: null,
};

async function mountDiscoverSettings(onPlaylistCleared: () => void) {
    const { DiscoverSettings } = await import(
        "../../features/discover/components/DiscoverSettings"
    );
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(DiscoverSettings, {
                config: config as never,
                onUpdateConfig: () => undefined,
                onPlaylistCleared,
            })
        );
    });

    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(text)
    );
    assert.ok(button instanceof HTMLButtonElement, `button not found: ${text}`);
    return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new Event("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("clears the discovery playlist only after dialog confirmation", async (t) => {
    const onPlaylistCleared = mock.fn(() => undefined);
    const harness = await mountDiscoverSettings(onPlaylistCleared);
    t.after(harness.unmount);

    assert.equal(clearDiscoverPlaylist.mock.callCount(), 0);
    await click(findButton(harness.container, "Remove Playlist"));

    assert.match(
        harness.container.textContent ?? "",
        /Clear Discovery Playlist\?|cannot be undone/
    );
    assert.equal(clearDiscoverPlaylist.mock.callCount(), 0);

    await click(findButton(harness.container, "Clear Playlist"));

    assert.equal(clearDiscoverPlaylist.mock.callCount(), 1);
    assert.equal(onPlaylistCleared.mock.callCount(), 1);
});

test("cancelling the clear-playlist dialog leaves the playlist unchanged", async (t) => {
    const onPlaylistCleared = mock.fn(() => undefined);
    const harness = await mountDiscoverSettings(onPlaylistCleared);
    t.after(harness.unmount);

    await click(findButton(harness.container, "Remove Playlist"));
    await click(findButton(harness.container, "Cancel"));

    assert.equal(clearDiscoverPlaylist.mock.callCount(), 0);
    assert.equal(onPlaylistCleared.mock.callCount(), 0);
});
