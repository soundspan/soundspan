import assert from "node:assert/strict";
import test from "node:test";
import {
    NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES,
    NATIVE_ENGINE_SEEK_MARK_MS,
    NATIVE_ENGINE_SEEK_MARK_TOLERANCE_SEC,
    NATIVE_ENGINE_STALE_SOURCE_PAUSE_MS,
    classifyNativeMediaError,
    createInitialNativeEngineState,
    transitionNativeEngine,
    type NativeEnginePolicyEffect,
    type NativeEnginePolicyState,
} from "../../lib/audio-engine/nativeAudioElementPolicy";

const kinds = (effects: NativeEnginePolicyEffect[]): string[] =>
    effects.map((effect) => effect.kind);

const findEffect = <K extends NativeEnginePolicyEffect["kind"]>(
    effects: NativeEnginePolicyEffect[],
    kind: K,
): Extract<NativeEnginePolicyEffect, { kind: K }> | undefined =>
    effects.find((effect) => effect.kind === kind) as
        Extract<NativeEnginePolicyEffect, { kind: K }> | undefined;

const loadedState = (
    overrides: Partial<NativeEnginePolicyState> = {},
): NativeEnginePolicyState => {
    let { state } = transitionNativeEngine(createInitialNativeEngineState(), {
        type: "LOAD_REQUESTED",
        autoplay: false,
        startTimeSec: null,
        nowMs: 1_000,
    });
    ({ state } = transitionNativeEngine(state, {
        type: "LOADED_METADATA",
        durationSec: 240,
        nowMs: 1_050,
    }));
    return { ...state, ...overrides };
};

const playingState = (
    overrides: Partial<NativeEnginePolicyState> = {},
): NativeEnginePolicyState => {
    const { state } = transitionNativeEngine(loadedState({ autoplay: true }), {
        type: "ELEMENT_PLAYING",
        nowMs: 1_100,
    });
    return { ...state, ...overrides };
};

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

test("initial state is idle with no source and no retry debt", () => {
    const state = createInitialNativeEngineState();
    assert.equal(state.status, "idle");
    assert.equal(state.hasSource, false);
    assert.equal(state.automaticRetriesUsed, 0);
    assert.equal(state.pendingSeekSec, null);
    assert.equal(state.seekMarkUntilMs, null);
});

// ---------------------------------------------------------------------------
// Load path — single load path, autoplay captured as a value
// ---------------------------------------------------------------------------

test("LOAD_REQUESTED enters loading, captures autoplay, and applies exactly one load", () => {
    const { state, effects } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    assert.equal(state.status, "loading");
    assert.equal(state.autoplay, true);
    assert.equal(state.hasSource, true);
    assert.equal(state.metadataReady, false);
    assert.equal(state.loadRequestedAtMs, 1_000);
    assert.equal(
        effects.filter((effect) => effect.kind === "applyLoad").length,
        1,
    );
    assert.ok(kinds(effects).includes("stopTicker"));
    assert.ok(kinds(effects).includes("cancelRetry"));
});

test("LOAD_REQUESTED with a start position queues the seek for readiness", () => {
    const { state } = transitionNativeEngine(createInitialNativeEngineState(), {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: 42,
        nowMs: 1_000,
    });
    assert.equal(state.pendingSeekSec, 42);
});

test("LOAD_REQUESTED resets retry budget, gesture retry, and pending seeks from prior load", () => {
    const prior = loadedState({
        automaticRetriesUsed: 2,
        gestureRetryUsed: true,
        pendingSeekSec: 10,
        seekTargetSec: 10,
        seekMarkUntilMs: 5_000,
    });
    const { state, effects } = transitionNativeEngine(prior, {
        type: "LOAD_REQUESTED",
        autoplay: false,
        startTimeSec: null,
        nowMs: 2_000,
    });
    assert.equal(state.automaticRetriesUsed, 0);
    assert.equal(state.gestureRetryUsed, false);
    assert.equal(state.pendingSeekSec, null);
    assert.equal(state.seekTargetSec, null);
    assert.equal(state.seekMarkUntilMs, null);
    assert.ok(kinds(effects).includes("disarmGestureRetry"));
});

test("same-source load while playing is deduped (howler parity — LT resync must not restart the track)", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: null,
        nowMs: 6_000,
        sameLoadedSource: true,
    });
    assert.equal(kinds(effects).includes("applyLoad"), false, "no src reset");
    assert.equal(kinds(effects).includes("callPlay"), false, "already playing");
    assert.equal(state.status, "playing");
});

test("same-source load with autoplay while paused just plays (no reload)", () => {
    const { effects } = transitionNativeEngine(loadedState(), {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: null,
        nowMs: 6_000,
        sameLoadedSource: true,
    });
    assert.equal(kinds(effects).includes("applyLoad"), false);
    assert.ok(kinds(effects).includes("callPlay"));
});

test("same-source load while still loading merges play intent without a second load", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: false,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: null,
        nowMs: 1_005,
        sameLoadedSource: true,
    });
    assert.deepEqual(effects, []);
    assert.equal(state.autoplay, true, "play intent merged");
});

test("same-source load with a start position seeks instead of dropping it", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: 240,
        nowMs: 6_000,
        sameLoadedSource: true,
    });
    assert.equal(kinds(effects).includes("applyLoad"), false);
    const seek = findEffect(effects, "applySeek");
    assert.equal(seek?.timeSec, 240);
    assert.equal(state.seekTargetSec, 240);
});

test("same-source load with a start position before readiness queues the seek", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: false,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: 90,
        nowMs: 1_005,
        sameLoadedSource: true,
    });
    assert.deepEqual(kinds(effects), []);
    assert.equal(state.pendingSeekSec, 90);
});

test("same-source load in error, idle (stopped), or ended status performs a full reload", () => {
    for (const status of ["error", "idle", "ended"] as const) {
        const { effects } = transitionNativeEngine(playingState({ status }), {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 6_000,
            sameLoadedSource: true,
        });
        assert.ok(
            kinds(effects).includes("applyLoad"),
            `full reload expected from ${status} status`,
        );
    }
});

test("forced same-source load (engine-initiated recovery) bypasses the dedupe", () => {
    const { effects } = transitionNativeEngine(playingState(), {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: null,
        nowMs: 6_000,
        sameLoadedSource: true,
        force: true,
    });
    assert.ok(kinds(effects).includes("applyLoad"));
});

test("load-path race: track change plus play intent in one tick produces exactly one load and one play call", () => {
    let transition = transitionNativeEngine(createInitialNativeEngineState(), {
        type: "LOAD_REQUESTED",
        autoplay: false,
        startTimeSec: null,
        nowMs: 1_000,
    });
    const allEffects: NativeEnginePolicyEffect[] = [...transition.effects];

    // Play intent lands while the load is still in flight (same tick).
    transition = transitionNativeEngine(transition.state, {
        type: "PLAY_REQUESTED",
        currentTimeSec: 0,
        nowMs: 1_001,
    });
    allEffects.push(...transition.effects);
    assert.equal(transition.state.autoplay, true);

    // Readiness arrives once; playback starts once.
    transition = transitionNativeEngine(transition.state, {
        type: "LOADED_METADATA",
        durationSec: 200,
        nowMs: 1_050,
    });
    allEffects.push(...transition.effects);

    assert.equal(
        allEffects.filter((effect) => effect.kind === "applyLoad").length,
        1,
        "exactly one load application",
    );
    assert.equal(
        allEffects.filter((effect) => effect.kind === "callPlay").length,
        1,
        "exactly one play call",
    );
});

test("play-state changes never trigger re-loads", () => {
    const state = playingState();
    const pauseTransition = transitionNativeEngine(state, {
        type: "PAUSE_REQUESTED",
        nowMs: 2_000,
    });
    const playTransition = transitionNativeEngine(pauseTransition.state, {
        type: "PLAY_REQUESTED",
        currentTimeSec: 12,
        nowMs: 2_100,
    });
    const combined = [...pauseTransition.effects, ...playTransition.effects];
    assert.equal(
        combined.filter((effect) => effect.kind === "applyLoad").length,
        0,
    );
    assert.equal(
        combined.filter((effect) => effect.kind === "reloadFromSource").length,
        0,
    );
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test("LOADED_METADATA emits load, applies queued seek with a seek mark, and honors captured autoplay", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: 42,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "LOADED_METADATA",
        durationSec: 300,
        nowMs: 1_050,
    });
    assert.equal(state.metadataReady, true);
    assert.equal(state.pendingSeekSec, null);
    assert.equal(state.seekTargetSec, 42);
    assert.equal(state.seekMarkUntilMs, 1_050 + NATIVE_ENGINE_SEEK_MARK_MS);
    const load = findEffect(effects, "emitLoad");
    assert.equal(load?.durationSec, 300);
    const seek = findEffect(effects, "applySeek");
    assert.equal(seek?.timeSec, 42);
    assert.ok(kinds(effects).includes("callPlay"));
});

test("LOADED_METADATA without autoplay parks in paused and does not call play", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: false,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "LOADED_METADATA",
        durationSec: 300,
        nowMs: 1_050,
    });
    assert.equal(state.status, "paused");
    assert.equal(kinds(effects).includes("callPlay"), false);
});

test("duplicate LOADED_METADATA is ignored", () => {
    const { effects } = transitionNativeEngine(loadedState(), {
        type: "LOADED_METADATA",
        durationSec: 300,
        nowMs: 1_100,
    });
    assert.deepEqual(effects, []);
});

// ---------------------------------------------------------------------------
// Play / pause / stop
// ---------------------------------------------------------------------------

test("PLAY_REQUESTED before readiness only flips captured autoplay", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: false,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "PLAY_REQUESTED",
        currentTimeSec: 0,
        nowMs: 1_010,
    });
    assert.equal(state.autoplay, true);
    assert.deepEqual(effects, []);
});

test("PLAY_REQUESTED while paused calls play and resets gesture retry usage", () => {
    const paused = loadedState({ gestureRetryUsed: true });
    const { state, effects } = transitionNativeEngine(paused, {
        type: "PLAY_REQUESTED",
        currentTimeSec: 0,
        nowMs: 2_000,
    });
    assert.ok(kinds(effects).includes("callPlay"));
    assert.equal(state.gestureRetryUsed, false);
});

test("PLAY_REQUESTED while already playing is a no-op", () => {
    const { effects } = transitionNativeEngine(playingState(), {
        type: "PLAY_REQUESTED",
        currentTimeSec: 5,
        nowMs: 2_000,
    });
    assert.deepEqual(effects, []);
});

test("PLAY_REQUESTED with no source is a no-op", () => {
    const { effects } = transitionNativeEngine(
        createInitialNativeEngineState(),
        { type: "PLAY_REQUESTED", currentTimeSec: 0, nowMs: 1_000 },
    );
    assert.deepEqual(effects, []);
});

test("PLAY_REQUESTED in error state recovers by reloading from source at position", () => {
    const errored = loadedState({ status: "error" });
    const { effects } = transitionNativeEngine(errored, {
        type: "PLAY_REQUESTED",
        currentTimeSec: 87,
        nowMs: 9_000,
    });
    const reload = findEffect(effects, "reloadFromSource");
    assert.equal(reload?.resumeAtSec, 87);
    assert.equal(reload?.resumePlaying, true);
});

test("PAUSE_REQUESTED while playing classifies the pause as user-intended", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "PAUSE_REQUESTED",
        nowMs: 3_000,
    });
    assert.equal(state.pauseClassification, "user");
    assert.ok(kinds(effects).includes("callPause"));
});

test("PAUSE_REQUESTED during load cancels captured autoplay without a pause call", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "PAUSE_REQUESTED",
        nowMs: 1_010,
    });
    assert.equal(state.autoplay, false);
    assert.equal(kinds(effects).includes("callPause"), false);
});

test("STOP_REQUESTED halts playback, keeps the source, and emits stop", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "STOP_REQUESTED",
        nowMs: 3_000,
    });
    assert.equal(state.status, "idle");
    assert.equal(state.hasSource, true);
    assert.equal(state.autoplay, false);
    assert.ok(kinds(effects).includes("haltPlayback"));
    assert.ok(kinds(effects).includes("stopTicker"));
    assert.ok(kinds(effects).includes("emitStop"));
    assert.ok(kinds(effects).includes("cancelRetry"));
});

test("STOP_REQUESTED without a source is a no-op", () => {
    const { effects } = transitionNativeEngine(
        createInitialNativeEngineState(),
        { type: "STOP_REQUESTED", nowMs: 1_000 },
    );
    assert.deepEqual(effects, []);
});

// ---------------------------------------------------------------------------
// Element playback signals
// ---------------------------------------------------------------------------

test("ELEMENT_PLAYING enters playing, starts the ticker, resets retries, and reports start latency", () => {
    const { state, effects } = transitionNativeEngine(
        loadedState({ autoplay: true, automaticRetriesUsed: 2 }),
        { type: "ELEMENT_PLAYING", nowMs: 1_500 },
    );
    assert.equal(state.status, "playing");
    assert.equal(state.automaticRetriesUsed, 0);
    assert.equal(state.gestureRetryUsed, false);
    assert.equal(state.loadRequestedAtMs, null);
    assert.ok(kinds(effects).includes("startTicker"));
    assert.ok(kinds(effects).includes("emitPlay"));
    const telemetry = findEffect(effects, "telemetry");
    assert.equal(telemetry?.event, "playback_start_latency");
    assert.equal(telemetry?.fields.latencyMs, 500);
});

test("ELEMENT_PAUSED while playing without a user request classifies as external", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "ELEMENT_PAUSED",
        atEndOfStream: false,
        nowMs: 4_000,
    });
    assert.equal(state.status, "paused");
    assert.equal(state.pauseClassification, "external");
    assert.equal(state.pausedAtMs, 4_000);
    assert.ok(kinds(effects).includes("stopTicker"));
    assert.ok(kinds(effects).includes("emitPause"));
});

test("ELEMENT_PAUSED at end of stream is suppressed until ELEMENT_ENDED emits end", () => {
    const playing = playingState();
    const paused = transitionNativeEngine(playing, {
        type: "ELEMENT_PAUSED",
        atEndOfStream: true,
        nowMs: 4_000,
    });
    assert.equal(paused.state.status, "playing");
    assert.equal(kinds(paused.effects).includes("emitPause"), false);

    const ended = transitionNativeEngine(paused.state, {
        type: "ELEMENT_ENDED",
        nowMs: 4_001,
    });
    assert.equal(ended.state.status, "ended");
    assert.equal(
        ended.effects.filter((effect) => effect.kind === "emitEnd").length,
        1,
    );
});

test("ELEMENT_PAUSED at end of stream after a user pause emits pause", () => {
    const { state: pauseRequested } = transitionNativeEngine(playingState(), {
        type: "PAUSE_REQUESTED",
        nowMs: 3_900,
    });
    const { state, effects } = transitionNativeEngine(pauseRequested, {
        type: "ELEMENT_PAUSED",
        atEndOfStream: true,
        nowMs: 4_000,
    });
    assert.equal(state.status, "paused");
    assert.ok(kinds(effects).includes("emitPause"));
});

test("ELEMENT_PAUSED mid-track still emits pause exactly once", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "ELEMENT_PAUSED",
        atEndOfStream: false,
        nowMs: 4_000,
    });
    assert.equal(state.status, "paused");
    assert.equal(
        effects.filter((effect) => effect.kind === "emitPause").length,
        1,
    );
});

test("ELEMENT_PAUSED with an unknown-duration boundary result still emits pause", () => {
    const { effects } = transitionNativeEngine(playingState(), {
        type: "ELEMENT_PAUSED",
        atEndOfStream: false,
        nowMs: 4_000,
    });
    assert.equal(
        effects.filter((effect) => effect.kind === "emitPause").length,
        1,
    );
});

test("ELEMENT_PAUSED after a user pause request keeps the user classification", () => {
    const { state: pauseRequested } = transitionNativeEngine(playingState(), {
        type: "PAUSE_REQUESTED",
        nowMs: 3_900,
    });
    const { state } = transitionNativeEngine(pauseRequested, {
        type: "ELEMENT_PAUSED",
        atEndOfStream: false,
        nowMs: 4_000,
    });
    assert.equal(state.pauseClassification, "user");
});

test("quick pause during autoplay startup (post-metadata window) reaches paused and emits pause", () => {
    // load(autoplay) → metadata ready (play() issued, status still loading)
    const { state: startupWindow } = transitionNativeEngine(
        transitionNativeEngine(createInitialNativeEngineState(), {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        }).state,
        { type: "LOADED_METADATA", durationSec: 240, nowMs: 1_050 },
    );
    assert.equal(startupWindow.status, "loading");

    // The user pauses before the element ever reaches "playing"…
    const { state: pauseRequested, effects: pauseEffects } =
        transitionNativeEngine(startupWindow, {
            type: "PAUSE_REQUESTED",
            nowMs: 1_060,
        });
    assert.ok(kinds(pauseEffects).includes("callPause"));

    // …the native pause event must land in paused, not stay stuck loading.
    const { state, effects } = transitionNativeEngine(pauseRequested, {
        type: "ELEMENT_PAUSED",
        atEndOfStream: false,
        nowMs: 1_070,
    });
    assert.equal(state.status, "paused");
    assert.equal(state.pauseClassification, "user");
    assert.ok(kinds(effects).includes("emitPause"));
});

test("ELEMENT_PAUSED after ended is ignored", () => {
    const ended = playingState({ status: "ended" });
    const { effects } = transitionNativeEngine(ended, {
        type: "ELEMENT_PAUSED",
        atEndOfStream: false,
        nowMs: 4_000,
    });
    assert.deepEqual(effects, []);
});

test("ELEMENT_ENDED emits end exactly once", () => {
    const first = transitionNativeEngine(playingState(), {
        type: "ELEMENT_ENDED",
        nowMs: 5_000,
    });
    assert.equal(first.state.status, "ended");
    assert.ok(kinds(first.effects).includes("emitEnd"));
    assert.ok(kinds(first.effects).includes("stopTicker"));

    const second = transitionNativeEngine(first.state, {
        type: "ELEMENT_ENDED",
        nowMs: 5_001,
    });
    assert.deepEqual(second.effects, []);
});

test("FORCE_ENDED re-emits a naturally consumed end", () => {
    const naturallyEnded = transitionNativeEngine(playingState(), {
        type: "ELEMENT_ENDED",
        nowMs: 5_000,
    });
    const recovered = transitionNativeEngine(naturallyEnded.state, {
        type: "FORCE_ENDED",
        nowMs: 5_001,
    });
    assert.ok(kinds(recovered.effects).includes("emitEnd"));
    assert.equal(recovered.state.status, "ended");
});

test("FORCE_ENDED synthesizes end from an external pause", () => {
    const externallyPaused = loadedState({ pauseClassification: "external" });
    const recovered = transitionNativeEngine(externallyPaused, {
        type: "FORCE_ENDED",
        nowMs: 5_000,
    });
    assert.ok(kinds(recovered.effects).includes("emitEnd"));
    assert.equal(recovered.state.status, "ended");
});

test("FORCE_ENDED with no source is a no-op", () => {
    const { effects } = transitionNativeEngine(
        createInitialNativeEngineState(),
        { type: "FORCE_ENDED", nowMs: 5_000 },
    );
    assert.deepEqual(effects, []);
});

test("a fresh load prevents FORCE_ENDED from re-emitting for the prior source", () => {
    const forced = transitionNativeEngine(playingState(), {
        type: "FORCE_ENDED",
        nowMs: 5_000,
    });
    const freshLoad = transitionNativeEngine(forced.state, {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: null,
        nowMs: 5_001,
    });
    const staleForce = transitionNativeEngine(freshLoad.state, {
        type: "FORCE_ENDED",
        nowMs: 5_002,
    });
    assert.equal(freshLoad.state.status, "loading");
    assert.deepEqual(staleForce.effects, []);
});

// ---------------------------------------------------------------------------
// Seek — queued seeks and seek-mark suppression instead of locks
// ---------------------------------------------------------------------------

test("SEEK_REQUESTED before readiness queues the seek and emits optimistically", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: false,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "SEEK_REQUESTED",
        timeSec: 120,
        nowMs: 1_010,
    });
    assert.equal(state.pendingSeekSec, 120);
    assert.equal(kinds(effects).includes("applySeek"), false);
    const seek = findEffect(effects, "emitSeek");
    assert.equal(seek?.timeSec, 120);
});

test("queued seek is applied once metadata is ready (resume-at-position path)", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: false,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state: seeked } = transitionNativeEngine(loading, {
        type: "SEEK_REQUESTED",
        timeSec: 120,
        nowMs: 1_010,
    });
    const { effects } = transitionNativeEngine(seeked, {
        type: "LOADED_METADATA",
        durationSec: 3_600,
        nowMs: 1_050,
    });
    const seek = findEffect(effects, "applySeek");
    assert.equal(seek?.timeSec, 120);
});

test("SEEK_REQUESTED when ready applies the seek and sets a seek mark", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "SEEK_REQUESTED",
        timeSec: 60,
        nowMs: 2_000,
    });
    assert.equal(state.seekTargetSec, 60);
    assert.equal(state.seekMarkUntilMs, 2_000 + NATIVE_ENGINE_SEEK_MARK_MS);
    const seek = findEffect(effects, "applySeek");
    assert.equal(seek?.timeSec, 60);
});

test("stale timeupdate positions are suppressed while the seek mark is active", () => {
    const { state: seeking } = transitionNativeEngine(playingState(), {
        type: "SEEK_REQUESTED",
        timeSec: 60,
        nowMs: 2_000,
    });
    const { effects } = transitionNativeEngine(seeking, {
        type: "ELEMENT_TIME_UPDATE",
        timeSec: 5,
        nowMs: 2_100,
    });
    assert.deepEqual(effects, []);
});

test("timeupdate near the seek target clears the mark and emits", () => {
    const { state: seeking } = transitionNativeEngine(playingState(), {
        type: "SEEK_REQUESTED",
        timeSec: 60,
        nowMs: 2_000,
    });
    const nearTarget = 60 + NATIVE_ENGINE_SEEK_MARK_TOLERANCE_SEC - 0.5;
    const { state, effects } = transitionNativeEngine(seeking, {
        type: "ELEMENT_TIME_UPDATE",
        timeSec: nearTarget,
        nowMs: 2_100,
    });
    assert.equal(state.seekMarkUntilMs, null);
    assert.equal(state.seekTargetSec, null);
    const update = findEffect(effects, "emitTimeUpdate");
    assert.equal(update?.timeSec, nearTarget);
});

test("the seek mark expires by time instead of requiring a timer", () => {
    const { state: seeking } = transitionNativeEngine(playingState(), {
        type: "SEEK_REQUESTED",
        timeSec: 60,
        nowMs: 2_000,
    });
    const { state, effects } = transitionNativeEngine(seeking, {
        type: "ELEMENT_TIME_UPDATE",
        timeSec: 5,
        nowMs: 2_000 + NATIVE_ENGINE_SEEK_MARK_MS + 1,
    });
    assert.equal(state.seekMarkUntilMs, null);
    assert.ok(kinds(effects).includes("emitTimeUpdate"));
});

test("ELEMENT_SEEKED clears the seek mark and snaps the position", () => {
    const { state: seeking } = transitionNativeEngine(playingState(), {
        type: "SEEK_REQUESTED",
        timeSec: 60,
        nowMs: 2_000,
    });
    const { state, effects } = transitionNativeEngine(seeking, {
        type: "ELEMENT_SEEKED",
        timeSec: 60,
        nowMs: 2_050,
    });
    assert.equal(state.seekMarkUntilMs, null);
    assert.equal(state.seekTargetSec, null);
    const update = findEffect(effects, "emitTimeUpdate");
    assert.equal(update?.timeSec, 60);
});

test("timeupdate during loading is suppressed", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { effects } = transitionNativeEngine(loading, {
        type: "ELEMENT_TIME_UPDATE",
        timeSec: 3,
        nowMs: 1_010,
    });
    assert.deepEqual(effects, []);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("classifyNativeMediaError maps codes to classifications", () => {
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: 1,
            isPageHidden: false,
            metadataReady: true,
            pausedForMs: null,
        }).classification,
        "aborted",
    );
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: 2,
            isPageHidden: true,
            metadataReady: true,
            pausedForMs: null,
        }).classification,
        "background_session_reclaim",
    );
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: 2,
            isPageHidden: false,
            metadataReady: true,
            pausedForMs: NATIVE_ENGINE_STALE_SOURCE_PAUSE_MS + 1,
        }).classification,
        "stale_source",
    );
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: 2,
            isPageHidden: false,
            metadataReady: false,
            pausedForMs: null,
        }).classification,
        "transient",
    );
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: 3,
            isPageHidden: false,
            metadataReady: true,
            pausedForMs: null,
        }).classification,
        "transient",
    );
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: 4,
            isPageHidden: false,
            metadataReady: false,
            pausedForMs: null,
        }).classification,
        "fatal",
    );
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: null,
            isPageHidden: false,
            metadataReady: false,
            pausedForMs: null,
        }).classification,
        "fatal",
    );
});

test("classifyNativeMediaError exposes the MEDIA_ERR name for orchestrator matching", () => {
    assert.equal(
        classifyNativeMediaError({
            mediaErrorCode: 2,
            isPageHidden: false,
            metadataReady: false,
            pausedForMs: null,
        }).mediaErrorName,
        "MEDIA_ERR_NETWORK",
    );
});

test("aborted errors are ignored (our own source swap)", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { effects } = transitionNativeEngine(loading, {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 1,
        mediaErrorMessage: null,
        isPageHidden: false,
        currentTimeSec: 0,
        nowMs: 1_010,
    });
    assert.deepEqual(effects, []);
});

test("background network error preserves media and surfaces a recoverable error with code 2", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 2,
        mediaErrorMessage: null,
        isPageHidden: true,
        currentTimeSec: 33,
        nowMs: 6_000,
    });
    assert.equal(state.status, "error");
    const error = findEffect(effects, "emitPlayError");
    assert.equal(error?.code, "2");
    assert.ok(error?.message.includes("MEDIA_ERR_NETWORK"));
    assert.equal(error?.recoverable, true);
    assert.equal(kinds(effects).includes("scheduleRetry"), false);
});

test("stale source after a long pause reloads from source at the current position", () => {
    const longPausedAt = 10_000;
    const paused = playingState();
    const { state: afterPause } = transitionNativeEngine(paused, {
        type: "ELEMENT_PAUSED",
        atEndOfStream: false,
        nowMs: longPausedAt,
    });
    const resumeAt = longPausedAt + NATIVE_ENGINE_STALE_SOURCE_PAUSE_MS + 1;
    const { effects } = transitionNativeEngine(afterPause, {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 2,
        mediaErrorMessage: null,
        isPageHidden: false,
        currentTimeSec: 154,
        nowMs: resumeAt,
    });
    const reload = findEffect(effects, "reloadFromSource");
    assert.equal(reload?.resumeAtSec, 154);
    const telemetry = findEffect(effects, "telemetry");
    assert.equal(telemetry?.event, "recovery_attempt");
});

test("transient load errors schedule bounded retries with backoff", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 2,
        mediaErrorMessage: null,
        isPageHidden: false,
        currentTimeSec: 0,
        nowMs: 1_010,
    });
    assert.equal(state.automaticRetriesUsed, 1);
    assert.equal(state.status, "loading");
    const retry = findEffect(effects, "scheduleRetry");
    assert.equal(retry?.attempt, 1);
    assert.equal(retry?.delayMs, 500);
});

test("automatic retries exhaust and then emit a load error instead of silently swallowing", () => {
    let { state } = transitionNativeEngine(createInitialNativeEngineState(), {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: null,
        nowMs: 1_000,
    });
    let sawScheduled = 0;
    let finalEffects: NativeEnginePolicyEffect[] = [];
    for (
        let attempt = 0;
        attempt <= NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES;
        attempt += 1
    ) {
        const transition = transitionNativeEngine(state, {
            type: "ELEMENT_ERROR",
            mediaErrorCode: 2,
            mediaErrorMessage: null,
            isPageHidden: false,
            currentTimeSec: 0,
            nowMs: 1_010 + attempt,
        });
        state = transition.state;
        finalEffects = transition.effects;
        sawScheduled += transition.effects.filter(
            (effect) => effect.kind === "scheduleRetry",
        ).length;
    }
    assert.equal(sawScheduled, NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES);
    assert.equal(state.status, "error");
    const error = findEffect(finalEffects, "emitLoadError");
    assert.equal(error?.code, "2");
    assert.equal(error?.recoverable, false);
});

test("RETRY_TIMER_FIRED re-applies the load as a retry without resetting the budget", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state: retrying } = transitionNativeEngine(loading, {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 2,
        mediaErrorMessage: null,
        isPageHidden: false,
        currentTimeSec: 0,
        nowMs: 1_010,
    });
    const { state, effects } = transitionNativeEngine(retrying, {
        type: "RETRY_TIMER_FIRED",
        nowMs: 1_510,
    });
    const load = findEffect(effects, "applyLoad");
    assert.equal(load?.isRetry, true);
    assert.equal(state.automaticRetriesUsed, 1);
});

test("mid-playback transient error reloads from source at position, carrying the retry budget", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 3,
        mediaErrorMessage: "decode glitch",
        isPageHidden: false,
        currentTimeSec: 77,
        nowMs: 5_000,
    });
    assert.equal(state.automaticRetriesUsed, 1);
    assert.equal(
        kinds(effects).includes("scheduleRetry"),
        false,
        "no dangling retry timer outside the loading state",
    );
    const reload = findEffect(effects, "reloadFromSource");
    assert.equal(reload?.resumeAtSec, 77);
    assert.equal(reload?.resumePlaying, true);
    assert.equal(reload?.carryRetryBudget, true);
});

test("LOAD_REQUESTED with carryRetryBudget preserves the consumed retry budget", () => {
    const prior = playingState({ automaticRetriesUsed: 2 });
    const { state } = transitionNativeEngine(prior, {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: 77,
        nowMs: 6_000,
        carryRetryBudget: true,
    });
    assert.equal(state.automaticRetriesUsed, 2);
});

test("repeated transient errors across a mid-playback reload still exhaust into an explicit error", () => {
    // Playing → transient error consumes attempt 1 and reloads (budget carried).
    let transition = transitionNativeEngine(playingState(), {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 2,
        mediaErrorMessage: null,
        isPageHidden: false,
        currentTimeSec: 30,
        nowMs: 5_000,
    });
    assert.equal(transition.state.automaticRetriesUsed, 1);
    // The engine-initiated reload preserves the budget.
    transition = transitionNativeEngine(transition.state, {
        type: "LOAD_REQUESTED",
        autoplay: true,
        startTimeSec: 30,
        nowMs: 5_010,
        carryRetryBudget: true,
    });
    assert.equal(transition.state.automaticRetriesUsed, 1);
    // Further failures during the reload burn the remaining budget…
    let finalEffects: NativeEnginePolicyEffect[] = [];
    for (
        let round = 0;
        round < NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES;
        round += 1
    ) {
        transition = transitionNativeEngine(transition.state, {
            type: "ELEMENT_ERROR",
            mediaErrorCode: 2,
            mediaErrorMessage: null,
            isPageHidden: false,
            currentTimeSec: 0,
            nowMs: 5_020 + round,
        });
        finalEffects = transition.effects;
    }
    // …and the last one exhausts into an explicit error, not silence.
    assert.equal(transition.state.status, "error");
    assert.ok(kinds(finalEffects).includes("emitLoadError"));
});

test("media errors in ended, idle, or error status are ignored", () => {
    const ended = playingState({ status: "ended" });
    const idle = playingState({ status: "idle" });
    const errored = playingState({ status: "error" });
    for (const state of [ended, idle, errored]) {
        const { effects } = transitionNativeEngine(state, {
            type: "ELEMENT_ERROR",
            mediaErrorCode: 2,
            mediaErrorMessage: null,
            isPageHidden: false,
            currentTimeSec: 0,
            nowMs: 9_000,
        });
        assert.deepEqual(effects, []);
    }
});

test("transient error in the metadata-ready loading window reloads with the captured autoplay", () => {
    // loadedState({ autoplay: true }) models the window between
    // loadedmetadata and the playing event: status loading, metadata ready.
    const { state: window } = transitionNativeEngine(
        transitionNativeEngine(createInitialNativeEngineState(), {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        }).state,
        { type: "LOADED_METADATA", durationSec: 240, nowMs: 1_050 },
    );
    assert.equal(window.status, "loading");
    assert.equal(window.metadataReady, true);
    const { effects } = transitionNativeEngine(window, {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 2,
        mediaErrorMessage: null,
        isPageHidden: false,
        currentTimeSec: 0,
        nowMs: 1_100,
    });
    const reload = findEffect(effects, "reloadFromSource");
    assert.equal(reload?.resumePlaying, true, "captured autoplay survives");
});

test("RETRY_TIMER_FIRED after leaving loading is ignored", () => {
    const { effects } = transitionNativeEngine(playingState(), {
        type: "RETRY_TIMER_FIRED",
        nowMs: 2_000,
    });
    assert.deepEqual(effects, []);
});

test("fatal src-not-supported errors fail immediately without retries", () => {
    const { state: loading } = transitionNativeEngine(
        createInitialNativeEngineState(),
        {
            type: "LOAD_REQUESTED",
            autoplay: true,
            startTimeSec: null,
            nowMs: 1_000,
        },
    );
    const { state, effects } = transitionNativeEngine(loading, {
        type: "ELEMENT_ERROR",
        mediaErrorCode: 4,
        mediaErrorMessage: "unsupported",
        isPageHidden: false,
        currentTimeSec: 0,
        nowMs: 1_010,
    });
    assert.equal(state.status, "error");
    assert.equal(kinds(effects).includes("scheduleRetry"), false);
    const error = findEffect(effects, "emitLoadError");
    assert.ok(error?.message.includes("MEDIA_ERR_SRC_NOT_SUPPORTED"));
});

// ---------------------------------------------------------------------------
// Autoplay policy — play() promise rejections
// ---------------------------------------------------------------------------

test("NotAllowedError parks paused, surfaces the gesture requirement, and arms one gesture retry", () => {
    const { state, effects } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "NotAllowedError",
            errorMessage: "play() failed because the user didn't interact",
            isPageHidden: false,
            nowMs: 2_000,
        },
    );
    assert.equal(state.status, "paused");
    assert.equal(state.gestureRetryUsed, true);
    assert.ok(kinds(effects).includes("armGestureRetry"));
    const error = findEffect(effects, "emitPlayError");
    assert.equal(error?.code, "NotAllowedError");
    assert.equal(kinds(effects).includes("scheduleRetry"), false);
});

test("a second NotAllowedError does not re-arm the gesture retry (never loop)", () => {
    const first = transitionNativeEngine(loadedState({ autoplay: true }), {
        type: "PLAY_PROMISE_REJECTED",
        errorName: "NotAllowedError",
        errorMessage: "blocked",
        isPageHidden: false,
        nowMs: 2_000,
    });
    const second = transitionNativeEngine(first.state, {
        type: "PLAY_PROMISE_REJECTED",
        errorName: "NotAllowedError",
        errorMessage: "blocked",
        isPageHidden: false,
        nowMs: 2_100,
    });
    assert.equal(kinds(second.effects).includes("armGestureRetry"), false);
});

test("GESTURE_RETRY_FIRED plays once and disarms", () => {
    const { state: blocked } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "NotAllowedError",
            errorMessage: "blocked",
            isPageHidden: false,
            nowMs: 2_000,
        },
    );
    const { effects } = transitionNativeEngine(blocked, {
        type: "GESTURE_RETRY_FIRED",
        nowMs: 2_500,
    });
    assert.ok(kinds(effects).includes("callPlay"));
    assert.ok(kinds(effects).includes("disarmGestureRetry"));
});

test("AbortError from an interrupted play() is ignored", () => {
    const { effects } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "AbortError",
            errorMessage: "interrupted by a new load request",
            isPageHidden: false,
            nowMs: 2_000,
        },
    );
    assert.deepEqual(effects, []);
});

test("NotSupportedError from play() surfaces a play error in error state", () => {
    const { state, effects } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "NotSupportedError",
            errorMessage: "no supported source",
            isPageHidden: false,
            nowMs: 2_000,
        },
    );
    assert.equal(state.status, "error");
    assert.ok(kinds(effects).includes("emitPlayError"));
});

// ---------------------------------------------------------------------------
// Reload + page restore
// ---------------------------------------------------------------------------

test("RELOAD_REQUESTED reloads from the stored source without autoplay (orchestrator restores position)", () => {
    const { effects } = transitionNativeEngine(playingState(), {
        type: "RELOAD_REQUESTED",
        nowMs: 3_000,
    });
    const reload = findEffect(effects, "reloadFromSource");
    assert.equal(reload?.resumeAtSec, 0);
    assert.equal(reload?.resumePlaying, false);
});

test("RELOAD_REQUESTED without a source is a no-op", () => {
    const { effects } = transitionNativeEngine(
        createInitialNativeEngineState(),
        { type: "RELOAD_REQUESTED", nowMs: 3_000 },
    );
    assert.deepEqual(effects, []);
});

test("PAGE_RESTORED resyncs a stale playing status to the element's paused reality", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "PAGE_RESTORED",
        elementPaused: true,
        elementEnded: false,
        nowMs: 7_000,
    });
    assert.equal(state.status, "paused");
    assert.equal(state.pauseClassification, "external");
    assert.ok(kinds(effects).includes("stopTicker"));
    assert.ok(kinds(effects).includes("emitPause"));
});

test("PAGE_RESTORED with an ended element emits the missed end", () => {
    const { state, effects } = transitionNativeEngine(playingState(), {
        type: "PAGE_RESTORED",
        elementPaused: true,
        elementEnded: true,
        nowMs: 7_000,
    });
    assert.equal(state.status, "ended");
    assert.ok(kinds(effects).includes("emitEnd"));
});

test("PAGE_RESTORED with a consistent state is a no-op", () => {
    const { effects } = transitionNativeEngine(loadedState(), {
        type: "PAGE_RESTORED",
        elementPaused: true,
        elementEnded: false,
        nowMs: 7_000,
    });
    assert.deepEqual(effects, []);
});

// ---------------------------------------------------------------------------
// Visibility retry (GH #53): autoplay rejected while the page is hidden
// ---------------------------------------------------------------------------

test("NotAllowedError while hidden arms a visibility retry alongside the gesture retry", () => {
    const { state, effects } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "NotAllowedError",
            errorMessage: "blocked in background tab",
            isPageHidden: true,
            nowMs: 2_000,
        },
    );
    assert.equal(state.status, "paused");
    assert.ok(kinds(effects).includes("armVisibilityRetry"));
    assert.ok(kinds(effects).includes("armGestureRetry"));
});

test("NotAllowedError while visible does not arm a visibility retry", () => {
    const { effects } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "NotAllowedError",
            errorMessage: "blocked",
            isPageHidden: false,
            nowMs: 2_000,
        },
    );
    assert.equal(kinds(effects).includes("armVisibilityRetry"), false);
});

test("VISIBILITY_RETRY_FIRED plays once and disarms", () => {
    const { state: blocked } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "NotAllowedError",
            errorMessage: "blocked in background tab",
            isPageHidden: true,
            nowMs: 2_000,
        },
    );
    const { effects } = transitionNativeEngine(blocked, {
        type: "VISIBILITY_RETRY_FIRED",
        nowMs: 3_000,
    });
    assert.ok(kinds(effects).includes("callPlay"));
    assert.ok(kinds(effects).includes("disarmVisibilityRetry"));
});

test("VISIBILITY_RETRY_FIRED after a user pause disarms without playing", () => {
    const { state: blocked } = transitionNativeEngine(
        loadedState({ autoplay: true }),
        {
            type: "PLAY_PROMISE_REJECTED",
            errorName: "NotAllowedError",
            errorMessage: "blocked in background tab",
            isPageHidden: true,
            nowMs: 2_000,
        },
    );
    const { effects } = transitionNativeEngine(
        { ...blocked, pauseClassification: "user" },
        { type: "VISIBILITY_RETRY_FIRED", nowMs: 3_000 },
    );
    assert.equal(kinds(effects).includes("callPlay"), false);
    assert.ok(kinds(effects).includes("disarmVisibilityRetry"));
});

test("VISIBILITY_RETRY_FIRED while already playing only disarms", () => {
    const { effects } = transitionNativeEngine(playingState(), {
        type: "VISIBILITY_RETRY_FIRED",
        nowMs: 3_000,
    });
    assert.equal(kinds(effects).includes("callPlay"), false);
    assert.ok(kinds(effects).includes("disarmVisibilityRetry"));
});
