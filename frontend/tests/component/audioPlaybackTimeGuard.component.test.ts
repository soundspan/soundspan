import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    shouldAcceptEngineTimeUpdate,
    type ActivePlaybackSelection,
} from "../../lib/audio-playback-persistence-guards.ts";

/**
 * Integration-style tests for the timeupdate guard chain:
 * isLoadingRef gate → shouldAcceptEngineTimeUpdate (track-identity + seek-lock).
 *
 * These tests simulate the guard sequence from the AudioPlaybackOrchestrator's
 * handleTimeUpdate callback without requiring React rendering.
 */

const SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC = 0.2;

interface TimeupdateGuardContext {
    isLoading: boolean;
    activeSelection: ActivePlaybackSelection;
    seekState: { isSeekLocked: boolean; seekTarget: number | null };
}

function simulateTimeupdateGuard(
    ctx: TimeupdateGuardContext,
    currentTimeValue: number,
    invocationTrackId: string | null,
): { accepted: boolean; clearedLoading: boolean; unlockedSeek: boolean } {
    let clearedLoading = false;
    let isLoading = ctx.isLoading;

    // Mirrors the progress_before_load_event path in the orchestrator
    if (
        isLoading &&
        ctx.activeSelection.playbackType === "track" &&
        currentTimeValue >= SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC
    ) {
        isLoading = false;
        clearedLoading = true;
    }

    // isLoadingRef gate
    if (isLoading) {
        return { accepted: false, clearedLoading: false, unlockedSeek: false };
    }

    const decision = shouldAcceptEngineTimeUpdate(
        invocationTrackId,
        ctx.activeSelection,
        ctx.seekState,
        currentTimeValue,
    );

    return {
        accepted: decision !== "reject",
        clearedLoading,
        unlockedSeek: decision === "unlock-accept",
    };
}

describe("timeupdate during loading is dropped", () => {
    const trackSelection: ActivePlaybackSelection = {
        playbackType: "track",
        trackId: "t1",
        audiobookId: null,
        podcastId: null,
        trackEpoch: 1,
    };
    const noSeek = { isSeekLocked: false, seekTarget: null };

    test("timeupdate at 0.0 during loading is rejected", () => {
        const result = simulateTimeupdateGuard(
            { isLoading: true, activeSelection: trackSelection, seekState: noSeek },
            0.0,
            "t1",
        );
        assert.equal(result.accepted, false);
        assert.equal(result.clearedLoading, false);
    });

    test("timeupdate at 0.1 during loading is rejected (below threshold)", () => {
        const result = simulateTimeupdateGuard(
            { isLoading: true, activeSelection: trackSelection, seekState: noSeek },
            0.1,
            "t1",
        );
        assert.equal(result.accepted, false);
        assert.equal(result.clearedLoading, false);
    });
});

describe("timeupdate after load completes passes through", () => {
    const trackSelection: ActivePlaybackSelection = {
        playbackType: "track",
        trackId: "t1",
        audiobookId: null,
        podcastId: null,
        trackEpoch: 1,
    };
    const noSeek = { isSeekLocked: false, seekTarget: null };

    test("timeupdate passes when not loading", () => {
        const result = simulateTimeupdateGuard(
            { isLoading: false, activeSelection: trackSelection, seekState: noSeek },
            5.0,
            "t1",
        );
        assert.equal(result.accepted, true);
        assert.equal(result.clearedLoading, false);
    });

    test("timeupdate with mismatched trackId is still rejected after load", () => {
        const result = simulateTimeupdateGuard(
            { isLoading: false, activeSelection: trackSelection, seekState: noSeek },
            5.0,
            "t2",
        );
        assert.equal(result.accepted, false);
    });

    test("seek lock unlocks when engine time is near seek target", () => {
        const result = simulateTimeupdateGuard(
            {
                isLoading: false,
                activeSelection: trackSelection,
                seekState: { isSeekLocked: true, seekTarget: 10 },
            },
            9.2,
            "t1",
        );
        assert.equal(result.accepted, true);
        assert.equal(result.unlockedSeek, true);
    });

    test("seek lock rejects stale timeupdate when engine is far from seek target", () => {
        const result = simulateTimeupdateGuard(
            {
                isLoading: false,
                activeSelection: trackSelection,
                seekState: { isSeekLocked: true, seekTarget: 10 },
            },
            13.5,
            "t1",
        );
        assert.equal(result.accepted, false);
        assert.equal(result.unlockedSeek, false);
    });
});

describe("progress_before_load_event clears isLoadingRef", () => {
    const trackSelection: ActivePlaybackSelection = {
        playbackType: "track",
        trackId: "t1",
        audiobookId: null,
        podcastId: null,
        trackEpoch: 1,
    };
    const noSeek = { isSeekLocked: false, seekTarget: null };

    test("timeupdate at threshold clears loading and accepts", () => {
        const result = simulateTimeupdateGuard(
            { isLoading: true, activeSelection: trackSelection, seekState: noSeek },
            0.2,
            "t1",
        );
        assert.equal(result.accepted, true);
        assert.equal(result.clearedLoading, true);
    });

    test("timeupdate above threshold clears loading and accepts", () => {
        const result = simulateTimeupdateGuard(
            { isLoading: true, activeSelection: trackSelection, seekState: noSeek },
            1.5,
            "t1",
        );
        assert.equal(result.accepted, true);
        assert.equal(result.clearedLoading, true);
    });

    test("subsequent timeupdate after clearing passes without re-clearing", () => {
        // First call clears loading
        const first = simulateTimeupdateGuard(
            { isLoading: true, activeSelection: trackSelection, seekState: noSeek },
            0.5,
            "t1",
        );
        assert.equal(first.clearedLoading, true);

        // Simulate subsequent call with loading already false
        const second = simulateTimeupdateGuard(
            { isLoading: false, activeSelection: trackSelection, seekState: noSeek },
            1.0,
            "t1",
        );
        assert.equal(second.accepted, true);
        assert.equal(second.clearedLoading, false);
    });

    test("non-track playback does not clear loading via startup threshold", () => {
        const result = simulateTimeupdateGuard(
            {
                isLoading: true,
                activeSelection: {
                    playbackType: "audiobook",
                    trackId: null,
                    audiobookId: "ab1",
                    podcastId: null,
                    trackEpoch: 0,
                },
                seekState: noSeek,
            },
            12.0,
            null,
        );
        assert.equal(result.accepted, false);
        assert.equal(result.clearedLoading, false);
    });
});
