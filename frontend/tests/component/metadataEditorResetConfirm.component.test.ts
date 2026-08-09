import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const resetArtistMetadata = mock.fn(async () => ({
    message: "ok",
    artist: {},
}));

mock.module("@/lib/api", {
    namedExports: {
        api: {
            resetArtistMetadata,
            resetAlbumMetadata: async () => ({}),
            resetTrackMetadata: async () => ({}),
            updateArtistMetadata: async () => ({}),
            updateAlbumMetadata: async () => ({}),
            updateTrackMetadata: async () => ({}),
        },
    },
});

const toast = Object.assign(() => undefined, {
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
});
mock.module("sonner", { namedExports: { toast } });

mock.module("@/components/ui/MusicBrainzLookup", {
    namedExports: { MusicBrainzLookup: () => null },
});
mock.module("next/image", { defaultExport: () => null });
mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        },
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
    resetArtistMetadata.mock.resetCalls();
    document.body.replaceChildren();
});

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new Event("click", { bubbles: true }));
    });
}

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes(text)
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

function findLastExactButton(text: string): HTMLButtonElement {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
        (candidate) => candidate.textContent === text
    );
    const button = buttons.at(-1);
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

async function mountEditor() {
    const { MetadataEditor } = await import("../../components/MetadataEditor");
    const { createRoot } = await import("react-dom/client");
    const onSave = mock.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(MetadataEditor, {
                type: "artist",
                id: "artist-1",
                currentData: {
                    name: "Name",
                    _hasUserOverrides: true,
                },
                onSave,
            })
        );
    });

    return {
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function openResetConfirmation(): Promise<void> {
    const closedButtons = document.querySelectorAll("button");
    assert.equal(closedButtons.length, 1);
    await click(closedButtons[0]);
    await click(findButton("Reset to Original"));
}

test("confirms before resetting artist metadata", async (t) => {
    const harness = await mountEditor();
    t.after(harness.unmount);

    await openResetConfirmation();

    assert.equal(resetArtistMetadata.mock.callCount(), 0);
    assert.match(
        document.body.textContent ?? "",
        /Reset .*metadata|cannot be undone/i
    );

    const confirmButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Reset"
    );
    assert.ok(confirmButton instanceof HTMLButtonElement);
    await click(confirmButton);
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.equal(resetArtistMetadata.mock.callCount(), 1);
});

test("cancelling reset confirmation does not reset artist metadata", async (t) => {
    const harness = await mountEditor();
    t.after(harness.unmount);

    await openResetConfirmation();
    await click(findLastExactButton("Cancel"));

    assert.equal(resetArtistMetadata.mock.callCount(), 0);
});
