import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for useMapCamera — the single camera owner. Pending
 * pan/zoom accumulate in refs and commit at most once per animation frame;
 * programmatic flights snap under reduced motion. No module mocks: the hook
 * tree is pure React + mapViewport math, driven through a real mount
 * (happy-dom provides requestAnimationFrame).
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

const DIMS = { width: 800, height: 600 };

type CameraApi = ReturnType<
    typeof import("../../components/vibe/useMapCamera").useMapCamera
>;

async function mountCamera(reducedMotion = false) {
    const { useMapCamera } = await import("../../components/vibe/useMapCamera");
    const { createRoot } = await import("react-dom/client");

    const latestRef: { current: CameraApi | null } = { current: null };
    function Probe() {
        latestRef.current = useMapCamera({ dims: DIMS, reducedMotion });
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
            if (!latestRef.current) throw new Error("useMapCamera did not run");
            return latestRef.current;
        },
        act: async (fn: () => void | Promise<void>) => {
            await React.act(async () => {
                await fn();
            });
        },
        /** Wait out at least two animation frames inside act. */
        frames: async () => {
            await React.act(async () => {
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve())
                    )
                );
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

test("initialises the viewport to the whole-map fit once dims are known", async () => {
    const h = await mountCamera();
    const vp = h.latest().viewport;
    assert.ok(vp, "viewport should be initialised");
    // 800x600 with 40px padding → fit scale = min(720, 520) = 520, centered.
    assert.equal(vp!.scale, 520);
    await h.unmount();
});

test("accumulated pan deltas commit as one batched viewport write on the next frame", async () => {
    const h = await mountCamera();
    const before = h.latest().viewport!;

    await h.act(() => {
        h.latest().accumulatePan(10, 5);
        h.latest().accumulatePan(-4, 2); // same frame — must merge
    });
    await h.frames();

    const afterVp = h.latest().viewport!;
    assert.equal(afterVp.tx, before.tx + 6);
    assert.equal(afterVp.ty, before.ty + 7);
    assert.equal(afterVp.scale, before.scale); // pan never rescales
    await h.unmount();
});

test("accumulateZoom zooms about the cursor, preserving the world point under it", async () => {
    const h = await mountCamera();
    const before = h.latest().viewport!;
    const cursor = { x: 200, y: 150 };
    const worldBefore = {
        x: (cursor.x - before.tx) / before.scale,
        y: (cursor.y - before.ty) / before.scale,
    };

    await h.act(() => {
        h.latest().accumulateZoom(cursor.x, cursor.y, Math.log(2));
    });
    await h.frames();

    const afterVp = h.latest().viewport!;
    assert.ok(
        Math.abs(afterVp.scale - before.scale * 2) < 1e-6,
        `scale doubled (got ${afterVp.scale})`
    );
    const worldAfter = {
        x: (cursor.x - afterVp.tx) / afterVp.scale,
        y: (cursor.y - afterVp.ty) / afterVp.scale,
    };
    assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-6);
    assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-6);
    await h.unmount();
});

test("animateCameraTo snaps immediately under reduced motion", async () => {
    const h = await mountCamera(true);
    const target = { scale: 1040, tx: -100, ty: -50 };

    await h.act(() => {
        h.latest().animateCameraTo(target, 500);
    });
    // No frame wait: reduced motion writes synchronously.
    const vp = h.latest().viewport!;
    assert.equal(vp.scale, 1040);
    await h.unmount();
});

test("zoomByCenter + resetView return to the fit", async () => {
    const h = await mountCamera(true); // reduced motion → deterministic snaps
    const fit = h.latest().viewport!;

    await h.act(() => h.latest().zoomByCenter(2));
    assert.ok(h.latest().viewport!.scale > fit.scale);

    await h.act(() => h.latest().resetView());
    assert.deepEqual(h.latest().viewport, fit);
    await h.unmount();
});
