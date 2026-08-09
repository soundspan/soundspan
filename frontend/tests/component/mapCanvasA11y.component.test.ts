import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

type Mods = { ctrlOrMeta: boolean; shift: boolean };
type SelectCall = { id: string; mods: Mods };

const baseTrack = {
    x: 0.5,
    y: 0.5,
    title: "",
    artist: "",
    artistId: "a",
    albumId: "al",
    coverUrl: null,
    dominantMood: "moodHappy",
    moodScore: 0.5,
    energy: 0.5,
    valence: 0.5,
};

const tracks = [
    { ...baseTrack, id: "t1", title: "First Song", artist: "Artist One" },
    { ...baseTrack, id: "t2", title: "Second Song", artist: "Artist Two" },
    { ...baseTrack, id: "t3", title: "Third Song", artist: "Artist Three" },
];

async function mountCanvas(
    mask: number[],
    onSelectTrack: (id: string, mods: Mods) => void,
) {
    const { createRoot } = await import("react-dom/client");
    const { MapCanvas } = await import("../../components/vibe/MapCanvas");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(MapCanvas, {
                tracks,
                viewport: { scale: 100, tx: 0, ty: 0 },
                width: 400,
                height: 300,
                mask: Uint8Array.from(mask),
                onSelectTrack,
            }),
        );
    });
    return { container, root };
}

async function unmount(mounted: {
    container: HTMLElement;
    root: { unmount: () => void };
}) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

function canvasOf(container: HTMLElement): HTMLCanvasElement {
    const canvas = container.querySelector("canvas");
    assert.ok(canvas, "expected a canvas element");
    return canvas as HTMLCanvasElement;
}

async function press(
    canvas: HTMLElement,
    key: string,
    init: KeyboardEventInit = {},
) {
    await React.act(async () => {
        canvas.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
        );
    });
}

test("canvas exposes an application role, accessible name and node count", async () => {
    const mounted = await mountCanvas([1, 1, 1], () => undefined);
    const canvas = canvasOf(mounted.container);

    assert.equal(canvas.getAttribute("role"), "application");
    assert.equal((canvas as HTMLElement).tabIndex, 0);

    const name = canvas.getAttribute("aria-label") ?? "";
    assert.match(name, /vibe map/i, "aria-label should name the map");
    assert.match(name, /3/, "aria-label should mention the node count");

    // A text alternative (aria-describedby) summarises the map for AT.
    const describedBy = canvas.getAttribute("aria-describedby");
    assert.ok(describedBy, "expected aria-describedby");
    const summary = mounted.container.querySelector(`#${describedBy}`);
    assert.ok(summary, "expected the described-by summary element in the DOM");

    await unmount(mounted);
});

test("arrow keys move focus between visible nodes and Enter selects", async () => {
    const calls: SelectCall[] = [];
    const mounted = await mountCanvas([1, 1, 1], (id, mods) =>
        calls.push({ id, mods }),
    );
    const canvas = canvasOf(mounted.container);
    canvas.focus();

    await press(canvas, "ArrowRight"); // focus first
    await press(canvas, "Enter");
    assert.deepEqual(calls.at(-1), {
        id: "t1",
        mods: { ctrlOrMeta: false, shift: false },
    });

    await press(canvas, "ArrowRight"); // advance to second
    await press(canvas, "Enter");
    assert.equal(calls.at(-1)?.id, "t2");

    await unmount(mounted);
});

test("Enter forwards ctrl/shift modifiers to selection", async () => {
    const calls: SelectCall[] = [];
    const mounted = await mountCanvas([1, 1, 1], (id, mods) =>
        calls.push({ id, mods }),
    );
    const canvas = canvasOf(mounted.container);
    canvas.focus();

    await press(canvas, "ArrowRight");
    await press(canvas, "Enter", { shiftKey: true, metaKey: true });
    assert.deepEqual(calls.at(-1), {
        id: "t1",
        mods: { ctrlOrMeta: true, shift: true },
    });

    await unmount(mounted);
});

test("keyboard navigation skips filtered-out (masked) nodes", async () => {
    const calls: SelectCall[] = [];
    // Only the middle track is visible.
    const mounted = await mountCanvas([0, 1, 0], (id, mods) =>
        calls.push({ id, mods }),
    );
    const canvas = canvasOf(mounted.container);
    canvas.focus();

    await press(canvas, "ArrowRight");
    await press(canvas, "ArrowRight"); // cannot advance past the only visible node
    await press(canvas, "Enter");
    assert.equal(calls.at(-1)?.id, "t2");
    assert.equal(calls.length, 1);

    await unmount(mounted);
});
