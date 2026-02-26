import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    isPlaybackSelectionMatch,
    resolveTrackPersistenceEpoch,
    shouldAcceptEngineTimeUpdate,
    type ActivePlaybackSelection,
    type PlaybackPersistenceSnapshot,
} from "../../lib/audio-playback-persistence-guards.ts";

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
