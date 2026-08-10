import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { createRequire } from "node:module";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for useMapSweep: the begin/extend/finish stroke lifecycle
 * (as `useMapGestures` drives it), the stationary-tap fallthrough, and the
 * chip actions — including the partial-save warning contract from
 * `describeSaveResult`. `@/lib/api` and `@/lib/logger` are boundary-mocked;
 * sweepCollect/savePlaylist are real modules.
 *
 * sonner is captured by patching the CJS realization directly (createRequire)
 * rather than `mock.module`: sonner is a dual-format package, and under tsx
 * the component tree `require`s its CJS entry while `mock.module` from this
 * (ESM-imported) test only intercepts the ESM realization — the patched
 * object below is the one the hook actually calls.
 */

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiState: {
    addImpl: (playlistId: string, ref: { trackId: string }) => Promise<unknown>;
} = { addImpl: async () => ({}) };

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

mock.module("@/lib/api", {
    namedExports: {
        api: {
            createPlaylist: async () => ({ id: "pl-sweep" }),
            addTrackToPlaylist: (
                playlistId: string,
                ref: { trackId: string },
            ) => apiState.addImpl(playlistId, ref),
        },
    },
});

const stubLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => stubLogger,
};
mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: stubLogger,
        createFrontendLogger: () => stubLogger,
    },
});

const toasts: { success: string[]; warning: string[]; error: string[] } = {
    success: [],
    warning: [],
    error: [],
};
const requireCjs = createRequire(import.meta.url);
const sonnerCjs = requireCjs("sonner");
sonnerCjs.toast.success = (msg: string) => toasts.success.push(msg);
sonnerCjs.toast.warning = (msg: string) => toasts.warning.push(msg);
sonnerCjs.toast.error = (msg: string) => toasts.error.push(msg);

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        /* best-effort teardown */
    }
});

const controlsCalls: { playTracks: string[][]; addToQueue: string[] } = {
    playTracks: [],
    addToQueue: [],
};
const controls = {
    playTracks: (tracks: { id: string }[]) =>
        controlsCalls.playTracks.push(tracks.map((t) => t.id)),
    addToQueue: (t: { id: string }) => controlsCalls.addToQueue.push(t.id),
};

beforeEach(() => {
    controlsCalls.playTracks.length = 0;
    controlsCalls.addToQueue.length = 0;
    toasts.success.length = 0;
    toasts.warning.length = 0;
    toasts.error.length = 0;
    apiState.addImpl = async () => ({});
});

function mapTrack(id: string, x: number, y: number) {
    return {
        id,
        x,
        y,
        title: `${id} title`,
        artist: `${id} artist`,
        artistId: `ar-${id}`,
        albumId: `al-${id}`,
        coverUrl: null,
        dominantMood: "moodHappy",
        moodScore: 0.5,
        energy: 0.5,
        valence: 0.5,
    };
}

// Three dots on a horizontal line at world y=0.5: screen (100,500), (500,500),
// (900,500) under the identity-ish viewport below; t-mid is masked out.
const tracks = [
    mapTrack("t-left", 0.1, 0.5),
    mapTrack("t-mid", 0.5, 0.5),
    mapTrack("t-right", 0.9, 0.5),
];
const positions = new Float32Array(tracks.flatMap((t) => [t.x, t.y]));
const mask = new Uint8Array([1, 0, 1]);
const trackById = new Map(tracks.map((t) => [t.id, t]));
const viewportRef = { current: { scale: 1000, tx: 0, ty: 0 } };

type SweepApi = ReturnType<
    typeof import("../../components/vibe/useMapSweep").useMapSweep
>;

async function mountSweep() {
    const { useMapSweep } = await import("../../components/vibe/useMapSweep");
    const { createRoot } = await import("react-dom/client");

    const latestRef: { current: SweepApi | null } = { current: null };
    function Probe() {
        latestRef.current = useMapSweep({
            tracks,
            positions,
            mask,
            viewportRef,
            trackById,
            controls,
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
            if (!latestRef.current) throw new Error("useMapSweep did not run");
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
        },
    };
}

test("a stroke collects visible dots along its sampled path, skipping masked ones", async () => {
    const h = await mountSweep();

    await h.act(() => h.latest().begin({ x: 100, y: 500 }));
    assert.deepEqual(h.latest().live?.ids, ["t-left"]);

    // Sweep straight across the other two dots in one fast flick — segment
    // sampling must catch t-right; masked t-mid must never be collected.
    await h.act(() => h.latest().extend({ x: 900, y: 500 }));
    assert.deepEqual(h.latest().live?.ids, ["t-left", "t-right"]);

    // A real stroke freezes into the result chip and consumes the pointer-up.
    let consumed = false;
    await h.act(() => {
        consumed = h.latest().finish(false);
    });
    assert.equal(consumed, true);
    assert.equal(h.latest().live, null);
    assert.deepEqual(h.latest().result?.ids, ["t-left", "t-right"]);
    assert.equal(h.latest().chipOpen, true);

    await h.unmount();
});

test("a stationary tap falls through to click semantics instead of producing an empty sweep", async () => {
    const h = await mountSweep();

    await h.act(() => h.latest().begin({ x: 100, y: 500 }));
    let consumed = true;
    await h.act(() => {
        consumed = h.latest().finish(true); // wasClick
    });
    assert.equal(consumed, false);
    assert.equal(h.latest().live, null);
    assert.equal(h.latest().result, null);

    await h.unmount();
});

test("discard abandons a live stroke without freezing a chip", async () => {
    const h = await mountSweep();
    await h.act(() => h.latest().begin({ x: 100, y: 500 }));
    await h.act(() => h.latest().discard());
    assert.equal(h.latest().live, null);
    assert.equal(h.latest().result, null);
    assert.equal(h.latest().active(), false);
    await h.unmount();
});

test("eligible: armed brush or shift starts a sweep; neither means pan", async () => {
    const h = await mountSweep();
    assert.equal(h.latest().eligible({ shiftKey: false }), false);
    assert.equal(h.latest().eligible({ shiftKey: true }), true);
    await h.act(() => h.latest().toggleBrush());
    assert.equal(h.latest().eligible({ shiftKey: false }), true);
    await h.unmount();
});

test("queue action queues each swept track silently with one summary toast", async () => {
    const h = await mountSweep();
    await h.act(() => h.latest().begin({ x: 100, y: 500 }));
    await h.act(() => h.latest().extend({ x: 900, y: 500 }));
    await h.act(() => void h.latest().finish(false));

    await h.act(() => h.latest().queue());
    assert.deepEqual(controlsCalls.addToQueue, ["t-left", "t-right"]);
    assert.deepEqual(toasts.success, ["Queued 2 swept tracks"]);
    assert.equal(h.latest().result, null);
    await h.unmount();
});

test("save: a partial save surfaces as a warning toast, never unconditional success", async () => {
    apiState.addImpl = async (_pl, ref) => {
        if (ref.trackId === "t-right") throw new Error("gone");
        return {};
    };
    const h = await mountSweep();
    await h.act(() => h.latest().begin({ x: 100, y: 500 }));
    await h.act(() => h.latest().extend({ x: 900, y: 500 }));
    await h.act(() => void h.latest().finish(false));

    await h.act(async () => {
        await h.latest().save();
    });
    assert.equal(toasts.success.length, 0);
    assert.equal(toasts.warning.length, 1);
    assert.match(toasts.warning[0], /Saved 1 of 2 tracks/);
    assert.match(toasts.warning[0], /1 track couldn't be added/);
    await h.unmount();
});

test("save: a full save is a success toast", async () => {
    const h = await mountSweep();
    await h.act(() => h.latest().begin({ x: 100, y: 500 }));
    await h.act(() => h.latest().extend({ x: 900, y: 500 }));
    await h.act(() => void h.latest().finish(false));

    await h.act(async () => {
        await h.latest().save();
    });
    assert.equal(toasts.warning.length, 0);
    assert.equal(toasts.success.length, 1);
    assert.match(toasts.success[0], /Saved 2 tracks to Vibe sweep/);
    await h.unmount();
});

test("save completion does not dismiss a newer sweep result", async () => {
    const pendingAdd = deferred<unknown>();
    apiState.addImpl = () => pendingAdd.promise;
    const h = await mountSweep();
    await h.act(() => h.latest().begin({ x: 100, y: 500 }));
    await h.act(() => void h.latest().finish(false));

    let savePromise!: Promise<void>;
    await h.act(() => {
        savePromise = h.latest().save();
    });
    await h.act(() => h.latest().begin({ x: 900, y: 500 }));
    await h.act(() => void h.latest().finish(false));
    assert.deepEqual(h.latest().result?.ids, ["t-right"]);

    pendingAdd.resolve({});
    await h.act(async () => {
        await savePromise;
    });
    assert.deepEqual(h.latest().result?.ids, ["t-right"]);
    await h.unmount();
});
