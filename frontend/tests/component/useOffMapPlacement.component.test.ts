import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Behaviour tests for useOffMapPlacement under a real QueryClient: no
 * request while nothing plays or the track is on the map; an off-map track
 * asks for anchors once and lands at their weighted centroid in the live
 * layout; a track the server reports as on-map, or whose anchors have no
 * layout position, yields no placement. `@/lib/api` is the boundary mock.
 */

GlobalRegistrator.register({ url: "http://localhost/vibe" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Anchors = {
    trackId: string;
    onMap: boolean;
    anchors: Array<{ id: string; distance: number }>;
};
const script: { answer: Anchors | null } = { answer: null };
const getVibeMapAnchors = mock.fn(async (trackId: string) => {
    if (!script.answer) throw new Error("no scripted answer");
    return { ...script.answer, trackId };
});

mock.module("@/lib/api", {
    namedExports: { api: { getVibeMapAnchors } },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    script.answer = null;
    getVibeMapAnchors.mock.resetCalls();
    document.body.replaceChildren();
});

const layout: Record<string, { x: number; y: number }> = {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 0 },
};
const posOf = (id: string) => layout[id] ?? null;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** React Query notifies observers on a real timer; wait it out, then act. */
async function settle(): Promise<void> {
    await sleep(25);
    await React.act(async () => {
        await sleep(0);
    });
}

async function mountHook(trackId: string | null, onMap: boolean) {
    const { useOffMapPlacement } =
        await import("../../components/vibe/useOffMapPlacement");
    const { createRoot } = await import("react-dom/client");
    const latest: { placement: unknown } = { placement: undefined };
    function Probe() {
        latest.placement = useOffMapPlacement(trackId, onMap, posOf);
        return null;
    }
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(Probe),
            ),
        );
    });
    await settle();
    return {
        latest,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
            queryClient.clear();
        },
    };
}

test("nothing playing means no request and no placement", async (t) => {
    const harness = await mountHook(null, true);
    t.after(harness.unmount);
    assert.equal(getVibeMapAnchors.mock.callCount(), 0);
    assert.equal(harness.latest.placement, null);
});

test("a track already on the map is never looked up", async (t) => {
    script.answer = { trackId: "x", onMap: false, anchors: [] };
    const harness = await mountHook("on-map", true);
    t.after(harness.unmount);
    assert.equal(getVibeMapAnchors.mock.callCount(), 0);
    assert.equal(harness.latest.placement, null);
});

test("an off-map track lands at the weighted centroid of its anchors", async (t) => {
    script.answer = {
        trackId: "off",
        onMap: false,
        anchors: [
            { id: "a", distance: 0.5 },
            { id: "b", distance: 0.5 },
        ],
    };
    const harness = await mountHook("off", false);
    t.after(harness.unmount);
    assert.equal(getVibeMapAnchors.mock.callCount(), 1);
    assert.deepEqual(getVibeMapAnchors.mock.calls[0]?.arguments[0], "off");
    const placement = harness.latest.placement as {
        point: { x: number; y: number };
        anchors: unknown[];
    } | null;
    assert.ok(placement);
    assert.ok(Math.abs(placement.point.x - 0.5) < 1e-6);
    assert.ok(Math.abs(placement.point.y) < 1e-6);
    assert.equal(placement.anchors.length, 2);
});

test("anchors without layout positions give no placement", async (t) => {
    script.answer = {
        trackId: "off",
        onMap: false,
        anchors: [{ id: "gone", distance: 0.1 }],
    };
    const harness = await mountHook("off", false);
    t.after(harness.unmount);
    assert.equal(harness.latest.placement, null);
});

test("a server that reports the track as on-map gives no placement", async (t) => {
    script.answer = { trackId: "off", onMap: true, anchors: [] };
    const harness = await mountHook("off", false);
    t.after(harness.unmount);
    assert.equal(harness.latest.placement, null);
});
