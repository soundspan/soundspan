import assert from "node:assert/strict";
import test from "node:test";
import {
    createEmptySegmentedStartupRecoveryStageAttempts,
    resolveSegmentedHandoffRecoveryStartupEligibility,
    resolveSegmentedStartupRecoveryBackoffDelayMs,
    resolveSegmentedStartupRecoveryDecision,
    shouldAttemptSegmentedRecoveryOnUnexpectedPause,
} from "./audioPlaybackOrchestratorPolicy.ts";

test("unavailable buffered-ahead does not trigger segmented recovery", () => {
    assert.equal(shouldAttemptSegmentedRecoveryOnUnexpectedPause(null, 1), false);
    assert.equal(
        shouldAttemptSegmentedRecoveryOnUnexpectedPause(Number.NaN, 1),
        false,
    );
});

test("low buffered-ahead still can trigger segmented recovery", () => {
    assert.equal(shouldAttemptSegmentedRecoveryOnUnexpectedPause(0.25, 1), true);
});

test("buffered-ahead above threshold does not trigger segmented recovery", () => {
    assert.equal(shouldAttemptSegmentedRecoveryOnUnexpectedPause(2, 1), false);
});

test("segmented startup backoff delay applies exponent with jitter", () => {
    assert.equal(
        resolveSegmentedStartupRecoveryBackoffDelayMs({
            attempt: 3,
            baseDelayMs: 500,
            maxDelayMs: 4_000,
            jitterRatio: 0.5,
            randomValue: 0.4,
        }),
        2400,
    );
});

test("segmented startup backoff clamps unsafe inputs", () => {
    assert.equal(
        resolveSegmentedStartupRecoveryBackoffDelayMs({
            attempt: 0,
            baseDelayMs: -200,
            maxDelayMs: -1,
            jitterRatio: 2,
            randomValue: -0.5,
        }),
        0,
    );
});

test("segmented startup backoff falls back to Math.random when randomValue is invalid", () => {
    const previousRandom = Math.random;
    Math.random = () => 0.25;
    try {
        assert.equal(
            resolveSegmentedStartupRecoveryBackoffDelayMs({
                attempt: 2,
                baseDelayMs: 400,
                maxDelayMs: 10_000,
                jitterRatio: 0.5,
                randomValue: Number.NaN,
            }),
            900,
        );
    } finally {
        Math.random = previousRandom;
    }
});

test("segmented startup stage retries increment independently", () => {
    const decision = resolveSegmentedStartupRecoveryDecision({
        stage: "manifest_readiness",
        stageAttempts: createEmptySegmentedStartupRecoveryStageAttempts(),
        stageLimits: {
            session_create: 2,
            manifest_readiness: 3,
            engine_load: 2,
        },
        recoveryWindowStartedAtMs: 0,
        recoveryWindowMaxMs: 30_000,
        sessionResetsUsed: 0,
        maxSessionResets: 1,
        baseDelayMs: 500,
        maxDelayMs: 2_000,
        jitterRatio: 0,
        nowMs: 5_000,
    });
    assert.equal(decision.action, "retry");
    assert.equal(decision.nextStageAttempts.manifest_readiness, 1);
    assert.equal(decision.nextStageAttempts.session_create, 0);
    assert.equal(decision.delayMs, 500);
});

test("stage exhaustion triggers session reset before terminal exhaustion", () => {
    const decision = resolveSegmentedStartupRecoveryDecision({
        stage: "engine_load",
        stageAttempts: {
            session_create: 0,
            manifest_readiness: 0,
            engine_load: 2,
        },
        stageLimits: {
            session_create: 2,
            manifest_readiness: 3,
            engine_load: 2,
        },
        recoveryWindowStartedAtMs: 0,
        recoveryWindowMaxMs: 30_000,
        sessionResetsUsed: 0,
        maxSessionResets: 1,
        baseDelayMs: 600,
        maxDelayMs: 2_000,
        jitterRatio: 0,
        nowMs: 1_000,
    });
    assert.equal(decision.action, "reset_session_and_retry");
    assert.deepEqual(
        decision.nextStageAttempts,
        createEmptySegmentedStartupRecoveryStageAttempts(),
    );
    assert.equal(decision.nextSessionResetsUsed, 1);
    assert.equal(decision.delayMs, 600);
});

test("retry window exhaustion returns terminal decision", () => {
    const decision = resolveSegmentedStartupRecoveryDecision({
        stage: "session_create",
        stageAttempts: {
            session_create: 1,
            manifest_readiness: 0,
            engine_load: 0,
        },
        stageLimits: {
            session_create: 2,
            manifest_readiness: 3,
            engine_load: 2,
        },
        recoveryWindowStartedAtMs: 0,
        recoveryWindowMaxMs: 10_000,
        sessionResetsUsed: 0,
        maxSessionResets: 1,
        baseDelayMs: 500,
        maxDelayMs: 2_000,
        jitterRatio: 0,
        nowMs: 11_000,
    });
    assert.equal(decision.action, "exhausted_window");
    assert.equal(decision.delayMs, null);
});

test("stage exhaustion without reset budget returns terminal stage decision", () => {
    const stageAttempts = {
        session_create: 0,
        manifest_readiness: 0,
        engine_load: 2,
    };
    const decision = resolveSegmentedStartupRecoveryDecision({
        stage: "engine_load",
        stageAttempts,
        stageLimits: {
            session_create: 2,
            manifest_readiness: 3,
            engine_load: 2,
        },
        recoveryWindowStartedAtMs: 0,
        recoveryWindowMaxMs: 30_000,
        sessionResetsUsed: 1,
        maxSessionResets: 1,
        baseDelayMs: 500,
        maxDelayMs: 2_000,
        jitterRatio: 0,
        nowMs: 5_000,
    });
    assert.equal(decision.action, "exhausted_stage");
    assert.deepEqual(decision.nextStageAttempts, stageAttempts);
    assert.equal(decision.nextSessionResetsUsed, 1);
    assert.equal(decision.delayMs, null);
});

test("window exhaustion uses Date.now when nowMs is omitted", () => {
    const previousNow = Date.now;
    Date.now = () => 20_001;
    try {
        const decision = resolveSegmentedStartupRecoveryDecision({
            stage: "session_create",
            stageAttempts: {
                session_create: 1,
                manifest_readiness: 0,
                engine_load: 0,
            },
            stageLimits: {
                session_create: 2,
                manifest_readiness: 2,
                engine_load: 2,
            },
            recoveryWindowStartedAtMs: 10_000,
            recoveryWindowMaxMs: 10_000,
            sessionResetsUsed: 0,
            maxSessionResets: 1,
            baseDelayMs: 500,
            maxDelayMs: 2_000,
            jitterRatio: 0,
        });
        assert.equal(decision.action, "exhausted_window");
    } finally {
        Date.now = previousNow;
    }
});

test("zero-or-negative stage limits immediately consume reset budget", () => {
    const decision = resolveSegmentedStartupRecoveryDecision({
        stage: "manifest_readiness",
        stageAttempts: {
            session_create: 0,
            manifest_readiness: -4,
            engine_load: 0,
        },
        stageLimits: {
            session_create: 2,
            manifest_readiness: 0,
            engine_load: 2,
        },
        recoveryWindowStartedAtMs: 0,
        recoveryWindowMaxMs: 30_000,
        sessionResetsUsed: 0,
        maxSessionResets: 1,
        baseDelayMs: 450,
        maxDelayMs: 2_000,
        jitterRatio: 0,
        nowMs: 5_000,
    });
    assert.equal(decision.action, "reset_session_and_retry");
    assert.equal(decision.nextSessionResetsUsed, 1);
    assert.deepEqual(
        decision.nextStageAttempts,
        createEmptySegmentedStartupRecoveryStageAttempts(),
    );
    assert.equal(decision.delayMs, 450);
});

test("handoff recovery is ineligible without startup progress timestamp", () => {
    const eligibility = resolveSegmentedHandoffRecoveryStartupEligibility({
        startupProgressAtMs: null,
        minimumStablePlaybackMs: 8_000,
        nowMs: 20_000,
    });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, "startup_stabilizing_no_progress");
    assert.equal(eligibility.stableForMs, null);
    assert.equal(eligibility.minimumStablePlaybackMs, 8_000);
});

test("handoff recovery clamps negative minimum stability and uses Date.now", () => {
    const previousNow = Date.now;
    Date.now = () => 5_000;
    try {
        const eligibility = resolveSegmentedHandoffRecoveryStartupEligibility({
            startupProgressAtMs: 6_000,
            minimumStablePlaybackMs: -250,
        });
        assert.equal(eligibility.eligible, true);
        assert.equal(eligibility.reason, "eligible");
        assert.equal(eligibility.stableForMs, 0);
        assert.equal(eligibility.minimumStablePlaybackMs, 0);
    } finally {
        Date.now = previousNow;
    }
});

test("handoff recovery is ineligible while startup is still stabilizing", () => {
    const eligibility = resolveSegmentedHandoffRecoveryStartupEligibility({
        startupProgressAtMs: 10_000,
        minimumStablePlaybackMs: 8_000,
        nowMs: 15_000,
    });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, "startup_stabilizing");
    assert.equal(eligibility.stableForMs, 5_000);
    assert.equal(eligibility.minimumStablePlaybackMs, 8_000);
});

test("handoff recovery is eligible once startup stability window is met", () => {
    const eligibility = resolveSegmentedHandoffRecoveryStartupEligibility({
        startupProgressAtMs: 10_000,
        minimumStablePlaybackMs: 8_000,
        nowMs: 18_000,
    });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.reason, "eligible");
    assert.equal(eligibility.stableForMs, 8_000);
    assert.equal(eligibility.minimumStablePlaybackMs, 8_000);
});
