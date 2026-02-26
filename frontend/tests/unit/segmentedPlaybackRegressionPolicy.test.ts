import assert from "node:assert/strict";
import test from "node:test";
import {
    isSeekWithinTolerance,
    resolveStartupGuardedRecoveryPositionSec,
    resolveSegmentedStartupRetryDelayMs,
    resolveBufferingRecoveryAction,
    resolveTrustedTrackPositionSec,
    shouldRetrySegmentedStartupTimeout,
} from "../../lib/audio-engine/segmentedPlaybackRegressionPolicy.ts";
import { resolveProactiveSegmentedHandoffEligibility } from "../../lib/audio-engine/segmentedStartupPolicy.ts";

test("direct->segmented handoff eligibility remains deterministic", () => {
    const result = resolveProactiveSegmentedHandoffEligibility({
        playbackType: "track",
        isListenTogether: false,
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        activeSegmentedTrackId: null,
        attemptedTrackId: null,
    });

    assert.equal(result.eligible, true);
    assert.equal(result.reason, "eligible");
});

test("segmented startup retry gating only triggers for active segmented load", () => {
    assert.equal(
        shouldRetrySegmentedStartupTimeout({
            isLoading: true,
            sourceKind: "segmented",
            requestLoadId: 11,
            activeLoadId: 11,
        }),
        true,
    );

    assert.equal(
        shouldRetrySegmentedStartupTimeout({
            isLoading: false,
            sourceKind: "segmented",
            requestLoadId: 11,
            activeLoadId: 11,
        }),
        false,
    );

    assert.equal(
        shouldRetrySegmentedStartupTimeout({
            isLoading: true,
            sourceKind: "direct",
            requestLoadId: 11,
            activeLoadId: 11,
        }),
        false,
    );

    assert.equal(
        shouldRetrySegmentedStartupTimeout({
            isLoading: true,
            sourceKind: "segmented",
            requestLoadId: 11,
            activeLoadId: 12,
        }),
        false,
    );
});

test("segmented startup retry delay is bounded from attempt start", () => {
    assert.equal(
        resolveSegmentedStartupRetryDelayMs({
            isLoading: true,
            sourceKind: "segmented",
            requestLoadId: 17,
            activeLoadId: 17,
            startupAttemptStartedAtMs: 1_000,
            retryTimeoutMs: 2_500,
            nowMs: 2_300,
        }),
        1_200,
    );

    assert.equal(
        resolveSegmentedStartupRetryDelayMs({
            isLoading: true,
            sourceKind: "segmented",
            requestLoadId: 17,
            activeLoadId: 17,
            startupAttemptStartedAtMs: 1_000,
            retryTimeoutMs: 2_500,
            nowMs: 3_700,
        }),
        0,
    );

    assert.equal(
        resolveSegmentedStartupRetryDelayMs({
            isLoading: true,
            sourceKind: "direct",
            requestLoadId: 17,
            activeLoadId: 17,
            startupAttemptStartedAtMs: 1_000,
            retryTimeoutMs: 2_500,
            nowMs: 1_200,
        }),
        null,
    );
});

test("buffering recovery action prioritizes state-machine recovery before forced sync", () => {
    assert.equal(
        resolveBufferingRecoveryAction({
            machineIsBuffering: true,
            machineIsPlaying: false,
            engineIsPlaying: true,
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

test("seek continuity tolerance check is stable around threshold", () => {
    assert.equal(isSeekWithinTolerance(102.4, 100), true);
    assert.equal(isSeekWithinTolerance(105.1, 100), false);
    assert.equal(isSeekWithinTolerance(Number.NaN, 100), false);
});

test("trusted track position guards against stale-time jump regression", () => {
    const staleFallback = resolveTrustedTrackPositionSec({
        fallbackPositionSec: 50,
        fallbackTrackId: "track-previous",
        playbackType: "track",
        currentTrackId: "track-next",
        targetTrackId: "track-next",
        isLoading: true,
        activeEngineTrackId: null,
        enginePositionSec: 0,
    });
    assert.equal(staleFallback, 0);

    const guarded = resolveTrustedTrackPositionSec({
        fallbackPositionSec: 12.5,
        fallbackTrackId: "track-1",
        playbackType: "track",
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        isLoading: false,
        activeEngineTrackId: "track-1",
        enginePositionSec: 94.8,
    });
    assert.equal(guarded, 12.5);

    const accepted = resolveTrustedTrackPositionSec({
        fallbackPositionSec: 12.5,
        fallbackTrackId: "track-1",
        playbackType: "track",
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        isLoading: false,
        activeEngineTrackId: "track-1",
        enginePositionSec: 14.2,
    });
    assert.equal(accepted, 14.2);
});

test("startup-guarded recovery clamps stale recovery seek before first progress", () => {
    const clamped = resolveStartupGuardedRecoveryPositionSec({
        targetTrackId: "track-1",
        trustedPositionSec: 381.7,
        startupStabilityTrackId: "track-1",
        startupFirstProgressAtMs: null,
    });
    assert.equal(clamped, 0);

    const preservedAfterProgress = resolveStartupGuardedRecoveryPositionSec({
        targetTrackId: "track-1",
        trustedPositionSec: 381.7,
        startupStabilityTrackId: "track-1",
        startupFirstProgressAtMs: 1_234,
    });
    assert.equal(preservedAfterProgress, 381.7);

    const preservedForOtherTrack = resolveStartupGuardedRecoveryPositionSec({
        targetTrackId: "track-1",
        trustedPositionSec: 381.7,
        startupStabilityTrackId: "track-2",
        startupFirstProgressAtMs: null,
    });
    assert.equal(preservedForOtherTrack, 381.7);
});
