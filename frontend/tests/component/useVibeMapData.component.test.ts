import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Behaviour tests for useVibeMapData under a real QueryClient: first load,
 * failed and building answers with nothing cached, a rebuild that keeps the
 * stale map on screen while the server rebuilds, a rebuild request that
 * fails, and unmount. `@/lib/api` is the boundary mock; the server answer
 * sequence is scripted per test. Polling cadence is not exercised here
 * (real timers); the next answer is pulled by invalidating the query, which
 * is exactly what the refetch interval does.
 */

GlobalRegistrator.register({ url: "http://localhost/vibe" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type MapAnswer =
    | {
          tracks: Array<Record<string, unknown>>;
          trackCount: number;
          embeddedCount?: number;
          computedAt: string;
          sampled?: boolean;
      }
    | { building: true; failed?: boolean; retryAt?: string };

const script: { answers: MapAnswer[]; rebuildFails: boolean } = {
    answers: [],
    rebuildFails: false,
};

const READY = {
    tracks: [{ id: "t1", x: 0.1, y: 0.2, title: "One", artist: "A" }],
    trackCount: 1,
    embeddedCount: 1,
    computedAt: "2026-09-17T00:00:00.000Z",
};

const getVibeMap = mock.fn(async () => {
    const next = script.answers.shift();
    if (!next) throw new Error("no scripted answer left");
    return next;
});
const rebuildVibeMap = mock.fn(async () => {
    if (script.rebuildFails) throw new Error("forbidden");
    return { building: true, outcome: "started" };
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getVibeMap,
            rebuildVibeMap,
            getVibeCalibration: async () => ({ sampleSize: 0, quantiles: [] }),
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
    script.answers = [];
    script.rebuildFails = false;
    getVibeMap.mock.resetCalls();
    rebuildVibeMap.mock.resetCalls();
    document.body.replaceChildren();
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * React Query resolves the fetch inside act but notifies its observers on a
 * real timer that act does not track, so the re-render lands a tick later.
 * Wait that tick out, then flush the resulting render through act.
 */
async function settle(): Promise<void> {
    await sleep(25);
    await React.act(async () => {
        await sleep(0);
    });
}

interface Snapshot {
    tracks: number;
    computedAt: string | null;
    loading: boolean;
    building: boolean;
    error: string | null;
    rebuildState: string;
}

async function mountHook() {
    const { useVibeMapData } =
        await import("../../components/vibe/useVibeMapData");
    const { createRoot } = await import("react-dom/client");
    const latest: { snapshot: Snapshot | null; rebuild: () => void } = {
        snapshot: null,
        rebuild: () => undefined,
    };
    function Probe() {
        const data = useVibeMapData();
        latest.snapshot = {
            tracks: data.tracks.length,
            computedAt: data.computedAt,
            loading: data.loading,
            building: data.building,
            error: data.error,
            rebuildState: data.rebuildState,
        };
        latest.rebuild = data.rebuild;
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
    const pullNextAnswer = async () => {
        await React.act(async () => {
            await queryClient.invalidateQueries({ queryKey: ["vibe", "map"] });
        });
        await settle();
    };
    const rebuild = async () => {
        await React.act(async () => {
            latest.rebuild();
        });
        await settle();
    };
    return {
        latest,
        pullNextAnswer,
        rebuild,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
            queryClient.clear();
        },
    };
}

test("a ready answer loads the map", async (t) => {
    script.answers = [READY];
    const harness = await mountHook();
    t.after(harness.unmount);
    assert.deepEqual(harness.latest.snapshot, {
        tracks: 1,
        computedAt: READY.computedAt,
        loading: false,
        building: false,
        error: null,
        rebuildState: "idle",
    });
    assert.equal(getVibeMap.mock.callCount(), 1);
});

test("a building answer with nothing cached shows the building overlay", async (t) => {
    script.answers = [{ building: true }];
    const harness = await mountHook();
    t.after(harness.unmount);
    assert.equal(harness.latest.snapshot?.loading, true);
    assert.equal(harness.latest.snapshot?.building, true);
    assert.equal(harness.latest.snapshot?.tracks, 0);
});

test("a failed build with nothing cached stops and explains itself", async (t) => {
    script.answers = [{ building: true, failed: true }];
    const harness = await mountHook();
    t.after(harness.unmount);
    assert.equal(harness.latest.snapshot?.loading, false);
    assert.match(harness.latest.snapshot?.error ?? "", /build failed/);
});

test("a rejected request reports a load error", async (t) => {
    script.answers = [];
    const harness = await mountHook();
    t.after(harness.unmount);
    assert.equal(
        harness.latest.snapshot?.error,
        "Failed to load vibe map data",
    );
    assert.equal(harness.latest.snapshot?.loading, false);
});

test("a rebuild keeps the stale map on screen until the fresh one lands", async (t) => {
    const fresh = { ...READY, computedAt: "2026-09-18T00:00:00.000Z" };
    script.answers = [READY, { building: true }, fresh];
    const harness = await mountHook();
    t.after(harness.unmount);

    await harness.rebuild();
    assert.equal(rebuildVibeMap.mock.callCount(), 1);
    // The mutation's success invalidated the query; the building answer
    // merged with the previous payload.
    assert.equal(harness.latest.snapshot?.tracks, 1);
    assert.equal(harness.latest.snapshot?.computedAt, READY.computedAt);
    assert.equal(harness.latest.snapshot?.loading, false);
    assert.equal(harness.latest.snapshot?.rebuildState, "building");

    await harness.pullNextAnswer();
    assert.equal(harness.latest.snapshot?.computedAt, fresh.computedAt);
    assert.equal(harness.latest.snapshot?.rebuildState, "idle");
});

test("a rebuild request that fails is reported on the chip, not the map", async (t) => {
    script.answers = [READY];
    script.rebuildFails = true;
    const harness = await mountHook();
    t.after(harness.unmount);

    await harness.rebuild();
    assert.equal(harness.latest.snapshot?.rebuildState, "error");
    assert.equal(harness.latest.snapshot?.tracks, 1);
    assert.equal(harness.latest.snapshot?.error, null);
});

test("unmounting mid-build does not throw", async (t) => {
    script.answers = [{ building: true }];
    const harness = await mountHook();
    await harness.unmount();
    t.after(() => undefined);
    assert.ok(true);
});
