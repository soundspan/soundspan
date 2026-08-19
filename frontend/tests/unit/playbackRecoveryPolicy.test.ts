import assert from "node:assert/strict";
import test from "node:test";
import {
    createStartupStabilityWindow,
    isSeekWithinTolerance,
    noteStartupProgressTransition,
    resolveBufferingRecoveryAction,
    resolveCorrelatedRecoveryResumeDecision,
    resolveStartupGuardedRecoveryPositionSec,
    resolveTrustedTrackPositionSec,
} from "../../lib/audio-engine/playbackRecoveryPolicy";

const trustedInput = {
    fallbackPositionSec: 42,
    fallbackTrackId: "track-1",
    playbackType: "track",
    currentTrackId: "track-1",
    targetTrackId: "track-1",
    isLoading: false,
    activeEngineTrackId: "track-1",
    enginePositionSec: 44,
};

test("trusted position uses the engine position when everything correlates", () => {
    assert.equal(resolveTrustedTrackPositionSec(trustedInput), 44);
});

test("trusted position falls back on drift, loading, or track mismatch", () => {
    assert.equal(
        resolveTrustedTrackPositionSec({
            ...trustedInput,
            enginePositionSec: 90,
        }),
        42,
    );
    assert.equal(
        resolveTrustedTrackPositionSec({ ...trustedInput, isLoading: true }),
        42,
    );
    assert.equal(
        resolveTrustedTrackPositionSec({
            ...trustedInput,
            fallbackTrackId: "other-track",
        }),
        0,
    );
});

test("startup-guarded recovery anchors to zero before first progress", () => {
    // A stale persisted timestamp must not survive a failed startup: no
    // observed progress for the target track forces the anchor to 0.
    assert.equal(
        resolveStartupGuardedRecoveryPositionSec({
            targetTrackId: "track-1",
            trustedPositionSec: 42,
            startupStabilityTrackId: "track-1",
            startupFirstProgressAtMs: null,
        }),
        0,
    );
    assert.equal(
        resolveStartupGuardedRecoveryPositionSec({
            targetTrackId: "track-1",
            trustedPositionSec: 42,
            startupStabilityTrackId: "track-1",
            startupFirstProgressAtMs: 1_000,
        }),
        42,
    );
    // A different tracked track means the guard does not apply.
    assert.equal(
        resolveStartupGuardedRecoveryPositionSec({
            targetTrackId: "track-1",
            trustedPositionSec: 42,
            startupStabilityTrackId: "track-2",
            startupFirstProgressAtMs: null,
        }),
        42,
    );
});

test("correlated resume rejects stale track/load transitions", () => {
    const matched = resolveCorrelatedRecoveryResumeDecision({
        requestedResumeAtSec: 17,
        expectedTrackId: "track-1",
        activeTrackId: "track-1",
        expectedLoadId: 3,
        activeLoadId: 3,
    });
    assert.deepEqual(matched, {
        resumeAtSec: 17,
        matched: true,
        mismatchReason: "none",
    });

    assert.equal(
        resolveCorrelatedRecoveryResumeDecision({
            requestedResumeAtSec: 17,
            expectedTrackId: "track-1",
            activeTrackId: "track-2",
            expectedLoadId: 3,
            activeLoadId: 3,
        }).mismatchReason,
        "track_mismatch",
    );
    assert.equal(
        resolveCorrelatedRecoveryResumeDecision({
            requestedResumeAtSec: 17,
            expectedTrackId: "track-1",
            activeTrackId: "track-1",
            expectedLoadId: 3,
            activeLoadId: 4,
        }).mismatchReason,
        "load_mismatch",
    );
});

test("buffering recovery reconciles machine and engine state", () => {
    assert.equal(
        resolveBufferingRecoveryAction({
            machineIsBuffering: true,
            machineIsPlaying: false,
            engineIsPlaying: false,
        }),
        "transition_playing",
    );
    assert.equal(
        resolveBufferingRecoveryAction({
            machineIsBuffering: false,
            machineIsPlaying: false,
            engineIsPlaying: true,
        }),
        "force_playing",
    );
    assert.equal(
        resolveBufferingRecoveryAction({
            machineIsBuffering: false,
            machineIsPlaying: true,
            engineIsPlaying: true,
        }),
        "noop",
    );
});

test("seek tolerance guards non-finite inputs and honors the threshold", () => {
    assert.equal(isSeekWithinTolerance(100, 103), true);
    assert.equal(isSeekWithinTolerance(100, 108), false);
    assert.equal(isSeekWithinTolerance(100, 101, 0.5), false);
    assert.equal(isSeekWithinTolerance(Number.NaN, 100), false);
});

test("startup stability stamps first progress only on real movement", () => {
    let snapshot = createStartupStabilityWindow("track-1");
    assert.equal(snapshot.firstProgressAtMs, null);

    // Frozen time: repeated identical positions never earn the stamp.
    snapshot = noteStartupProgressTransition(snapshot, "track-1", 0, 1_000);
    snapshot = noteStartupProgressTransition(snapshot, "track-1", 0, 2_000);
    assert.equal(snapshot.firstProgressAtMs, null);

    // Sub-threshold movement (< 0.2s position) still does not count.
    snapshot = noteStartupProgressTransition(snapshot, "track-1", 0.1, 3_000);
    assert.equal(snapshot.firstProgressAtMs, null);

    // Real movement stamps first progress once.
    snapshot = noteStartupProgressTransition(snapshot, "track-1", 0.5, 4_000);
    assert.equal(snapshot.firstProgressAtMs, 4_000);
    snapshot = noteStartupProgressTransition(snapshot, "track-1", 1.2, 5_000);
    assert.equal(snapshot.firstProgressAtMs, 4_000);
});

test("startup stability resets when the track changes", () => {
    let snapshot = createStartupStabilityWindow("track-1");
    snapshot = noteStartupProgressTransition(snapshot, "track-1", 0.5, 1_000);
    assert.equal(snapshot.firstProgressAtMs, 1_000);

    snapshot = noteStartupProgressTransition(snapshot, "track-2", 0.4, 2_000);
    assert.equal(snapshot.trackId, "track-2");
    assert.equal(snapshot.firstProgressAtMs, null);
});
