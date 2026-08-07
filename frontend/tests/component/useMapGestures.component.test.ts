import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for useMapGestures: click-vs-drag interpretation, empty-
 * click forgiveness, sweep handoff, and pinch. The camera and sweep are
 * recorded fakes (the contract is which intents reach them); hitTest is a
 * canned lookup. Handlers are driven with minimal synthetic pointer events.
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        /* best-effort teardown */
    }
});

const cameraCalls: { pans: Array<[number, number]>; zooms: number[]; cancels: number } =
    { pans: [], zooms: [], cancels: 0 };
const camera = {
    accumulatePan: (dx: number, dy: number) => void cameraCalls.pans.push([dx, dy]),
    accumulateZoom: (_cx: number, _cy: number, logf: number) =>
        void cameraCalls.zooms.push(logf),
    cancelFlight: () => void cameraCalls.cancels++,
    viewportRef: { current: { scale: 1000, tx: 0, ty: 0 } },
};

const sweepCalls: { begins: number; extends: number; finishes: boolean[]; discards: number } =
    { begins: 0, extends: 0, finishes: [], discards: 0 };
let sweepArmed = false;
let sweepActive = false;
const sweep = {
    eligible: (mods: { shiftKey: boolean }) => sweepArmed || mods.shiftKey,
    active: () => sweepActive,
    begin: () => {
        sweepCalls.begins++;
        sweepActive = true;
    },
    extend: () => void sweepCalls.extends++,
    finish: (wasClick: boolean) => {
        sweepCalls.finishes.push(wasClick);
        sweepActive = false;
        return !wasClick;
    },
    discard: () => {
        sweepCalls.discards++;
        sweepActive = false;
    },
};

const taps: Array<{ id: string; shift: boolean; ctrlOrMeta: boolean }> = [];
let emptyTaps = 0;
// Canned hit-test: a dot registers at (100,100); with the forgiveness radius
// scale, anything within (150,150) counts as a near-miss.
function hitTest(x: number, y: number, radiusScale = 1): string | null {
    const r = 20 * radiusScale;
    return Math.hypot(x - 100, y - 100) <= r ? "dot-1" : null;
}

beforeEach(() => {
    cameraCalls.pans.length = 0;
    cameraCalls.zooms.length = 0;
    cameraCalls.cancels = 0;
    sweepCalls.begins = 0;
    sweepCalls.extends = 0;
    sweepCalls.finishes.length = 0;
    sweepCalls.discards = 0;
    sweepArmed = false;
    sweepActive = false;
    taps.length = 0;
    emptyTaps = 0;
});

type GesturesApi = ReturnType<
    typeof import("../../components/vibe/useMapGestures").useMapGestures
>;

function fakeEvent(
    pointerId: number,
    clientX: number,
    clientY: number,
    extra: Partial<{
        shiftKey: boolean;
        ctrlKey: boolean;
        metaKey: boolean;
        pointerType: string;
        buttons: number;
    }> = {}
) {
    return {
        pointerId,
        clientX,
        clientY,
        shiftKey: extra.shiftKey ?? false,
        ctrlKey: extra.ctrlKey ?? false,
        metaKey: extra.metaKey ?? false,
        pointerType: extra.pointerType ?? "mouse",
        buttons: extra.buttons ?? 1,
        currentTarget: {
            setPointerCapture: () => undefined,
            releasePointerCapture: () => undefined,
        },
    } as unknown as React.PointerEvent<HTMLCanvasElement>;
}

async function mountGestures() {
    const { useMapGestures } = await import(
        "../../components/vibe/useMapGestures"
    );
    const { createRoot } = await import("react-dom/client");

    const containerEl = document.createElement("div");
    document.body.appendChild(containerEl);
    const containerRef = { current: containerEl as HTMLDivElement };

    const latestRef: { current: GesturesApi | null } = { current: null };
    function Probe() {
        latestRef.current = useMapGestures({
            containerRef,
            camera,
            hitTest,
            sweep,
            onTap: (id, mods) =>
                taps.push({ id, shift: mods.shift, ctrlOrMeta: mods.ctrlOrMeta }),
            onEmptyTap: () => void emptyTaps++,
        });
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });

    return {
        latest: () => {
            if (!latestRef.current) throw new Error("useMapGestures did not run");
            return latestRef.current;
        },
        act: async (fn: () => void | Promise<void>) => {
            await React.act(async () => {
                await fn();
            });
        },
        unmount: async () => {
            await React.act(async () => {
                root.unmount();
            });
            container.remove();
            containerEl.remove();
        },
    };
}

test("a stationary click on a dot taps it with its modifiers", async () => {
    const h = await mountGestures();
    await h.act(() => h.latest().handlePointerDown(fakeEvent(1, 100, 100)));
    await h.act(() =>
        h.latest().handlePointerUp(fakeEvent(1, 100, 100, { shiftKey: true }))
    );
    assert.deepEqual(taps, [{ id: "dot-1", shift: true, ctrlOrMeta: false }]);
    assert.equal(emptyTaps, 0);
    await h.unmount();
});

test("a drag past the click threshold pans the camera and never taps", async () => {
    const h = await mountGestures();
    await h.act(() => h.latest().handlePointerDown(fakeEvent(1, 100, 100)));
    await h.act(() => h.latest().handlePointerMove(fakeEvent(1, 130, 100)));
    await h.act(() => h.latest().handlePointerUp(fakeEvent(1, 130, 100)));
    assert.deepEqual(cameraCalls.pans, [[30, 0]]);
    assert.equal(taps.length, 0);
    assert.equal(emptyTaps, 0);
    await h.unmount();
});

test("a clean click on clearly-empty canvas is an empty tap; a near-miss is neither", async () => {
    const h = await mountGestures();
    // Far from the dot (400,400): clearly empty.
    await h.act(() => h.latest().handlePointerDown(fakeEvent(1, 400, 400)));
    await h.act(() => h.latest().handlePointerUp(fakeEvent(1, 400, 400)));
    assert.equal(emptyTaps, 1);
    assert.equal(taps.length, 0);

    // 130,100: outside the 20px hit radius but inside the 2× forgiveness
    // radius — a near-miss on the dot must not count as an empty click.
    await h.act(() => h.latest().handlePointerDown(fakeEvent(1, 130, 100)));
    await h.act(() => h.latest().handlePointerUp(fakeEvent(1, 130, 100)));
    assert.equal(emptyTaps, 1); // unchanged
    assert.equal(taps.length, 0);
    await h.unmount();
});

test("shift-down starts a sweep, moves extend it, and a real stroke consumes the pointer-up", async () => {
    const h = await mountGestures();
    await h.act(() =>
        h.latest().handlePointerDown(fakeEvent(1, 100, 100, { shiftKey: true }))
    );
    assert.equal(sweepCalls.begins, 1);
    await h.act(() => h.latest().handlePointerMove(fakeEvent(1, 200, 100)));
    assert.equal(sweepCalls.extends, 1);
    assert.deepEqual(cameraCalls.pans, []); // the stroke collects instead of panning
    await h.act(() => h.latest().handlePointerUp(fakeEvent(1, 200, 100)));
    assert.deepEqual(sweepCalls.finishes, [false]); // real stroke, not a click
    assert.equal(taps.length, 0);
    await h.unmount();
});

test("a stationary shift-click ends the sweep as a click and falls through to a tap", async () => {
    const h = await mountGestures();
    await h.act(() =>
        h.latest().handlePointerDown(fakeEvent(1, 100, 100, { shiftKey: true }))
    );
    await h.act(() =>
        h.latest().handlePointerUp(fakeEvent(1, 100, 100, { shiftKey: true }))
    );
    assert.deepEqual(sweepCalls.finishes, [true]); // wasClick
    assert.deepEqual(taps, [{ id: "dot-1", shift: true, ctrlOrMeta: false }]);
    await h.unmount();
});

test("a second finger switches to pinch: sweep discarded, zoom accumulated, never a tap", async () => {
    sweepArmed = true;
    const h = await mountGestures();
    await h.act(() =>
        h.latest().handlePointerDown(fakeEvent(1, 100, 100, { pointerType: "touch" }))
    );
    await h.act(() =>
        h.latest().handlePointerDown(fakeEvent(2, 200, 100, { pointerType: "touch" }))
    );
    assert.equal(sweepCalls.discards, 1);

    // Fingers spread apart → zoom in (positive logf).
    await h.act(() =>
        h.latest().handlePointerMove(fakeEvent(2, 300, 100, { pointerType: "touch" }))
    );
    assert.equal(cameraCalls.zooms.length, 1);
    assert.ok(cameraCalls.zooms[0] > 0);

    await h.act(() =>
        h.latest().handlePointerUp(fakeEvent(2, 300, 100, { pointerType: "touch" }))
    );
    await h.act(() =>
        h.latest().handlePointerUp(fakeEvent(1, 100, 100, { pointerType: "touch" }))
    );
    assert.equal(taps.length, 0);
    assert.equal(emptyTaps, 0);
    await h.unmount();
});
