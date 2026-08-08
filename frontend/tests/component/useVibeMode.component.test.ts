import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for useVibeMode's onDotClick — specifically the shift-click
 * rule (bug fix: "shift-click on a dot must queue the track in EVERY mode
 * instead of stopping playback and entering travel"). onDotClick's internal
 * state lives behind a real useReducer, so — unlike the renderToStaticMarkup
 * hook tests elsewhere in this tree — asserting mode transitions requires a
 * REAL mount (happy-dom via react-dom/client + act), same pattern as
 * skipSecondsButtons.component.test.ts / spotlightSearch.component.test.ts.
 * `@/lib/api` and `sonner` are boundary-mocked; travelCompass/journeyTracks
 * etc. are real (pure) modules.
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

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

const apiCalls: {
    getVibeSimilarTracks: unknown[][];
    getVibeMoods: number;
    journey: Deferred<unknown>[];
    alchemy: Deferred<unknown>[];
    playlists: Deferred<{ id: string }>[];
} = {
    getVibeSimilarTracks: [],
    getVibeMoods: 0,
    journey: [],
    alchemy: [],
    playlists: [],
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getVibeSimilarTracks: async (id: string, limit: number) => {
                apiCalls.getVibeSimilarTracks.push([id, limit]);
                return { tracks: [], sourceFeatures: null };
            },
            getVibeMoods: async () => {
                apiCalls.getVibeMoods++;
                return [];
            },
            getVibeJourney: () => {
                const request = deferred<unknown>();
                apiCalls.journey.push(request);
                return request.promise;
            },
            vibeAlchemy: () => {
                const request = deferred<unknown>();
                apiCalls.alchemy.push(request);
                return request.promise;
            },
            createPlaylist: () => {
                const request = deferred<{ id: string }>();
                apiCalls.playlists.push(request);
                return request.promise;
            },
            addTrackToPlaylist: async () => undefined,
        },
    },
});

mock.module("sonner", {
    namedExports: {
        toast: Object.assign(() => undefined, {
            success: () => undefined,
            error: () => undefined,
        }),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        /* best-effort teardown */
    }
});

const controlsCalls: {
    playTrack: string[];
    playTracks: string[][];
    addToQueue: string[];
} = { playTrack: [], playTracks: [], addToQueue: [] };

const controls = {
    playTrack: (t: { id: string }) => controlsCalls.playTrack.push(t.id),
    playTracks: (tracks: { id: string }[]) =>
        controlsCalls.playTracks.push(tracks.map((t) => t.id)),
    addToQueue: (t: { id: string }) => controlsCalls.addToQueue.push(t.id),
};

beforeEach(() => {
    controlsCalls.playTrack.length = 0;
    controlsCalls.playTracks.length = 0;
    controlsCalls.addToQueue.length = 0;
    apiCalls.getVibeSimilarTracks.length = 0;
    apiCalls.getVibeMoods = 0;
    apiCalls.journey.length = 0;
    apiCalls.alchemy.length = 0;
    apiCalls.playlists.length = 0;
});

function mapTrack(id: string) {
    return {
        id,
        x: 0.5,
        y: 0.5,
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

const trackById = new Map(
    ["t1", "t2", "t3", "t4"].map((id) => [id, mapTrack(id)])
);

const currentTrack = {
    id: "t1",
    title: "t1 title",
    artist: { name: "t1 artist" },
    album: { title: "" },
    duration: 0,
};

type VibeApi = Awaited<
    ReturnType<typeof import("../../components/vibe/useVibeMode").useVibeMode>
>;

async function mountVibe(): Promise<{
    latest: () => VibeApi;
    act: (fn: () => void | Promise<void>) => Promise<void>;
    unmount: () => Promise<void>;
}> {
    const { useVibeMode } = await import("../../components/vibe/useVibeMode");
    const { createRoot } = await import("react-dom/client");

    const latestRef: { current: VibeApi | null } = { current: null };
    function Probe() {
        const vibe = useVibeMode({ trackById, currentTrack, controls });
        latestRef.current = vibe;
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(Probe));
    });
    await React.act(async () => {
        await Promise.resolve();
    });

    return {
        latest: () => {
            if (!latestRef.current) throw new Error("useVibeMode did not run");
            return latestRef.current;
        },
        act: async (fn) => {
            await React.act(async () => {
                await fn();
            });
            // Flush any promise-driven effects (travel/journey async fetches)
            // triggered by the action above.
            await React.act(async () => {
                await Promise.resolve();
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

test("explore mode: shift-click on a dot queues it, never plays, never enters travel", async () => {
    const h = await mountVibe();
    assert.equal(h.latest().mode, "explore");

    await h.act(() => {
        h.latest().onDotClick("t2", { ctrlOrMeta: false, shift: true });
    });

    assert.deepEqual(controlsCalls.addToQueue, ["t2"]);
    assert.deepEqual(controlsCalls.playTrack, []);
    assert.equal(h.latest().mode, "explore");
    assert.equal(h.latest().travel, null);

    await h.unmount();
});

test("travel mode: shift-click on a neighbour queues it without navigating away from the current node", async () => {
    const h = await mountVibe();

    // Plain click enters travel and plays t2.
    await h.act(() => {
        h.latest().onDotClick("t2", { ctrlOrMeta: false, shift: false });
    });
    assert.equal(h.latest().mode, "travel");
    assert.equal(h.latest().travel?.currentId, "t2");
    assert.deepEqual(controlsCalls.playTrack, ["t2"]);

    // Shift-click a different dot: queues it, current node unchanged, no
    // second play.
    await h.act(() => {
        h.latest().onDotClick("t3", { ctrlOrMeta: false, shift: true });
    });
    assert.deepEqual(controlsCalls.addToQueue, ["t3"]);
    assert.deepEqual(controlsCalls.playTrack, ["t2"]); // unchanged
    assert.equal(h.latest().travel?.currentId, "t2"); // still t2, not t3

    await h.unmount();
});

test("alchemy mode: shift-click on a dot queues it instead of adding it as an ingredient", async () => {
    const h = await mountVibe();

    // Ctrl-click enters alchemy with t2 as the first ingredient.
    await h.act(() => {
        h.latest().onDotClick("t2", { ctrlOrMeta: true, shift: false });
    });
    assert.equal(h.latest().mode, "alchemy");
    assert.deepEqual(
        h.latest().alchemy?.ingredients.map((i) => i.id),
        ["t2"]
    );

    // Shift-click a different dot: queues it, ingredient list untouched.
    await h.act(() => {
        h.latest().onDotClick("t3", { ctrlOrMeta: false, shift: true });
    });
    assert.deepEqual(controlsCalls.addToQueue, ["t3"]);
    assert.deepEqual(
        h.latest().alchemy?.ingredients.map((i) => i.id),
        ["t2"]
    );
    assert.deepEqual(controlsCalls.playTrack, []);

    await h.unmount();
});

test("journey mode (not picking): shift-click on a dot queues it and leaves the destination untouched", async () => {
    const h = await mountVibe();

    await h.act(() => {
        h.latest().startJourney();
    });
    assert.equal(h.latest().mode, "journey");
    assert.equal(h.latest().journey?.picking, false);
    assert.equal(h.latest().journey?.destTrackId, null);

    await h.act(() => {
        h.latest().onDotClick("t3", { ctrlOrMeta: false, shift: true });
    });
    assert.deepEqual(controlsCalls.addToQueue, ["t3"]);
    assert.equal(h.latest().journey?.destTrackId, null);
    assert.deepEqual(controlsCalls.playTrack, []);

    await h.unmount();
});

test("journey mode (picking): the destination intercept wins over shift — click sets destination instead of queueing", async () => {
    const h = await mountVibe();

    await h.act(() => {
        h.latest().startJourney();
    });
    await h.act(() => {
        h.latest().journey?.togglePick();
    });
    assert.equal(h.latest().journey?.picking, true);

    // Shift held while picking: ordering constraint #1 (the journey/picking
    // intercept) stays first — a click while picking sets the destination,
    // shift or not.
    await h.act(() => {
        h.latest().onDotClick("t3", { ctrlOrMeta: false, shift: true });
    });
    assert.equal(h.latest().journey?.destTrackId, "t3");
    assert.deepEqual(controlsCalls.addToQueue, []);

    await h.unmount();
});

test("ctrl+shift on a dot: ctrl/alchemy-add still wins over shift (ordering constraint #2 preserved)", async () => {
    const h = await mountVibe();
    assert.equal(h.latest().mode, "explore");

    await h.act(() => {
        h.latest().onDotClick("t2", { ctrlOrMeta: true, shift: true });
    });

    assert.equal(h.latest().mode, "alchemy");
    assert.deepEqual(
        h.latest().alchemy?.ingredients.map((i) => i.id),
        ["t2"]
    );
    assert.deepEqual(controlsCalls.addToQueue, []);

    await h.unmount();
});

test("journey teardown resets loading before the mode is re-entered", async () => {
    const h = await mountVibe();
    await h.act(() => h.latest().startJourney());
    await h.act(() => h.latest().journey?.chooseMood("moodHappy"));
    await h.act(() => h.latest().journey?.submit());
    assert.equal(h.latest().journey?.loading, true);
    assert.equal(apiCalls.journey.length, 1);

    await h.act(() => h.latest().exitToExplore());
    await h.act(() => h.latest().startJourney());

    assert.equal(h.latest().journey?.loading, false);
    apiCalls.journey[0].resolve({ target: {}, waypoints: [] });
    await h.act(async () => { await apiCalls.journey[0].promise; });
    assert.equal(h.latest().journey?.loading, false);
    await h.unmount();
});

test("alchemy teardown resets loading before the mode is re-entered", async () => {
    const h = await mountVibe();
    await h.act(() =>
        h.latest().onDotClick("t2", { ctrlOrMeta: true, shift: false })
    );
    await h.act(() =>
        h.latest().onDotClick("t3", { ctrlOrMeta: true, shift: false })
    );
    await h.act(() => h.latest().alchemy?.blend());
    assert.equal(h.latest().alchemy?.loading, true);
    assert.equal(apiCalls.alchemy.length, 1);

    await h.act(() => h.latest().exitToExplore());
    await h.act(() =>
        h.latest().onDotClick("t4", { ctrlOrMeta: true, shift: false })
    );

    assert.equal(h.latest().alchemy?.loading, false);
    apiCalls.alchemy[0].resolve({ tracks: [] });
    await h.act(async () => { await apiCalls.alchemy[0].promise; });
    assert.equal(h.latest().alchemy?.loading, false);
    await h.unmount();
});

test("journey teardown resets saving before the mode is re-entered", async () => {
    const h = await mountVibe();
    await h.act(() => h.latest().startJourney());
    await h.act(() => h.latest().journey?.chooseMood("moodHappy"));
    await h.act(() => h.latest().journey?.submit());
    apiCalls.journey[0].resolve({
        target: { label: "Happy" },
        waypoints: [
            {
                ...mapTrack("t2"),
                distance: 0.2,
                similarity: 0.8,
                artist: { id: "ar-t2", name: "t2 artist" },
                album: { id: "al-t2", title: "", coverUrl: null },
            },
        ],
    });
    await h.act(async () => { await apiCalls.journey[0].promise; });
    await h.act(() => {
        void h.latest().journey?.save();
    });
    assert.equal(h.latest().journey?.saving, true);

    await h.act(() => h.latest().exitToExplore());
    await h.act(() => h.latest().startJourney());

    assert.equal(h.latest().journey?.saving, false);
    apiCalls.playlists[0].resolve({ id: "playlist-1" });
    await h.act(async () => { await apiCalls.playlists[0].promise; });
    assert.equal(h.latest().journey?.saving, false);
    await h.unmount();
});
