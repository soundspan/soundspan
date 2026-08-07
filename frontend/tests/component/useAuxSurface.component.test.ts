import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for useAuxSurface — the exclusive queue/trail/about slot.
 * Opening one surface closes another, entering a vibe mode genuinely closes
 * the open surface (no ghosting back), and a sweep chip appearing does too.
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

import type { VibeMode } from "../../components/vibe/vibeModeMachine";

type AuxApi = ReturnType<
    typeof import("../../components/vibe/useAuxSurface").useAuxSurface
>;

async function mountAux() {
    const { useAuxSurface } = await import(
        "../../components/vibe/useAuxSurface"
    );
    const { createRoot } = await import("react-dom/client");

    const latestRef: { current: AuxApi | null } = { current: null };
    function Probe({
        mode,
        sweepChipOpen,
    }: {
        mode: VibeMode;
        sweepChipOpen: boolean;
    }) {
        latestRef.current = useAuxSurface({ mode, sweepChipOpen });
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async (mode: VibeMode, sweepChipOpen: boolean) => {
        await React.act(async () => {
            root.render(React.createElement(Probe, { mode, sweepChipOpen }));
        });
    };
    await render("explore", false);

    return {
        latest: () => {
            if (!latestRef.current) throw new Error("useAuxSurface did not run");
            return latestRef.current;
        },
        render,
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
        },
    };
}

test("one exclusive slot: opening a surface closes the other; its own button toggles it closed", async () => {
    const h = await mountAux();
    await h.act(() => h.latest().toggleAuxSurface("queue"));
    assert.equal(h.latest().auxSurface, "queue");

    await h.act(() => h.latest().toggleAuxSurface("trail"));
    assert.equal(h.latest().auxSurface, "trail"); // queue closed, trail open

    await h.act(() => h.latest().toggleAuxSurface("trail"));
    assert.equal(h.latest().auxSurface, null); // own button closes
    assert.equal(h.latest().auxOpen, false);
    await h.unmount();
});

test("entering a vibe mode genuinely closes the open surface — it does not ghost back on exit", async () => {
    const h = await mountAux();
    await h.act(() => h.latest().toggleAuxSurface("queue"));
    assert.equal(h.latest().auxSurface, "queue");

    await h.render("travel", false);
    assert.equal(h.latest().auxSurface, null);

    // Leaving the mode must NOT resurrect it (the old visibility-gate bug).
    await h.render("explore", false);
    assert.equal(h.latest().auxSurface, null);
    await h.unmount();
});

test("opening a surface while a mode is already active stays open (deliberate peek)", async () => {
    const h = await mountAux();
    await h.render("journey", false);
    await h.act(() => h.latest().toggleAuxSurface("queue"));
    assert.equal(h.latest().auxSurface, "queue");
    await h.unmount();
});

test("a sweep chip appearing closes the open surface", async () => {
    const h = await mountAux();
    await h.act(() => h.latest().toggleAuxSurface("about"));
    assert.equal(h.latest().auxSurface, "about");

    await h.render("explore", true);
    assert.equal(h.latest().auxSurface, null);
    await h.unmount();
});
