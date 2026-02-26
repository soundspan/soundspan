export function shouldAttemptSegmentedRecoveryOnUnexpectedPause(
    bufferedAheadSec: number | null,
    maxBufferedAheadSec: number,
): boolean {
    return (
        typeof bufferedAheadSec === "number" &&
        Number.isFinite(bufferedAheadSec) &&
        bufferedAheadSec <= maxBufferedAheadSec
    );
}

export type SegmentedStartupRecoveryStage =
    | "session_create"
    | "manifest_readiness"
    | "engine_load";

export interface SegmentedStartupRecoveryStageAttempts {
    session_create: number;
    manifest_readiness: number;
    engine_load: number;
}

export interface SegmentedStartupRecoveryStageLimits
    extends SegmentedStartupRecoveryStageAttempts {}

export interface SegmentedStartupRecoveryBackoffInput {
    attempt: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
    randomValue?: number;
}

export interface SegmentedStartupRecoveryDecisionInput {
    stage: SegmentedStartupRecoveryStage;
    stageAttempts: SegmentedStartupRecoveryStageAttempts;
    stageLimits: SegmentedStartupRecoveryStageLimits;
    recoveryWindowStartedAtMs: number | null;
    recoveryWindowMaxMs: number;
    sessionResetsUsed: number;
    maxSessionResets: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
    nowMs?: number;
    randomValue?: number;
}

export interface SegmentedStartupRecoveryDecision {
    action:
        | "retry"
        | "reset_session_and_retry"
        | "exhausted_stage"
        | "exhausted_window";
    nextStageAttempts: SegmentedStartupRecoveryStageAttempts;
    nextSessionResetsUsed: number;
    delayMs: number | null;
}

export function createEmptySegmentedStartupRecoveryStageAttempts(): SegmentedStartupRecoveryStageAttempts {
    return {
        session_create: 0,
        manifest_readiness: 0,
        engine_load: 0,
    };
}

export function resolveSegmentedStartupRecoveryBackoffDelayMs(
    input: SegmentedStartupRecoveryBackoffInput,
): number {
    const safeAttempt = Math.max(1, Math.floor(input.attempt));
    const safeBaseDelayMs = Math.max(0, input.baseDelayMs);
    const safeMaxDelayMs = Math.max(safeBaseDelayMs, input.maxDelayMs);
    const safeJitterRatio = Math.max(0, Math.min(1, input.jitterRatio));
    const randomValue =
        typeof input.randomValue === "number" && Number.isFinite(input.randomValue)
            ? Math.max(0, Math.min(1, input.randomValue))
            : Math.random();
    const backoffDelayMs = Math.min(
        safeMaxDelayMs,
        safeBaseDelayMs * 2 ** (safeAttempt - 1),
    );
    const jitterMs = backoffDelayMs * safeJitterRatio * randomValue;
    return Math.round(backoffDelayMs + jitterMs);
}

export function resolveSegmentedStartupRecoveryDecision(
    input: SegmentedStartupRecoveryDecisionInput,
): SegmentedStartupRecoveryDecision {
    const nowMs =
        typeof input.nowMs === "number" && Number.isFinite(input.nowMs)
            ? input.nowMs
            : Date.now();
    const safeWindowMaxMs = Math.max(0, input.recoveryWindowMaxMs);
    const windowStartedAtMs = input.recoveryWindowStartedAtMs;
    if (
        typeof windowStartedAtMs === "number" &&
        Number.isFinite(windowStartedAtMs) &&
        nowMs - windowStartedAtMs > safeWindowMaxMs
    ) {
        return {
            action: "exhausted_window",
            nextStageAttempts: { ...input.stageAttempts },
            nextSessionResetsUsed: input.sessionResetsUsed,
            delayMs: null,
        };
    }

    const stageAttempts = { ...input.stageAttempts };
    const stageLimit = Math.max(0, input.stageLimits[input.stage]);
    const usedAttempts = Math.max(0, stageAttempts[input.stage]);
    if (usedAttempts >= stageLimit) {
        if (input.sessionResetsUsed < Math.max(0, input.maxSessionResets)) {
            return {
                action: "reset_session_and_retry",
                nextStageAttempts: createEmptySegmentedStartupRecoveryStageAttempts(),
                nextSessionResetsUsed: input.sessionResetsUsed + 1,
                delayMs: resolveSegmentedStartupRecoveryBackoffDelayMs({
                    attempt: 1,
                    baseDelayMs: input.baseDelayMs,
                    maxDelayMs: input.maxDelayMs,
                    jitterRatio: input.jitterRatio,
                    randomValue: input.randomValue,
                }),
            };
        }
        return {
            action: "exhausted_stage",
            nextStageAttempts: stageAttempts,
            nextSessionResetsUsed: input.sessionResetsUsed,
            delayMs: null,
        };
    }

    stageAttempts[input.stage] = usedAttempts + 1;
    return {
        action: "retry",
        nextStageAttempts: stageAttempts,
        nextSessionResetsUsed: input.sessionResetsUsed,
        delayMs: resolveSegmentedStartupRecoveryBackoffDelayMs({
            attempt: stageAttempts[input.stage],
            baseDelayMs: input.baseDelayMs,
            maxDelayMs: input.maxDelayMs,
            jitterRatio: input.jitterRatio,
            randomValue: input.randomValue,
        }),
    };
}
