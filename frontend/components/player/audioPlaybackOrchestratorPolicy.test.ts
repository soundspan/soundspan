import assert from "node:assert/strict";
import test from "node:test";
import {
    createEmptySegmentedStartupRecoveryStageAttempts,
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
