import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Episode } from "../../features/podcast/types";
import { createConsecutiveErrorBreaker } from "../../lib/audio-engine/consecutiveErrorBreaker";
import {
    consumePlaybackAdvanceOrigin,
    playbackAdvanceOriginRef,
    setPlaybackAutoRestartSuppressed,
} from "../../lib/audio-engine/playbackAdvanceOrigin";

/**
 * Behavior tests for the mixed-queue UX fixes in
 * lib/audio-controls-context.tsx (PR #2 follow-ups):
 *
 *  1. removeFromQueue of the playing LAST item persists the outgoing
 *     episode's progress and routes the new current item through the
 *     shared startQueueItemAtIndex resume path.
 *  2. addTracksToQueue's legacy-state seed (episode playing, empty queue)
 *     seeds a real shuffle order instead of identity indices.
 *  3. addEpisodeToQueue (and the addTracksToQueue append) compute appended
 *     shuffle indices inside the functional updater, so rapid adds never
 *     stamp the same index twice.
 *  4. Skipping into an episode advances currentIndex immediately, so a
 *     second next() during the saved-progress lookup window skips past it.
 *
 * The audio state stub models React's state batching: setter calls are
 * queued and only applied by `commit()`, which stands in for a re-render
 * between user interactions. Calls made without an intervening commit
 * therefore observe the same committed snapshot, exactly like two calls
 * within one render.
 */

const stateHolder: { current: Record<string, unknown> } = { current: {} };
const playbackHolder: { current: Record<string, unknown> } = { current: {} };
const apiCalls: { updatePodcastProgress: unknown[][] } = {
    updatePodcastProgress: [],
};
const getPodcastImpl: { current: (id: string) => Promise<unknown> } = {
    current: async () => ({ episodes: [] }),
};

afterEach(() => {
    playbackAdvanceOriginRef.current = null;
    setPlaybackAutoRestartSuppressed(false);
});

mock.module("@/lib/audio-volume-mode-context", {
    namedExports: {
        useAudioVolumeMode: () => ({
            volume: 1,
            isMuted: false,
            playerMode: "full",
            previousPlayerMode: "full",
            setVolume: () => undefined,
            setIsMuted: () => undefined,
            setPlayerMode: () => undefined,
            setPreviousPlayerMode: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: { useAudioState: () => stateHolder.current },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => playbackHolder.current,
        usePlaybackStatus: () => playbackHolder.current,
        usePlaybackProgress: () => playbackHolder.current,
    },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            updatePodcastProgress: (...args: unknown[]) => {
                apiCalls.updatePodcastProgress.push(args);
                return Promise.resolve({});
            },
            getPodcast: (id: string) => getPodcastImpl.current(id),
            clearPlaybackState: async () => ({}),
        },
    },
});
mock.module("@/lib/listen-together-socket", {
    namedExports: {
        listenTogetherSocket: {
            hasActiveGroup: false,
            activeGroupId: null,
        },
    },
});
mock.module("@/lib/listen-together-session", {
    namedExports: {
        enqueueLatestListenTogetherHostTrackOperation: () => undefined,
        getListenTogetherOptimisticTrackSelectionPolicy: () => ({
            resetPersistedTrackStartPosition: false,
        }),
        getListenTogetherSessionSnapshot: () => null,
    },
});
mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            error: () => undefined,
            info: () => undefined,
        },
    },
});
mock.module("@/lib/query-events", {
    namedExports: { dispatchQueryEvent: () => undefined },
});

type DeferredAudioState = Record<string, unknown> & { commit: () => void };

function createDeferredAudioState(
    initial: Record<string, unknown>,
): DeferredAudioState {
    const pending: Array<() => void> = [];
    const stub: DeferredAudioState = {
        currentTrack: null,
        currentPodcast: null,
        currentAudiobook: null,
        playbackType: null,
        queue: [],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
        repeatOneCount: 0,
        vibeMode: false,
        vibeSourceFeatures: null,
        vibeQueueIds: [],
        playerMode: "full",
        previousPlayerMode: "full",
        volume: 1,
        isMuted: false,
        ...initial,
        commit: () => {
            while (pending.length > 0) {
                (pending.shift() as () => void)();
            }
        },
    };

    const settableKeys = [
        "queue",
        "currentIndex",
        "currentTrack",
        "currentPodcast",
        "currentAudiobook",
        "playbackType",
        "shuffleIndices",
        "isShuffle",
        "repeatMode",
        "repeatOneCount",
        "vibeMode",
        "vibeSourceFeatures",
        "vibeQueueIds",
        "playerMode",
        "previousPlayerMode",
        "volume",
        "isMuted",
    ];
    for (const key of settableKeys) {
        const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        stub[setterName] = (value: unknown) => {
            pending.push(() => {
                stub[key] =
                    typeof value === "function"
                        ? (value as (prev: unknown) => unknown)(stub[key])
                        : value;
            });
        };
    }
    return stub;
}

function createPlaybackStub(
    initial: { currentTime?: number; duration?: number } = {},
) {
    return {
        currentTime: initial.currentTime ?? 0,
        duration: initial.duration ?? 0,
        isPlaying: false,
        setIsPlaying(value: boolean) {
            this.isPlaying = value;
        },
        setCurrentTime(value: number) {
            this.currentTime = value;
        },
        lockSeek: () => undefined,
    };
}

async function renderControls(options: {
    state: DeferredAudioState;
    playback: Record<string, unknown>;
}) {
    stateHolder.current = options.state;
    playbackHolder.current = options.playback;
    apiCalls.updatePodcastProgress.length = 0;

    const { AudioControlsProvider, useAudioControls } =
        await import("../../lib/audio-controls-context");

    const capturedRef: {
        current: ReturnType<typeof useAudioControls> | null;
    } = { current: null };
    const Probe = () => {
        capturedRef.current = useAudioControls();
        return React.createElement("div", null, "controls-ready");
    };
    const html = renderToStaticMarkup(
        React.createElement(
            AudioControlsProvider,
            null,
            React.createElement(Probe),
        ),
    );
    assert.ok(html.includes("controls-ready"));
    assert.ok(capturedRef.current);
    return capturedRef.current;
}

const flushAsync = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
};

function makeTrack(id: string, artistId: string) {
    return {
        id,
        title: `Track ${id}`,
        duration: 200,
        artist: { id: artistId, name: `Artist ${artistId}` },
        album: { id: `album-${id}`, title: `Album ${id}` },
    };
}

async function makeEpisodeQueueItem(
    podcastId: string,
    episodeId: string,
    duration = 1800,
) {
    const { buildEpisodeQueueItem } = await import("../../lib/queue-item");
    return buildEpisodeQueueItem({
        podcastId,
        episodeId,
        title: `Episode ${episodeId}`,
        podcastTitle: "Podcast",
        coverUrl: null,
        duration,
    });
}

test("removeFromQueue of the playing last episode persists its progress and starts the remaining track", async () => {
    const trackA = makeTrack("t1", "a1");
    const outgoing = await makeEpisodeQueueItem("pod1", "ep1", 3600);
    const state = createDeferredAudioState({
        queue: [trackA, outgoing],
        currentIndex: 1,
        playbackType: "podcast",
        currentPodcast: {
            id: outgoing.id,
            title: outgoing.title,
            podcastTitle: outgoing.podcastTitle,
            coverUrl: null,
            duration: 3600,
            progress: { currentTime: 500, progress: 14, isFinished: false },
        },
    });
    const playback = createPlaybackStub({ currentTime: 500, duration: 3600 });

    const controls = await renderControls({ state, playback });
    controls.removeFromQueue(1);
    state.commit();

    // The playing episode's position must be persisted before the switch.
    assert.deepEqual(apiCalls.updatePodcastProgress, [
        ["pod1", "ep1", 500, 3600, false],
    ]);

    assert.equal((state.queue as unknown[]).length, 1);
    assert.equal(state.currentIndex, 0);
    assert.equal((state.currentTrack as { id: string }).id, "t1");
    assert.equal(state.playbackType, "track");
    assert.equal(state.currentPodcast, null);
    assert.equal(playback.isPlaying, true);
    assert.equal(playback.currentTime, 0);
});

test("removeFromQueue of the playing last item resumes the new current episode from saved progress", async () => {
    const upNext = await makeEpisodeQueueItem("pod1", "ep2", 1800);
    const outgoing = await makeEpisodeQueueItem("pod1", "ep1", 3600);
    getPodcastImpl.current = async () => ({
        episodes: [
            {
                id: "ep2",
                title: upNext.title,
                duration: 1800,
                progress: { currentTime: 111, progress: 6, isFinished: false },
            },
        ],
    });
    const state = createDeferredAudioState({
        queue: [upNext, outgoing],
        currentIndex: 1,
        playbackType: "podcast",
        currentPodcast: {
            id: outgoing.id,
            title: outgoing.title,
            podcastTitle: outgoing.podcastTitle,
            coverUrl: null,
            duration: 3600,
            progress: { currentTime: 500, progress: 14, isFinished: false },
        },
    });
    const playback = createPlaybackStub({ currentTime: 500, duration: 3600 });

    const controls = await renderControls({ state, playback });
    controls.removeFromQueue(1);
    state.commit();
    await flushAsync();
    state.commit();

    assert.deepEqual(apiCalls.updatePodcastProgress, [
        ["pod1", "ep1", 500, 3600, false],
    ]);

    assert.equal(state.currentIndex, 0);
    assert.equal(state.playbackType, "podcast");
    const current = state.currentPodcast as {
        id: string;
        progress: { currentTime: number } | null;
    };
    assert.equal(current.id, upNext.id);
    // The partially-listened episode resumes instead of restarting at 0:00.
    assert.equal(current.progress?.currentTime, 111);
    assert.equal(playback.currentTime, 111);
    assert.equal(playback.isPlaying, true);
});

test("addTracksToQueue over a legacy playing episode seeds a real shuffle order", async (t) => {
    t.mock.method(Math, "random", () => 0);

    const state = createDeferredAudioState({
        queue: [],
        currentIndex: 0,
        playbackType: "podcast",
        currentPodcast: {
            id: "pod1:ep1",
            title: "Episode ep1",
            podcastTitle: "Podcast",
            coverUrl: null,
            duration: 1800,
            progress: null,
        },
        isShuffle: true,
        shuffleIndices: [],
    });
    const playback = createPlaybackStub();

    const controls = await renderControls({ state, playback });
    controls.addTracksToQueue(
        [makeTrack("t1", "a1"), makeTrack("t2", "a2"), makeTrack("t3", "a3")],
        { silent: true },
    );
    state.commit();

    const queue = state.queue as Array<{ id: string }>;
    assert.equal(queue.length, 4);
    assert.equal(queue[0].id, "pod1:ep1");
    assert.equal(state.currentIndex, 0);

    const indices = state.shuffleIndices as number[];
    assert.equal(indices.length, 4);
    // The playing episode keeps position 0 in the shuffle order.
    assert.equal(indices[0], 0);
    // All queue positions participate exactly once...
    assert.deepEqual(
        [...indices].sort((a, b) => a - b),
        [0, 1, 2, 3],
    );
    // ...and the order is actually shuffled, not the sequential identity.
    assert.notDeepEqual(indices, [0, 1, 2, 3]);
});

test("rapid addEpisodeToQueue calls append distinct shuffle indices", async () => {
    const state = createDeferredAudioState({
        queue: [makeTrack("t1", "a1"), makeTrack("t2", "a2")],
        currentIndex: 0,
        playbackType: "track",
        currentTrack: makeTrack("t1", "a1"),
        isShuffle: true,
        shuffleIndices: [0, 1],
    });
    const playback = createPlaybackStub();

    const makeEpisode = (id: string): Episode =>
        ({
            id,
            title: `Ep ${id}`,
            duration: 900,
            progress: null,
        }) as unknown as Episode;
    const podcastMeta = { id: "pod1", title: "Podcast", coverUrl: null };

    const controls = await renderControls({ state, playback });
    controls.addEpisodeToQueue(makeEpisode("ep1"), podcastMeta);
    controls.addEpisodeToQueue(makeEpisode("ep2"), podcastMeta);
    state.commit();

    assert.equal((state.queue as unknown[]).length, 4);
    const indices = state.shuffleIndices as number[];
    // Every queue position must appear exactly once; the stale-snapshot bug
    // appended the same index twice so one position never played in shuffle.
    assert.deepEqual(
        [...indices].sort((a, b) => a - b),
        [0, 1, 2, 3],
    );
});

test("rapid addTracksToQueue appends stamp distinct shuffle indices", async () => {
    const state = createDeferredAudioState({
        queue: [makeTrack("t1", "a1"), makeTrack("t2", "a2")],
        currentIndex: 0,
        playbackType: "track",
        currentTrack: makeTrack("t1", "a1"),
        isShuffle: true,
        shuffleIndices: [0, 1],
    });
    const playback = createPlaybackStub();

    const controls = await renderControls({ state, playback });
    controls.addTracksToQueue([makeTrack("t3", "a3")], { silent: true });
    controls.addTracksToQueue([makeTrack("t4", "a4")], { silent: true });
    state.commit();

    assert.equal((state.queue as unknown[]).length, 4);
    const indices = state.shuffleIndices as number[];
    assert.deepEqual(
        [...indices].sort((a, b) => a - b),
        [0, 1, 2, 3],
    );
});

test("rapid next() skips advance past an episode while its progress lookup is pending", async () => {
    const pendingLookups: Array<(value: unknown) => void> = [];
    getPodcastImpl.current = () =>
        new Promise((resolve) => {
            pendingLookups.push(resolve);
        });

    const ep1 = await makeEpisodeQueueItem("pod1", "ep1");
    const ep2 = await makeEpisodeQueueItem("pod1", "ep2");
    const state = createDeferredAudioState({
        queue: [makeTrack("t1", "a1"), ep1, ep2],
        currentIndex: 0,
        playbackType: "track",
        currentTrack: makeTrack("t1", "a1"),
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    const playback = createPlaybackStub({ currentTime: 42, duration: 200 });

    const controls = await renderControls({ state, playback });

    // First skip lands on the first episode; the index must advance
    // immediately even though the saved-progress lookup is still pending.
    controls.next();
    state.commit();
    assert.equal(state.currentIndex, 1);

    // Second skip within the lookup window must move PAST the episode
    // instead of re-resolving to the same index (the dead-air bug).
    controls.next();
    state.commit();
    assert.equal(state.currentIndex, 2);

    // Late lookups settle: the stale ep1 resolution must not clobber ep2.
    for (const resolve of pendingLookups) {
        resolve({ episodes: [] });
    }
    await flushAsync();
    state.commit();

    assert.equal(state.currentIndex, 2);
    assert.equal(state.playbackType, "podcast");
    assert.equal((state.currentPodcast as { id: string }).id, ep2.id);
    assert.equal(playback.isPlaying, true);
});

test("moveQueueItem moves an upcoming item and remaps shuffle indices in lockstep", async () => {
    const tracks = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({
        id,
        title: id,
        artist: { name: "a" },
        album: { title: "al" },
        duration: 100,
    }));
    const state = createDeferredAudioState({
        queue: tracks,
        currentIndex: 0,
        isShuffle: true,
        // Shuffle order references queue POSITIONS.
        shuffleIndices: [0, 4, 2, 1, 3],
    });
    const playback = createPlaybackStub({ currentTime: 0, duration: 100 });
    const controls = await renderControls({ state, playback });

    // Move position 1 (t2) to position 3.
    controls.moveQueueItem(1, 3);
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((t) => t.id),
        ["t1", "t3", "t4", "t2", "t5"],
    );
    // Every shuffle entry still points at the same TRACK it did before:
    // old positions map 0->0, 1->3, 2->1, 3->2, 4->4.
    assert.deepEqual(state.shuffleIndices, [0, 4, 1, 3, 2]);
});

test("moveQueueItem refuses to move the current row or cross into history", async () => {
    const tracks = ["t1", "t2", "t3"].map((id) => ({
        id,
        title: id,
        artist: { name: "a" },
        album: { title: "al" },
        duration: 100,
    }));
    const state = createDeferredAudioState({
        queue: tracks,
        currentIndex: 1,
    });
    const playback = createPlaybackStub({ currentTime: 0, duration: 100 });
    const controls = await renderControls({ state, playback });

    controls.moveQueueItem(1, 2); // current row itself
    controls.moveQueueItem(2, 1); // upcoming into the current slot
    controls.moveQueueItem(2, 0); // upcoming into history
    state.commit();

    assert.deepEqual(
        (state.queue as Array<{ id: string }>).map((t) => t.id),
        ["t1", "t2", "t3"],
    );
    assert.equal(state.currentIndex, 1);
});

test("repeat toggle resets two prior failures before the next failure", async () => {
    const currentTrack = makeTrack("repeat-current", "artist-1");
    const state = createDeferredAudioState({
        queue: [currentTrack],
        currentIndex: 0,
        currentTrack,
        playbackType: "track",
        repeatMode: "off",
    });
    const controls = await renderControls({
        state,
        playback: createPlaybackStub(),
    });
    const breaker = createConsecutiveErrorBreaker();
    breaker.recordError();
    breaker.recordError();

    controls.toggleRepeat();
    state.commit();
    const origin = consumePlaybackAdvanceOrigin();
    if (origin?.origin === "manual") breaker.reset();
    const tripped = breaker.recordError();

    assert.equal(state.repeatMode, "all");
    assert.equal(origin?.origin, "manual");
    assert.equal(tripped, false);
    assert.equal(breaker.getErrorCount(), 1);
});
