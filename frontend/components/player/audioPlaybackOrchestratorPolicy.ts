/**
 * Resolves the playback duration to display, choosing between the audio
 * engine's reported duration and the known metadata duration.
 *
 * For remote streams delivered as fragmented MP4 (e.g. TIDAL HI_RES_LOSSLESS),
 * the `<audio>` element may report only a single fragment's duration (~4 s)
 * instead of the full track length.  When the loaded duration is less than
 * half the metadata duration for a remote stream, the metadata value is more
 * trustworthy.
 */
export function resolvePlaybackDuration(input: {
    loadedDurationSec: number;
    metadataDurationSec: number;
    isRemoteStream: boolean;
}): number {
    const loaded = input.loadedDurationSec;
    const metadata = Math.max(0, input.metadataDurationSec);

    // Invalid loaded values → use metadata
    if (typeof loaded !== "number" || !Number.isFinite(loaded) || loaded <= 0) {
        return metadata;
    }

    // For remote streams, if the audio element reports less than half the
    // metadata duration it's likely reading a single fMP4 fragment.
    if (input.isRemoteStream && metadata > 0 && loaded < metadata * 0.5) {
        return metadata;
    }

    return loaded || metadata;
}

/**
 * Resolves the Howler format hint for a remote stream source.
 *
 * Howler requires a format hint (or file extension in the URL) to pass its
 * internal codec compatibility check before loading. Remote stream URLs are
 * extensionless, so we must provide an explicit hint.
 *
 * The hint only gates Howler's `codecs()` check — it does NOT affect the
 * browser's actual decoding. In HTML5 mode the browser reads Content-Type
 * from the response; in Web Audio mode `decodeAudioData` decodes based on
 * binary content. So "mp4" safely passes the gate for both AAC and FLAC
 * content.
 */
export function resolveRemoteStreamFormat(
    streamSource: "local" | "tidal" | "youtube" | string | undefined | null,
): string | undefined {
    if (streamSource === "tidal" || streamSource === "youtube") {
        return "mp4";
    }
    return undefined;
}

/**
 * Executes shouldAttemptSegmentedRecoveryOnUnexpectedPause.
 */
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

export type SegmentedHandoffRecoveryStartupSkipReason =
    | "eligible"
    | "startup_stabilizing_no_progress"
    | "startup_stabilizing";

export interface SegmentedHandoffRecoveryStartupEligibilityInput {
    startupProgressAtMs: number | null;
    minimumStablePlaybackMs: number;
    nowMs?: number;
}

export interface SegmentedHandoffRecoveryStartupEligibility {
    eligible: boolean;
    reason: SegmentedHandoffRecoveryStartupSkipReason;
    stableForMs: number | null;
    minimumStablePlaybackMs: number;
}

/**
 * Executes resolveSegmentedHandoffRecoveryStartupEligibility.
 */
export function resolveSegmentedHandoffRecoveryStartupEligibility(
    input: SegmentedHandoffRecoveryStartupEligibilityInput,
): SegmentedHandoffRecoveryStartupEligibility {
    const minimumStablePlaybackMs = Math.max(0, input.minimumStablePlaybackMs);
    const startupProgressAtMs = input.startupProgressAtMs;

    if (
        typeof startupProgressAtMs !== "number" ||
        !Number.isFinite(startupProgressAtMs)
    ) {
        return {
            eligible: false,
            reason: "startup_stabilizing_no_progress",
            stableForMs: null,
            minimumStablePlaybackMs,
        };
    }

    const nowMs =
        typeof input.nowMs === "number" && Number.isFinite(input.nowMs)
            ? input.nowMs
            : Date.now();
    const stableForMs = Math.max(0, nowMs - startupProgressAtMs);
    if (stableForMs < minimumStablePlaybackMs) {
        return {
            eligible: false,
            reason: "startup_stabilizing",
            stableForMs,
            minimumStablePlaybackMs,
        };
    }

    return {
        eligible: true,
        reason: "eligible",
        stableForMs,
        minimumStablePlaybackMs,
    };
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

export type SegmentedStartupRecoveryStageLimits =
    SegmentedStartupRecoveryStageAttempts;

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

/**
 * Executes createEmptySegmentedStartupRecoveryStageAttempts.
 */
export function createEmptySegmentedStartupRecoveryStageAttempts(): SegmentedStartupRecoveryStageAttempts {
    return {
        session_create: 0,
        manifest_readiness: 0,
        engine_load: 0,
    };
}

/**
 * Executes resolveSegmentedStartupRecoveryBackoffDelayMs.
 */
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

/**
 * Executes resolveSegmentedStartupRecoveryDecision.
 */
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
