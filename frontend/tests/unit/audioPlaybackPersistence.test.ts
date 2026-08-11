import assert from "node:assert/strict";
import { after, describe, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { api } from "../../lib/api";
import {
    isPlaybackSelectionMatch,
    resolveTrackPersistenceEpoch,
    shouldAcceptEngineTimeUpdate,
    type ActivePlaybackSelection,
    type PlaybackPersistenceSnapshot,
} from "../../lib/audio-playback-persistence-guards";
import { resolveQueueAdvance } from "../../lib/audio/queue-advance-policy";
import { normalizeQueueItems } from "../../lib/queue-item";
import { normalizeQueueIndex } from "../../lib/playback-state-reconciliation";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type SavedPlaybackState = Parameters<typeof api.savePlaybackState>[0];
type AudioStateApi = ReturnType<
    (typeof import("../../lib/audio-state-context"))["useAudioState"]
>;

interface TestTrack {
    id: string;
    title: string;
    artist: { name: string };
    album: { title: string };
    duration: number;
    itemType: "track";
}

const savedPlaybackStates: SavedPlaybackState[] = [];
const getPlaybackStateMock = mock.method(
    api,
    "getPlaybackState",
    async () => null,
);
const savePlaybackStateMock = mock.method(
    api,
    "savePlaybackState",
    async (state: SavedPlaybackState) => {
        savedPlaybackStates.push(state);
        return null;
    },
);

after(() => {
    getPlaybackStateMock.mock.restore();
    savePlaybackStateMock.mock.restore();
    GlobalRegistrator.unregister();
});

function createTrack(index: number): TestTrack {
    return {
        id: `track-${index}`,
        title: `Track ${index}`,
        artist: { name: "Artist" },
        album: { title: "Album" },
        duration: 180,
        itemType: "track",
    };
}

function createQueue(length: number): TestTrack[] {
    return Array.from({ length }, (_, index) => createTrack(index));
}

async function persistTrackSnapshot(
    queue: TestTrack[],
    currentIndex: number,
    currentTrack: TestTrack,
): Promise<SavedPlaybackState> {
    localStorage.clear();
    savedPlaybackStates.length = 0;

    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider, useAudioState } =
        await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider } =
        await import("../../lib/audio-playback-context");
    const stateRef = { current: null as AudioStateApi | null };
    const Probe = () => {
        stateRef.current = useAudioState();
        return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(
                React.createElement(
                    AudioStateProvider,
                    null,
                    React.createElement(
                        AudioPlaybackProvider,
                        null,
                        React.createElement(Probe),
                    ),
                ),
            );
        });
        await React.act(async () => {
            assert.ok(stateRef.current, "expected audio state to be captured");
            stateRef.current.setQueue(queue);
            stateRef.current.setCurrentIndex(currentIndex);
            stateRef.current.setCurrentTrack(currentTrack);
            stateRef.current.setPlaybackType("track");
        });
        await React.act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }

    const savedState = savedPlaybackStates.at(-1);
    assert.ok(savedState, "expected playback state to be saved");
    return savedState;
}

describe("isPlaybackSelectionMatch", () => {
    test("returns false when playbackType differs", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "track",
            trackId: "t1",
            audiobookId: null,
            podcastId: null,
            trackEpoch: 0,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "audiobook",
            trackId: null,
            audiobookId: "a1",
            podcastId: null,
            trackEpoch: 0,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), false);
    });

    test("returns false when trackId differs", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "track",
            trackId: "t1",
            audiobookId: null,
            podcastId: null,
            trackEpoch: 1,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "track",
            trackId: "t2",
            audiobookId: null,
            podcastId: null,
            trackEpoch: 1,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), false);
    });

    test("returns false when trackEpoch differs (same trackId)", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "track",
            trackId: "t1",
            audiobookId: null,
            podcastId: null,
            trackEpoch: 2,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "track",
            trackId: "t1",
            audiobookId: null,
            podcastId: null,
            trackEpoch: 3,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), false);
    });

    test("returns true when track snapshot matches exactly", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "track",
            trackId: "t1",
            audiobookId: null,
            podcastId: null,
            trackEpoch: 5,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "track",
            trackId: "t1",
            audiobookId: null,
            podcastId: null,
            trackEpoch: 5,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), true);
    });

    test("returns false when snapshot trackId is null", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "track",
            trackId: null,
            audiobookId: null,
            podcastId: null,
            trackEpoch: 0,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "track",
            trackId: null,
            audiobookId: null,
            podcastId: null,
            trackEpoch: 0,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), false);
    });

    test("matches audiobook by audiobookId", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "audiobook",
            trackId: null,
            audiobookId: "ab1",
            podcastId: null,
            trackEpoch: 0,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "audiobook",
            trackId: null,
            audiobookId: "ab1",
            podcastId: null,
            trackEpoch: 0,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), true);
    });

    test("rejects audiobook when audiobookId differs", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "audiobook",
            trackId: null,
            audiobookId: "ab1",
            podcastId: null,
            trackEpoch: 0,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "audiobook",
            trackId: null,
            audiobookId: "ab2",
            podcastId: null,
            trackEpoch: 0,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), false);
    });

    test("matches podcast by podcastId", () => {
        const snapshot: PlaybackPersistenceSnapshot = {
            playbackType: "podcast",
            trackId: null,
            audiobookId: null,
            podcastId: "p1",
            trackEpoch: 0,
        };
        const active: ActivePlaybackSelection = {
            playbackType: "podcast",
            trackId: null,
            audiobookId: null,
            podcastId: "p1",
            trackEpoch: 0,
        };
        assert.equal(isPlaybackSelectionMatch(snapshot, active), true);
    });
});

describe("shouldAcceptEngineTimeUpdate", () => {
    const trackSelection: ActivePlaybackSelection = {
        playbackType: "track",
        trackId: "t1",
        audiobookId: null,
        podcastId: null,
        trackEpoch: 1,
    };
    const noSeek = { isSeekLocked: false, seekTarget: null };

    test("rejects when invocationTrackId is null for track playback", () => {
        assert.equal(
            shouldAcceptEngineTimeUpdate(null, trackSelection, noSeek, 10),
            "reject",
        );
    });

    test("rejects when invocationTrackId does not match active track", () => {
        assert.equal(
            shouldAcceptEngineTimeUpdate("t2", trackSelection, noSeek, 10),
            "reject",
        );
    });

    test("accepts when invocationTrackId matches active track", () => {
        assert.equal(
            shouldAcceptEngineTimeUpdate("t1", trackSelection, noSeek, 10),
            "accept",
        );
    });

    test("accepts for non-track playback regardless of invocationTrackId", () => {
        const podcastSelection: ActivePlaybackSelection = {
            playbackType: "podcast",
            trackId: null,
            audiobookId: null,
            podcastId: "p1",
            trackEpoch: 0,
        };
        assert.equal(
            shouldAcceptEngineTimeUpdate(null, podcastSelection, noSeek, 5),
            "accept",
        );
    });

    test("rejects stale time during seek lock (far from target)", () => {
        const seekState = { isSeekLocked: true, seekTarget: 100 };
        assert.equal(
            shouldAcceptEngineTimeUpdate("t1", trackSelection, seekState, 50),
            "reject",
        );
    });

    test("returns unlock-accept when near seek target", () => {
        const seekState = { isSeekLocked: true, seekTarget: 100 };
        assert.equal(
            shouldAcceptEngineTimeUpdate("t1", trackSelection, seekState, 99.5),
            "unlock-accept",
        );
    });

    test("returns unlock-accept at exactly 2s boundary", () => {
        const seekState = { isSeekLocked: true, seekTarget: 100 };
        // Math.abs(98.1 - 100) = 1.9 < 2 → near target
        assert.equal(
            shouldAcceptEngineTimeUpdate("t1", trackSelection, seekState, 98.1),
            "unlock-accept",
        );
        // Math.abs(97.9 - 100) = 2.1 >= 2 → not near target
        assert.equal(
            shouldAcceptEngineTimeUpdate("t1", trackSelection, seekState, 97.9),
            "reject",
        );
    });
});

describe("resolveTrackPersistenceEpoch", () => {
    test("prefers ref epoch when hydration advances it before state", () => {
        assert.equal(resolveTrackPersistenceEpoch(0, 1), 1);
    });

    test("returns state epoch when state is current", () => {
        assert.equal(resolveTrackPersistenceEpoch(3, 3), 3);
        assert.equal(resolveTrackPersistenceEpoch(4, 2), 4);
    });
});

describe("playback queue persistence", () => {
    test("windows a large queue around the current track and retains upcoming items", async () => {
        const queue = createQueue(900);

        const payload = await persistTrackSnapshot(queue, 450, queue[450]);

        const persistedQueue = payload.queue ?? [];
        assert.ok(persistedQueue.length <= 100);
        assert.equal(payload.currentIndex, 10);
        assert.equal(persistedQueue[payload.currentIndex]?.id, payload.trackId);
        assert.equal(
            persistedQueue.filter((item) => item.id === payload.trackId).length,
            1,
        );
        assert.ok(
            persistedQueue.some((item) => item.id === "track-451"),
            "expected the persisted window to include items ahead of the current track",
        );
    });

    test("keeps the prefix window and live index near the start of the queue", async () => {
        const queue = createQueue(900);

        const payload = await persistTrackSnapshot(queue, 5, queue[5]);

        assert.equal(payload.queue?.length, 100);
        assert.equal(payload.queue?.[0]?.id, "track-0");
        assert.equal(payload.currentIndex, 5);
        assert.equal(
            payload.queue?.[payload.currentIndex]?.id,
            payload.trackId,
        );
    });

    test("omits queue position when the live track does not match the rebased index", async () => {
        const queue = createQueue(900);
        const currentTrack = createTrack(450);
        queue[450] = createTrack(451);

        const payload = await persistTrackSnapshot(queue, 450, currentTrack);

        assert.equal(payload.trackId, currentTrack.id);
        assert.equal(Object.hasOwn(payload, "queue"), false);
        assert.equal(Object.hasOwn(payload, "currentIndex"), false);
    });

    test("restored large-queue snapshot advances from its rebased index", async () => {
        const queue = createQueue(900);
        const payload = await persistTrackSnapshot(queue, 450, queue[450]);
        const restoredQueue = normalizeQueueItems(payload.queue);
        const restoredIndex = normalizeQueueIndex(
            payload.currentIndex,
            restoredQueue.length,
        );

        const advance = resolveQueueAdvance({
            action: "next",
            queue: restoredQueue,
            currentIndex: restoredIndex,
            isShuffle: false,
            shuffleIndices: [],
            repeatMode: "off",
        });

        assert.deepEqual(advance, { kind: "track", index: 11 });
    });
});
