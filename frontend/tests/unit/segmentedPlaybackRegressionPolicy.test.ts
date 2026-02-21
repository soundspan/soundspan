import assert from "node:assert/strict";
import test from "node:test";
import {
    isSeekWithinTolerance,
    resolveBufferingRecoveryAction,
    resolveTrustedTrackPositionSec,
    shouldFallbackSegmentedStartupToDirect,
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

test("segmented startup fallback only triggers for active segmented load", () => {
    assert.equal(
        shouldFallbackSegmentedStartupToDirect({
            isLoading: true,
            sourceKind: "segmented",
            requestLoadId: 11,
            activeLoadId: 11,
        }),
        true,
    );

    assert.equal(
        shouldFallbackSegmentedStartupToDirect({
            isLoading: false,
            sourceKind: "segmented",
            requestLoadId: 11,
            activeLoadId: 11,
        }),
        false,
    );

    assert.equal(
        shouldFallbackSegmentedStartupToDirect({
            isLoading: true,
            sourceKind: "direct",
            requestLoadId: 11,
            activeLoadId: 11,
        }),
        false,
    );

    assert.equal(
        shouldFallbackSegmentedStartupToDirect({
            isLoading: true,
            sourceKind: "segmented",
            requestLoadId: 11,
            activeLoadId: 12,
        }),
        false,
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
    const guarded = resolveTrustedTrackPositionSec({
        fallbackPositionSec: 12.5,
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
        playbackType: "track",
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        isLoading: false,
        activeEngineTrackId: "track-1",
        enginePositionSec: 14.2,
    });
    assert.equal(accepted, 14.2);
});
