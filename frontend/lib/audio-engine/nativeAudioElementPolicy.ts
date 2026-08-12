/**
 * Native Audio Element Policy
 *
 * Pure, unit-testable state machine for the native `<audio>`-element
 * engine (GH #42). The controller class applies transitions and executes
 * effects; every playback decision lives here:
 *
 * - single load path with autoplay captured as a value at load time
 *   (play-state changes never trigger re-loads)
 * - queued seeks before readiness (`currentTime =` before
 *   `loadedmetadata` is silently dropped on some browsers)
 * - short seek marks that suppress stale `timeupdate` positions instead
 *   of lock flags and timeout timers
 * - bounded automatic retries that exhaust into an explicit error
 * - autoplay-policy handling: `NotAllowedError` arms exactly one
 *   gesture retry and never loops
 * - media-error classification: background session reclaim (preserve
 *   media for foreground recovery), stale-source auth expiry (reload
 *   from the stored source at position), transient, and fatal
 */

/** Engine lifecycle status. Seeking is tracked via seek-mark fields. */
export type NativeEngineStatus =
    "idle" | "loading" | "playing" | "paused" | "ended" | "error";

/** Who caused the most recent pause: the user, or the platform/OS. */
export type NativePauseClassification = "user" | "external" | null;

/** Milliseconds a seek mark suppresses stale timeupdate positions. */
export const NATIVE_ENGINE_SEEK_MARK_MS = 300;

/** Positions within this many seconds of the seek target are current. */
export const NATIVE_ENGINE_SEEK_MARK_TOLERANCE_SEC = 2;

/** Unclassified end-adjacent pauses within this many seconds await `ended`. */
export const NATIVE_ENGINE_END_PAUSE_EPSILON_SEC = 0.5;

/** Automatic (non-gesture) retry budget per load before exhausting. */
export const NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES = 3;

/** Base delay for automatic retry backoff (multiplied by attempt). */
export const NATIVE_ENGINE_RETRY_BASE_DELAY_MS = 500;

/**
 * A pause at least this long before a media error suggests the stream
 * URL's rotating auth token expired; recover by reloading from source.
 */
export const NATIVE_ENGINE_STALE_SOURCE_PAUSE_MS = 60_000;

/** Policy state consumed and produced by {@link transitionNativeEngine}. */
export interface NativeEnginePolicyState {
    status: NativeEngineStatus;
    /** Whether a source has been staged by a load request. */
    hasSource: boolean;
    /** Autoplay intent captured at load time. */
    autoplay: boolean;
    /** True once loadedmetadata arrived for the current load. */
    metadataReady: boolean;
    /** Seek requested before readiness, applied on loadedmetadata. */
    pendingSeekSec: number | null;
    /** Timestamp until which stale timeupdate positions are suppressed. */
    seekMarkUntilMs: number | null;
    /** Position the active seek is heading to. */
    seekTargetSec: number | null;
    /** Automatic retries consumed for the current load. */
    automaticRetriesUsed: number;
    /** Whether the single autoplay gesture retry has been spent. */
    gestureRetryUsed: boolean;
    /** Classification of the most recent pause. */
    pauseClassification: NativePauseClassification;
    /** When playback last became paused (stale-source detection). */
    pausedAtMs: number | null;
    /** When the current load was requested (start-latency telemetry). */
    loadRequestedAtMs: number | null;
}

/** Events fed into the policy by the controller. */
export type NativeEnginePolicyEvent =
    | {
          type: "LOAD_REQUESTED";
          autoplay: boolean;
          startTimeSec: number | null;
          nowMs: number;
          /**
           * Set by engine-initiated recovery reloads so the automatic
           * retry budget survives the reload and repeats still exhaust.
           */
          carryRetryBudget?: boolean;
          /**
           * True when the requested URL is already the loaded source.
           * Duplicate loads are deduped for howler parity (orchestrator
           * reconciliation, e.g. Listen Together resync, re-issues loads
           * for the current track and must not restart playback).
           */
          sameLoadedSource?: boolean;
          /** Engine-initiated recovery: bypass the same-source dedupe. */
          force?: boolean;
      }
    | { type: "LOADED_METADATA"; durationSec: number; nowMs: number }
    | { type: "PLAY_REQUESTED"; currentTimeSec: number; nowMs: number }
    | { type: "PAUSE_REQUESTED"; nowMs: number }
    | { type: "STOP_REQUESTED"; nowMs: number }
    | { type: "SEEK_REQUESTED"; timeSec: number; nowMs: number }
    | { type: "ELEMENT_PLAYING"; nowMs: number }
    | {
          type: "ELEMENT_PAUSED";
          /** Whether the element was ended or within the end epsilon. */
          atEndOfStream: boolean;
          nowMs: number;
      }
    | { type: "ELEMENT_ENDED"; nowMs: number }
    | { type: "ELEMENT_SEEKED"; timeSec: number; nowMs: number }
    | { type: "ELEMENT_TIME_UPDATE"; timeSec: number; nowMs: number }
    | {
          type: "ELEMENT_ERROR";
          mediaErrorCode: number | null;
          mediaErrorMessage: string | null;
          isPageHidden: boolean;
          currentTimeSec: number;
          nowMs: number;
      }
    | {
          type: "PLAY_PROMISE_REJECTED";
          errorName: string;
          errorMessage: string;
          isPageHidden: boolean;
          nowMs: number;
      }
    | { type: "GESTURE_RETRY_FIRED"; nowMs: number }
    | { type: "VISIBILITY_RETRY_FIRED"; nowMs: number }
    | { type: "RETRY_TIMER_FIRED"; nowMs: number }
    | { type: "RELOAD_REQUESTED"; nowMs: number }
    | {
          type: "PAGE_RESTORED";
          elementPaused: boolean;
          elementEnded: boolean;
          nowMs: number;
      }
    | { type: "FORCE_ENDED"; nowMs: number };

/** Side effects the controller must execute after a transition. */
export type NativeEnginePolicyEffect =
    | { kind: "applyLoad"; autoplay: boolean; isRetry: boolean }
    | { kind: "applySeek"; timeSec: number }
    | { kind: "callPlay" }
    | { kind: "callPause" }
    | { kind: "haltPlayback" }
    | { kind: "startTicker" }
    | { kind: "stopTicker" }
    | { kind: "scheduleRetry"; attempt: number; delayMs: number }
    | { kind: "cancelRetry" }
    | { kind: "armGestureRetry" }
    | { kind: "disarmGestureRetry" }
    | { kind: "armVisibilityRetry" }
    | { kind: "disarmVisibilityRetry" }
    | {
          kind: "reloadFromSource";
          resumeAtSec: number;
          resumePlaying: boolean;
          carryRetryBudget?: boolean;
      }
    | { kind: "emitLoad"; durationSec: number }
    | { kind: "emitPlay" }
    | { kind: "emitPause" }
    | { kind: "emitStop" }
    | { kind: "emitEnd" }
    | { kind: "emitSeek"; timeSec: number }
    | { kind: "emitTimeUpdate"; timeSec: number }
    | { kind: "emitBuffering"; isBuffering: boolean; reason?: string }
    | {
          kind: "emitLoadError";
          code: string | null;
          message: string;
          recoverable: boolean;
      }
    | {
          kind: "emitPlayError";
          code: string | null;
          message: string;
          recoverable: boolean;
      }
    | { kind: "telemetry"; event: string; fields: Record<string, unknown> };

/** Result of a policy transition. */
export interface NativeEnginePolicyTransition {
    state: NativeEnginePolicyState;
    effects: NativeEnginePolicyEffect[];
}

/** How a media error should be handled. */
export type NativeMediaErrorClassification =
    | "aborted"
    | "background_session_reclaim"
    | "stale_source"
    | "transient"
    | "fatal";

export interface NativeMediaErrorClassifierInput {
    mediaErrorCode: number | null;
    isPageHidden: boolean;
    metadataReady: boolean;
    pausedForMs: number | null;
}

export interface NativeMediaErrorClassifierResult {
    classification: NativeMediaErrorClassification;
    /** MEDIA_ERR_* constant name; orchestrator recovery matches on it. */
    mediaErrorName: string;
}

const MEDIA_ERROR_NAMES: Record<number, string> = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/** Creates the initial policy state (idle, nothing staged). */
export const createInitialNativeEngineState = (): NativeEnginePolicyState => ({
    status: "idle",
    hasSource: false,
    autoplay: false,
    metadataReady: false,
    pendingSeekSec: null,
    seekMarkUntilMs: null,
    seekTargetSec: null,
    automaticRetriesUsed: 0,
    gestureRetryUsed: false,
    pauseClassification: null,
    pausedAtMs: null,
    loadRequestedAtMs: null,
});

/**
 * Classifies a media error into a recovery strategy (GH #42 §5, §6).
 */
export function classifyNativeMediaError(
    input: NativeMediaErrorClassifierInput,
): NativeMediaErrorClassifierResult {
    const code = input.mediaErrorCode;
    const mediaErrorName =
        code !== null && MEDIA_ERROR_NAMES[code]
            ? MEDIA_ERROR_NAMES[code]
            : "MEDIA_ERR_UNKNOWN";

    if (code === 1) {
        return { classification: "aborted", mediaErrorName };
    }
    if (code === 2 && input.isPageHidden) {
        return { classification: "background_session_reclaim", mediaErrorName };
    }
    if (
        (code === 2 || code === 4) &&
        input.metadataReady &&
        typeof input.pausedForMs === "number" &&
        input.pausedForMs >= NATIVE_ENGINE_STALE_SOURCE_PAUSE_MS
    ) {
        return { classification: "stale_source", mediaErrorName };
    }
    if (code === 2 || code === 3) {
        return { classification: "transient", mediaErrorName };
    }
    return { classification: "fatal", mediaErrorName };
}

const formatMediaErrorMessage = (
    mediaErrorName: string,
    mediaErrorMessage: string | null,
): string =>
    mediaErrorMessage
        ? `${mediaErrorName}: ${mediaErrorMessage}`
        : mediaErrorName;

type Transition = NativeEnginePolicyTransition;
type State = NativeEnginePolicyState;

const noChange = (state: State): Transition => ({ state, effects: [] });

const handleSameSourceLoad = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "LOAD_REQUESTED" }>,
): Transition => {
    // Howler parity: a load for the already-current source never resets
    // the stream. It only merges play intent (play() when autoplay is
    // requested and nothing is playing yet) and honors a requested start
    // position as a seek.
    const autoplay = state.autoplay || event.autoplay;
    const startSeekSec =
        typeof event.startTimeSec === "number" && event.startTimeSec > 0
            ? event.startTimeSec
            : null;
    if (!state.metadataReady) {
        return {
            state: {
                ...state,
                autoplay,
                pendingSeekSec: startSeekSec ?? state.pendingSeekSec,
                seekTargetSec: startSeekSec ?? state.seekTargetSec,
            },
            effects: [],
        };
    }
    const effects: NativeEnginePolicyEffect[] = [];
    let nextState: State = { ...state, autoplay };
    if (startSeekSec !== null) {
        nextState = {
            ...nextState,
            seekTargetSec: startSeekSec,
            seekMarkUntilMs: event.nowMs + NATIVE_ENGINE_SEEK_MARK_MS,
        };
        effects.push({ kind: "applySeek", timeSec: startSeekSec });
    }
    if (event.autoplay && state.status !== "playing") {
        effects.push({ kind: "callPlay" });
    }
    return { state: nextState, effects };
};

const handleLoadRequested = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "LOAD_REQUESTED" }>,
): Transition => {
    // Dedupe only while the source is actively in service. After stop
    // (idle), end, or error, a same-source load is a deliberate
    // reload/replay and must run the full load path (fresh load event,
    // position reset).
    const dedupeEligible =
        state.status === "loading" ||
        state.status === "playing" ||
        state.status === "paused";
    if (
        event.sameLoadedSource &&
        !event.force &&
        state.hasSource &&
        dedupeEligible
    ) {
        return handleSameSourceLoad(state, event);
    }
    return applyFreshLoad(state, event);
};

const applyFreshLoad = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "LOAD_REQUESTED" }>,
): Transition => ({
    state: {
        ...createInitialNativeEngineState(),
        status: "loading",
        hasSource: true,
        autoplay: event.autoplay,
        pendingSeekSec:
            typeof event.startTimeSec === "number" && event.startTimeSec > 0
                ? event.startTimeSec
                : null,
        automaticRetriesUsed: event.carryRetryBudget
            ? state.automaticRetriesUsed
            : 0,
        loadRequestedAtMs: event.nowMs,
    },
    effects: [
        { kind: "cancelRetry" },
        { kind: "disarmGestureRetry" },
        { kind: "stopTicker" },
        { kind: "applyLoad", autoplay: event.autoplay, isRetry: false },
    ],
});

const handleLoadedMetadata = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "LOADED_METADATA" }>,
): Transition => {
    if (state.metadataReady || !state.hasSource) {
        return noChange(state);
    }

    const effects: NativeEnginePolicyEffect[] = [
        { kind: "emitLoad", durationSec: event.durationSec },
    ];
    const pendingSeekSec = state.pendingSeekSec;
    if (pendingSeekSec !== null) {
        effects.push({ kind: "applySeek", timeSec: pendingSeekSec });
    }
    if (state.autoplay) {
        effects.push({ kind: "callPlay" });
    }

    return {
        state: {
            ...state,
            metadataReady: true,
            status: state.autoplay ? "loading" : "paused",
            pausedAtMs: state.autoplay ? state.pausedAtMs : event.nowMs,
            pendingSeekSec: null,
            seekTargetSec: pendingSeekSec ?? state.seekTargetSec,
            seekMarkUntilMs:
                pendingSeekSec !== null
                    ? event.nowMs + NATIVE_ENGINE_SEEK_MARK_MS
                    : state.seekMarkUntilMs,
        },
        effects,
    };
};

const handlePlayRequested = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "PLAY_REQUESTED" }>,
): Transition => {
    if (!state.hasSource || state.status === "playing") {
        return noChange(state);
    }
    if (state.status === "error") {
        // Manual retry after an error: rebuild from the stored source at
        // the last known position instead of replaying the failed element
        // state (GH #42 §5/§6 foreground manual retry).
        return {
            state,
            effects: [
                {
                    kind: "reloadFromSource",
                    resumeAtSec: event.currentTimeSec,
                    resumePlaying: true,
                },
            ],
        };
    }
    if (state.status === "loading" && !state.metadataReady) {
        // The race-killer: play intent during a load only flips the
        // captured autoplay value. It never issues a second load.
        return { state: { ...state, autoplay: true }, effects: [] };
    }
    return {
        state: { ...state, gestureRetryUsed: false },
        effects: [{ kind: "callPlay" }],
    };
};

const handlePauseRequested = (state: State): Transition => {
    if (state.status === "loading" && !state.metadataReady) {
        return {
            state: { ...state, autoplay: false, pauseClassification: "user" },
            effects: [],
        };
    }
    if (state.status !== "playing" && state.status !== "loading") {
        return noChange(state);
    }
    return {
        state: { ...state, autoplay: false, pauseClassification: "user" },
        effects: [{ kind: "callPause" }],
    };
};

const handleStopRequested = (state: State): Transition => {
    if (!state.hasSource) {
        return noChange(state);
    }
    return {
        state: {
            ...state,
            status: "idle",
            autoplay: false,
            pendingSeekSec: null,
            seekMarkUntilMs: null,
            seekTargetSec: null,
            pauseClassification: null,
        },
        effects: [
            { kind: "cancelRetry" },
            { kind: "stopTicker" },
            { kind: "haltPlayback" },
            { kind: "emitStop" },
        ],
    };
};

const handleSeekRequested = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "SEEK_REQUESTED" }>,
): Transition => {
    if (!state.hasSource) {
        return noChange(state);
    }
    if (!state.metadataReady) {
        return {
            state: {
                ...state,
                pendingSeekSec: event.timeSec,
                seekTargetSec: event.timeSec,
            },
            effects: [{ kind: "emitSeek", timeSec: event.timeSec }],
        };
    }
    return {
        state: {
            ...state,
            seekTargetSec: event.timeSec,
            seekMarkUntilMs: event.nowMs + NATIVE_ENGINE_SEEK_MARK_MS,
        },
        effects: [
            { kind: "applySeek", timeSec: event.timeSec },
            { kind: "emitSeek", timeSec: event.timeSec },
        ],
    };
};

const handleElementPlaying = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "ELEMENT_PLAYING" }>,
): Transition => {
    const effects: NativeEnginePolicyEffect[] = [
        { kind: "startTicker" },
        { kind: "emitPlay" },
        { kind: "emitBuffering", isBuffering: false },
    ];
    if (state.loadRequestedAtMs !== null) {
        effects.push({
            kind: "telemetry",
            event: "playback_start_latency",
            fields: { latencyMs: event.nowMs - state.loadRequestedAtMs },
        });
    }
    return {
        state: {
            ...state,
            status: "playing",
            automaticRetriesUsed: 0,
            gestureRetryUsed: false,
            pauseClassification: null,
            pausedAtMs: null,
            loadRequestedAtMs: null,
        },
        effects,
    };
};

const handleElementPaused = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "ELEMENT_PAUSED" }>,
): Transition => {
    if (event.atEndOfStream && state.pauseClassification !== "user") {
        return noChange(state);
    }
    // Pauses land from "playing" and from the post-metadata startup
    // window (status still "loading" after a quick user pause interrupts
    // the autoplay play() call). Pre-metadata pause noise from source
    // swaps stays ignored.
    const canPause =
        state.status === "playing" ||
        (state.status === "loading" && state.metadataReady);
    if (!canPause) {
        return noChange(state);
    }
    return {
        state: {
            ...state,
            status: "paused",
            pausedAtMs: event.nowMs,
            pauseClassification:
                state.pauseClassification === "user" ? "user" : "external",
        },
        effects: [{ kind: "stopTicker" }, { kind: "emitPause" }],
    };
};

const handleElementEnded = (state: State, nowMs: number): Transition => {
    if (state.status === "ended" || !state.hasSource) {
        return noChange(state);
    }
    return {
        state: { ...state, status: "ended", pausedAtMs: nowMs },
        effects: [{ kind: "stopTicker" }, { kind: "emitEnd" }],
    };
};

const handleElementSeeked = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "ELEMENT_SEEKED" }>,
): Transition => ({
    state: { ...state, seekMarkUntilMs: null, seekTargetSec: null },
    effects: [{ kind: "emitTimeUpdate", timeSec: event.timeSec }],
});

const handleElementTimeUpdate = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "ELEMENT_TIME_UPDATE" }>,
): Transition => {
    if (state.status === "loading" || state.status === "idle") {
        return noChange(state);
    }
    const markActive =
        state.seekMarkUntilMs !== null && event.nowMs < state.seekMarkUntilMs;
    if (markActive && state.seekTargetSec !== null) {
        const nearTarget =
            Math.abs(event.timeSec - state.seekTargetSec) <
            NATIVE_ENGINE_SEEK_MARK_TOLERANCE_SEC;
        if (!nearTarget) {
            return noChange(state);
        }
    }
    return {
        state:
            state.seekMarkUntilMs !== null || state.seekTargetSec !== null
                ? { ...state, seekMarkUntilMs: null, seekTargetSec: null }
                : state,
        effects: [{ kind: "emitTimeUpdate", timeSec: event.timeSec }],
    };
};

const buildErrorEmission = (
    state: State,
    code: string | null,
    message: string,
    recoverable: boolean,
): NativeEnginePolicyEffect =>
    state.metadataReady
        ? { kind: "emitPlayError", code, message, recoverable }
        : { kind: "emitLoadError", code, message, recoverable };

const handleElementError = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "ELEMENT_ERROR" }>,
): Transition => {
    if (
        !state.hasSource ||
        state.status === "idle" ||
        state.status === "ended" ||
        state.status === "error"
    ) {
        // Nothing is (supposed to be) playing; a late element error has
        // no user-visible playback to recover or fail.
        return noChange(state);
    }
    const { classification, mediaErrorName } = classifyNativeMediaError({
        mediaErrorCode: event.mediaErrorCode,
        isPageHidden: event.isPageHidden,
        metadataReady: state.metadataReady,
        pausedForMs:
            state.pausedAtMs !== null ? event.nowMs - state.pausedAtMs : null,
    });
    const code =
        event.mediaErrorCode !== null ? String(event.mediaErrorCode) : null;
    const message = formatMediaErrorMessage(
        mediaErrorName,
        event.mediaErrorMessage,
    );

    if (classification === "aborted") {
        return noChange(state);
    }
    if (classification === "background_session_reclaim") {
        return {
            state: { ...state, status: "error" },
            effects: [
                { kind: "stopTicker" },
                buildErrorEmission(state, code, message, true),
                {
                    kind: "telemetry",
                    event: "playback_error",
                    fields: { code, classification },
                },
            ],
        };
    }
    if (classification === "stale_source") {
        return {
            state,
            effects: [
                {
                    kind: "reloadFromSource",
                    resumeAtSec: event.currentTimeSec,
                    resumePlaying: state.status === "playing",
                },
                {
                    kind: "telemetry",
                    event: "recovery_attempt",
                    fields: { code, classification },
                },
            ],
        };
    }
    if (
        classification === "transient" &&
        state.automaticRetriesUsed < NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES
    ) {
        const attempt = state.automaticRetriesUsed + 1;
        if (!state.metadataReady) {
            // Still loading: retry the same load on a bounded backoff
            // timer (RETRY_TIMER_FIRED only acts in the loading state).
            return {
                state: { ...state, automaticRetriesUsed: attempt },
                effects: [
                    {
                        kind: "scheduleRetry",
                        attempt,
                        delayMs: NATIVE_ENGINE_RETRY_BASE_DELAY_MS * attempt,
                    },
                    {
                        kind: "telemetry",
                        event: "recovery_attempt",
                        fields: { code, classification, attempt },
                    },
                ],
            };
        }
        // Playback (or the post-metadata window) already started: recover
        // through a full reload at the current position, carrying the
        // retry budget so repeated failures still exhaust.
        return {
            state: { ...state, automaticRetriesUsed: attempt },
            effects: [
                {
                    kind: "reloadFromSource",
                    resumeAtSec: event.currentTimeSec,
                    resumePlaying:
                        state.status === "playing" ||
                        (state.status === "loading" && state.autoplay),
                    carryRetryBudget: true,
                },
                {
                    kind: "telemetry",
                    event: "recovery_attempt",
                    fields: { code, classification, attempt },
                },
            ],
        };
    }

    // Fatal, or transient with the retry budget exhausted: fail loudly
    // instead of showing "playing" while nothing plays (GH #42 §4).
    return {
        state: { ...state, status: "error" },
        effects: [
            { kind: "stopTicker" },
            buildErrorEmission(state, code, message, false),
            {
                kind: "telemetry",
                event: "playback_error",
                fields: {
                    code,
                    classification,
                    retriesUsed: state.automaticRetriesUsed,
                },
            },
        ],
    };
};

const handlePlayPromiseRejected = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "PLAY_PROMISE_REJECTED" }>,
): Transition => {
    if (event.errorName === "AbortError") {
        // play() interrupted by a newer load()/pause(); the newer intent
        // already owns the element.
        return noChange(state);
    }
    if (event.errorName === "NotAllowedError") {
        const effects: NativeEnginePolicyEffect[] = [
            { kind: "stopTicker" },
            {
                kind: "emitPlayError",
                code: "NotAllowedError",
                message: event.errorMessage,
                recoverable: true,
            },
        ];
        if (!state.gestureRetryUsed) {
            effects.push({ kind: "armGestureRetry" });
        }
        // Autoplay rejected in a hidden tab (e.g. a queue auto-advance
        // while the user is tabbed away) is not a gesture problem: the
        // same play() is typically allowed once the page is visible.
        // Retry once on the hidden→visible transition instead of sitting
        // silent until the user happens to click (GH #53).
        if (event.isPageHidden) {
            effects.push({ kind: "armVisibilityRetry" });
        }
        return {
            state: {
                ...state,
                status: "paused",
                pausedAtMs: event.nowMs,
                gestureRetryUsed: true,
            },
            effects,
        };
    }
    return {
        state: { ...state, status: "error" },
        effects: [
            { kind: "stopTicker" },
            {
                kind: "emitPlayError",
                code: event.errorName,
                message: event.errorMessage,
                recoverable: false,
            },
            {
                kind: "telemetry",
                event: "playback_error",
                fields: {
                    code: event.errorName,
                    classification: "play_rejected",
                },
            },
        ],
    };
};

const handleGestureRetryFired = (state: State): Transition => {
    if (state.status !== "paused" || !state.hasSource) {
        return { state, effects: [{ kind: "disarmGestureRetry" }] };
    }
    return {
        state,
        effects: [{ kind: "callPlay" }, { kind: "disarmGestureRetry" }],
    };
};

const handleVisibilityRetryFired = (state: State): Transition => {
    // One-shot: whatever happens, the arm is spent. A user pause between
    // the rejection and the tab return must stay a pause, so only a
    // still-externally-paused source is retried.
    if (
        state.status !== "paused" ||
        !state.hasSource ||
        state.pauseClassification === "user"
    ) {
        return { state, effects: [{ kind: "disarmVisibilityRetry" }] };
    }
    return {
        state,
        effects: [{ kind: "callPlay" }, { kind: "disarmVisibilityRetry" }],
    };
};

const handleRetryTimerFired = (state: State): Transition => {
    if (state.status !== "loading") {
        return noChange(state);
    }
    return {
        state,
        effects: [
            { kind: "applyLoad", autoplay: state.autoplay, isRetry: true },
        ],
    };
};

const handleReloadRequested = (state: State): Transition => {
    if (!state.hasSource) {
        return noChange(state);
    }
    // External reload() keeps Howler parity: load fresh without autoplay;
    // the orchestrator restores position and playback via its own load
    // listener.
    return {
        state,
        effects: [
            { kind: "reloadFromSource", resumeAtSec: 0, resumePlaying: false },
        ],
    };
};

const handlePageRestored = (
    state: State,
    event: Extract<NativeEnginePolicyEvent, { type: "PAGE_RESTORED" }>,
): Transition => {
    if (!state.hasSource) {
        return noChange(state);
    }
    if (event.elementEnded && state.status !== "ended") {
        return {
            state: { ...state, status: "ended", pausedAtMs: event.nowMs },
            effects: [{ kind: "stopTicker" }, { kind: "emitEnd" }],
        };
    }
    if (state.status === "playing" && event.elementPaused) {
        return {
            state: {
                ...state,
                status: "paused",
                pausedAtMs: event.nowMs,
                pauseClassification: "external",
            },
            effects: [{ kind: "stopTicker" }, { kind: "emitPause" }],
        };
    }
    return noChange(state);
};

const handleForceEnded = (state: State, nowMs: number): Transition => {
    const canSynthesizeEnd =
        state.status === "playing" ||
        state.status === "ended" ||
        (state.status === "paused" && state.pauseClassification === "external");
    if (!state.hasSource || !canSynthesizeEnd) {
        return noChange(state);
    }
    return {
        state: { ...state, status: "ended", pausedAtMs: nowMs },
        effects: [{ kind: "stopTicker" }, { kind: "emitEnd" }],
    };
};

/**
 * Applies a policy event to the current state, returning the next state
 * and the effects the controller must execute.
 */
export function transitionNativeEngine(
    state: NativeEnginePolicyState,
    event: NativeEnginePolicyEvent,
): NativeEnginePolicyTransition {
    switch (event.type) {
        case "LOAD_REQUESTED":
            return handleLoadRequested(state, event);
        case "LOADED_METADATA":
            return handleLoadedMetadata(state, event);
        case "PLAY_REQUESTED":
            return handlePlayRequested(state, event);
        case "PAUSE_REQUESTED":
            return handlePauseRequested(state);
        case "STOP_REQUESTED":
            return handleStopRequested(state);
        case "SEEK_REQUESTED":
            return handleSeekRequested(state, event);
        case "ELEMENT_PLAYING":
            return handleElementPlaying(state, event);
        case "ELEMENT_PAUSED":
            return handleElementPaused(state, event);
        case "ELEMENT_ENDED":
            return handleElementEnded(state, event.nowMs);
        case "ELEMENT_SEEKED":
            return handleElementSeeked(state, event);
        case "ELEMENT_TIME_UPDATE":
            return handleElementTimeUpdate(state, event);
        case "ELEMENT_ERROR":
            return handleElementError(state, event);
        case "PLAY_PROMISE_REJECTED":
            return handlePlayPromiseRejected(state, event);
        case "GESTURE_RETRY_FIRED":
            return handleGestureRetryFired(state);
        case "VISIBILITY_RETRY_FIRED":
            return handleVisibilityRetryFired(state);
        case "RETRY_TIMER_FIRED":
            return handleRetryTimerFired(state);
        case "RELOAD_REQUESTED":
            return handleReloadRequested(state);
        case "PAGE_RESTORED":
            return handlePageRestored(state, event);
        case "FORCE_ENDED":
            return handleForceEnded(state, event.nowMs);
        default:
            return noChange(state);
    }
}
