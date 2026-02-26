import assert from "node:assert/strict";
import test from "node:test";
import {
    isSeekWithinTolerance,
    resolveHeartbeatGuardedRefreshDecision,
    resolveCorrelatedRecoveryResumeDecision,
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

test("heartbeat guarded refresh only triggers after threshold and outside cooldown", () => {
    const belowThreshold = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: 2,
        failureThreshold: 3,
        lastRefreshAtMs: 0,
        refreshCooldownMs: 45_000,
        nowMs: 1_000,
    });
    assert.equal(belowThreshold.shouldTriggerRefresh, false);
    assert.equal(belowThreshold.reason, "below_threshold");
    assert.equal(belowThreshold.remainingCooldownMs, 0);

    const triggerRefresh = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: 3,
        failureThreshold: 3,
        lastRefreshAtMs: 0,
        refreshCooldownMs: 45_000,
        nowMs: 1_000,
    });
    assert.equal(triggerRefresh.shouldTriggerRefresh, true);
    assert.equal(triggerRefresh.reason, "trigger_refresh");
    assert.equal(triggerRefresh.remainingCooldownMs, 0);

    const cooldownActive = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: 5,
        failureThreshold: 3,
        lastRefreshAtMs: 10_000,
        refreshCooldownMs: 45_000,
        nowMs: 20_000,
    });
    assert.equal(cooldownActive.shouldTriggerRefresh, false);
    assert.equal(cooldownActive.reason, "cooldown_active");
    assert.equal(cooldownActive.remainingCooldownMs, 35_000);
});

test("heartbeat guarded refresh edge: exactly at threshold boundary", () => {
    // Exactly 1 below threshold — should not trigger
    const justBelow = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: 4,
        failureThreshold: 5,
        lastRefreshAtMs: 0,
        refreshCooldownMs: 30_000,
        nowMs: 5_000,
    });
    assert.equal(justBelow.shouldTriggerRefresh, false);
    assert.equal(justBelow.reason, "below_threshold");

    // Exactly at threshold — should trigger
    const atThreshold = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: 5,
        failureThreshold: 5,
        lastRefreshAtMs: 0,
        refreshCooldownMs: 30_000,
        nowMs: 5_000,
    });
    assert.equal(atThreshold.shouldTriggerRefresh, true);
    assert.equal(atThreshold.reason, "trigger_refresh");
});

test("heartbeat guarded refresh: cooldown just expired triggers refresh", () => {
    // Cooldown expires exactly at nowMs
    const cooldownExpired = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: 5,
        failureThreshold: 3,
        lastRefreshAtMs: 10_000,
        refreshCooldownMs: 45_000,
        nowMs: 55_000,
    });
    assert.equal(cooldownExpired.shouldTriggerRefresh, true);
    assert.equal(cooldownExpired.reason, "trigger_refresh");
    assert.equal(cooldownExpired.remainingCooldownMs, 0);
});

test("heartbeat guarded refresh: cooldown just barely active", () => {
    // 1ms before cooldown expires
    const barelyActive = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: 5,
        failureThreshold: 3,
        lastRefreshAtMs: 10_000,
        refreshCooldownMs: 45_000,
        nowMs: 54_999,
    });
    assert.equal(barelyActive.shouldTriggerRefresh, false);
    assert.equal(barelyActive.reason, "cooldown_active");
    assert.equal(barelyActive.remainingCooldownMs, 1);
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

test("trusted track position falls back when playback context is not safe for engine time", () => {
    const baseInput = {
        fallbackPositionSec: 8,
        fallbackTrackId: "track-1",
        playbackType: "track" as const,
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        isLoading: false,
        activeEngineTrackId: "track-1",
        enginePositionSec: 8.4,
    };

    assert.equal(
        resolveTrustedTrackPositionSec({
            ...baseInput,
            playbackType: "podcast",
        }),
        8,
    );
    assert.equal(
        resolveTrustedTrackPositionSec({
            ...baseInput,
            currentTrackId: "track-2",
        }),
        8,
    );
    assert.equal(
        resolveTrustedTrackPositionSec({
            ...baseInput,
            isLoading: true,
        }),
        8,
    );
    assert.equal(
        resolveTrustedTrackPositionSec({
            ...baseInput,
            activeEngineTrackId: "track-2",
        }),
        8,
    );
    assert.equal(
        resolveTrustedTrackPositionSec({
            ...baseInput,
            enginePositionSec: Number.NaN,
        }),
        8,
    );
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

test("recovery resume correlation accepts only matching track/load/session", () => {
    const matched = resolveCorrelatedRecoveryResumeDecision({
        requestedResumeAtSec: 91.25,
        expectedTrackId: "track-2",
        activeTrackId: "track-2",
        expectedLoadId: 33,
        activeLoadId: 33,
        expectedSessionId: "session-new",
        activeSessionTrackId: "track-2",
        activeSessionId: "session-new",
    });
    assert.equal(matched.matched, true);
    assert.equal(matched.mismatchReason, "none");
    assert.equal(matched.resumeAtSec, 91.25);
});

test("recovery resume correlation clamps stale resume on transition mismatches", () => {
    const trackMismatch = resolveCorrelatedRecoveryResumeDecision({
        requestedResumeAtSec: 40,
        expectedTrackId: "track-1",
        activeTrackId: "track-next",
        expectedLoadId: 9,
        activeLoadId: 9,
    });
    assert.equal(trackMismatch.matched, false);
    assert.equal(trackMismatch.mismatchReason, "track_mismatch");
    assert.equal(trackMismatch.resumeAtSec, 0);

    const loadMismatch = resolveCorrelatedRecoveryResumeDecision({
        requestedResumeAtSec: 40,
        expectedTrackId: "track-1",
        activeTrackId: "track-1",
        expectedLoadId: 9,
        activeLoadId: 10,
    });
    assert.equal(loadMismatch.matched, false);
    assert.equal(loadMismatch.mismatchReason, "load_mismatch");
    assert.equal(loadMismatch.resumeAtSec, 0);

    const sessionMismatch = resolveCorrelatedRecoveryResumeDecision({
        requestedResumeAtSec: 40,
        expectedTrackId: "track-1",
        activeTrackId: "track-1",
        expectedLoadId: 9,
        activeLoadId: 9,
        expectedSessionId: "session-fresh",
        activeSessionTrackId: "track-1",
        activeSessionId: "session-stale",
    });
    assert.equal(sessionMismatch.matched, false);
    assert.equal(sessionMismatch.mismatchReason, "session_mismatch");
    assert.equal(sessionMismatch.resumeAtSec, 0);
});

test("recovery resume correlation normalizes non-finite requested resume values", () => {
    const matched = resolveCorrelatedRecoveryResumeDecision({
        requestedResumeAtSec: Number.NaN,
        expectedTrackId: "track-1",
        activeTrackId: "track-1",
        expectedLoadId: 4,
        activeLoadId: 4,
    });
    assert.equal(matched.matched, true);
    assert.equal(matched.mismatchReason, "none");
    assert.equal(matched.resumeAtSec, 0);
});

test("heartbeat guarded refresh normalizes non-finite threshold inputs", () => {
    const decision = resolveHeartbeatGuardedRefreshDecision({
        consecutiveFailureCount: Number.NaN,
        failureThreshold: Number.NaN,
        lastRefreshAtMs: 0,
        refreshCooldownMs: 1000,
        nowMs: 5000,
    });
    assert.equal(decision.shouldTriggerRefresh, false);
    assert.equal(decision.reason, "below_threshold");
    assert.equal(decision.consecutiveFailureCount, 0);
});

test("heartbeat guarded refresh falls back for non-finite timing inputs", () => {
    const previousNow = Date.now;
    Date.now = () => 50_000;
    try {
        const decision = resolveHeartbeatGuardedRefreshDecision({
            consecutiveFailureCount: 3,
            failureThreshold: 3,
            lastRefreshAtMs: Number.NaN,
            refreshCooldownMs: Number.NaN,
            nowMs: Number.NaN,
        });
        assert.equal(decision.shouldTriggerRefresh, true);
        assert.equal(decision.reason, "trigger_refresh");
        assert.equal(decision.remainingCooldownMs, 0);
    } finally {
        Date.now = previousNow;
    }
});
