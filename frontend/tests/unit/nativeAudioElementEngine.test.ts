import assert from "node:assert/strict";
import test from "node:test";
import {
    NativeAudioElementEngine,
    type NativeAudioElementEngineOptions,
    type NativeAudioElementLike,
    type NativeEngineScheduler,
} from "../../lib/audio-engine/nativeAudioElementEngine";
import { IosStandaloneAudioContextBridge } from "../../lib/audio-engine/iosStandalonePwaBridge";
import { NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES } from "../../lib/audio-engine/nativeAudioElementPolicy";

type ElementListener = (event: unknown) => void;

type PlayBehavior =
    | { kind: "resolve" }
    | { kind: "reject"; name: string; message: string };

class FakeAudioElement implements NativeAudioElementLike {
    currentTime = 0;
    duration = Number.NaN;
    paused = true;
    ended = false;
    muted = false;
    volume = 1;
    preload = "";
    crossOrigin: string | null = null;
    error: { code: number; message?: string } | null = null;

    playCalls = 0;
    pauseCalls = 0;
    srcAssignments = 0;
    playBehavior: PlayBehavior = { kind: "resolve" };

    private srcValue = "";
    private readonly listeners = new Map<string, Set<ElementListener>>();

    get src(): string {
        return this.srcValue;
    }

    // Mirrors the media load algorithm: assigning src synchronously stops
    // the in-progress stream and resets readiness.
    set src(value: string) {
        this.srcAssignments += 1;
        this.srcValue = value;
        this.paused = true;
        this.ended = false;
        this.currentTime = 0;
        this.duration = Number.NaN;
        this.error = null;
    }

    play(): Promise<void> {
        this.playCalls += 1;
        if (this.playBehavior.kind === "reject") {
            const error = new Error(this.playBehavior.message);
            error.name = this.playBehavior.name;
            return Promise.reject(error);
        }
        this.paused = false;
        this.fire("playing");
        return Promise.resolve();
    }

    pause(): void {
        this.pauseCalls += 1;
        if (!this.paused) {
            this.paused = false;
        }
        this.paused = true;
        this.fire("pause");
    }

    removeAttribute(name: string): void {
        if (name === "src") {
            this.srcValue = "";
        }
    }

    load(): void {
        // No-op for the fake; assigning src already resets state.
    }

    addEventListener(type: string, listener: ElementListener): void {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(listener);
    }

    removeEventListener(type: string, listener: ElementListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    listenerCount(): number {
        let count = 0;
        this.listeners.forEach((set) => {
            count += set.size;
        });
        return count;
    }

    fire(type: string, event: unknown = {}): void {
        this.listeners.get(type)?.forEach((listener) => listener(event));
    }

    fireLoadedMetadata(duration: number): void {
        this.duration = duration;
        this.fire("loadedmetadata");
    }

    fireError(code: number, message?: string): void {
        this.error = { code, message };
        this.fire("error");
    }
}

interface FakeTimer {
    id: number;
    callback: () => void;
    delayMs: number;
    cleared: boolean;
}

class FakeScheduler implements NativeEngineScheduler {
    timers: FakeTimer[] = [];
    tickers: FakeTimer[] = [];
    private nextId = 1;

    setTimer(callback: () => void, delayMs: number): unknown {
        const timer = { id: this.nextId++, callback, delayMs, cleared: false };
        this.timers.push(timer);
        return timer.id;
    }

    clearTimer(id: unknown): void {
        const timer = this.timers.find((entry) => entry.id === id);
        if (timer) {
            timer.cleared = true;
        }
    }

    setTicker(callback: () => void, delayMs: number): unknown {
        const ticker = { id: this.nextId++, callback, delayMs, cleared: false };
        this.tickers.push(ticker);
        return ticker.id;
    }

    clearTicker(id: unknown): void {
        const ticker = this.tickers.find((entry) => entry.id === id);
        if (ticker) {
            ticker.cleared = true;
        }
    }

    firePendingTimer(): void {
        const pending = this.timers.find((timer) => !timer.cleared);
        assert.ok(pending, "expected a pending retry timer");
        pending.cleared = true;
        pending.callback();
    }

    activeTickerCount(): number {
        return this.tickers.filter((ticker) => !ticker.cleared).length;
    }
}

interface GlobalBinding {
    target: "window" | "document";
    type: string;
    handler: (event: unknown) => void;
    removed: boolean;
}

interface Harness {
    engine: NativeAudioElementEngine;
    elements: FakeAudioElement[];
    scheduler: FakeScheduler;
    bindings: GlobalBinding[];
    telemetryEvents: Array<{ event: string; fields: Record<string, unknown> }>;
    events: Array<{ type: string; payload: unknown }>;
    mainElement(): FakeAudioElement;
    setNow(ms: number): void;
}

const createHarness = (
    overrides: Partial<NativeAudioElementEngineOptions> = {},
): Harness => {
    const elements: FakeAudioElement[] = [];
    const scheduler = new FakeScheduler();
    const bindings: GlobalBinding[] = [];
    const telemetryEvents: Array<{
        event: string;
        fields: Record<string, unknown>;
    }> = [];
    const events: Array<{ type: string; payload: unknown }> = [];
    let nowMs = 1_000;

    const engine = new NativeAudioElementEngine({
        createElement: () => {
            const element = new FakeAudioElement();
            elements.push(element);
            return element;
        },
        now: () => nowMs,
        scheduler,
        bindGlobalListener: (target, type, handler) => {
            const binding: GlobalBinding = {
                target,
                type,
                handler,
                removed: false,
            };
            bindings.push(binding);
            return () => {
                binding.removed = true;
            };
        },
        isPageHidden: () => false,
        iosBridgeGate: () => false,
        telemetry: (event, fields) => {
            telemetryEvents.push({ event, fields });
        },
        ...overrides,
    });

    const trackedEvents = [
        "load",
        "play",
        "pause",
        "stop",
        "end",
        "seek",
        "timeupdate",
        "loaderror",
        "playerror",
        "buffering",
        "volume",
    ] as const;
    trackedEvents.forEach((type) => {
        engine.on(type, ((payload: unknown) => {
            events.push({ type, payload });
        }) as never);
    });

    return {
        engine,
        elements,
        scheduler,
        bindings,
        telemetryEvents,
        events,
        mainElement: () => {
            assert.ok(elements.length > 0, "expected an element to exist");
            return elements[0];
        },
        setNow: (ms: number) => {
            nowMs = ms;
        },
    };
};

const flushMicrotasks = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
};

const eventTypes = (harness: Harness): string[] =>
    harness.events.map((event) => event.type);

// ---------------------------------------------------------------------------
// Single element, single load path
// ---------------------------------------------------------------------------

test("load creates exactly one element, configures it up front, and sets src directly", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track-1.flac", {
        autoplay: false,
    });
    harness.engine.load("https://stream.example/track-2.flac", {
        autoplay: false,
    });

    assert.equal(harness.elements.length, 1, "one engine-owned element");
    const element = harness.mainElement();
    assert.equal(element.src, "https://stream.example/track-2.flac");
    assert.equal(element.preload, "auto");
    assert.equal(element.crossOrigin, "anonymous");
});

test("load with withCredentials switches crossOrigin to use-credentials", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        withCredentials: true,
    });
    assert.equal(harness.mainElement().crossOrigin, "use-credentials");
});

test("load rejects an empty source URL", () => {
    const harness = createHarness();
    assert.throws(() => harness.engine.load(""), /non-empty source URL/);
});

test("duplicate load of the current source never restarts playback (LT resync regression)", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.mainElement().currentTime = 30;
    const srcAssignmentsBefore = harness.mainElement().srcAssignments;
    const playCallsBefore = harness.mainElement().playCalls;

    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    assert.equal(
        harness.mainElement().srcAssignments,
        srcAssignmentsBefore,
        "no src reassignment for the already-loaded source",
    );
    assert.equal(harness.mainElement().currentTime, 30, "position preserved");
    assert.equal(harness.mainElement().paused, false, "still playing");
    assert.equal(
        harness.mainElement().playCalls,
        playCallsBefore,
        "no redundant play call while playing",
    );
});

test("duplicate load with autoplay resumes a paused current source without reloading", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.engine.pause();
    const srcAssignmentsBefore = harness.mainElement().srcAssignments;

    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    assert.equal(harness.mainElement().srcAssignments, srcAssignmentsBefore);
    assert.equal(harness.mainElement().paused, false, "resumed via play()");
});

test("same-URL load that changes withCredentials reloads so crossOrigin is honored", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: false,
    });
    assert.equal(harness.mainElement().crossOrigin, "anonymous");
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: false,
        withCredentials: true,
    });
    assert.equal(harness.mainElement().crossOrigin, "use-credentials");
});

test("legacy boolean-autoplay load signature is supported", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", true, "flac");
    harness.mainElement().fireLoadedMetadata(180);
    assert.equal(harness.mainElement().playCalls, 1);
});

test("autoplay captured at load time starts playback exactly once after readiness", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    const element = harness.mainElement();
    assert.equal(element.playCalls, 0, "no play before readiness");
    element.fireLoadedMetadata(200);
    assert.equal(element.playCalls, 1);
    assert.ok(eventTypes(harness).includes("play"));
});

test("play() during an in-flight load flips autoplay without a second load (shuffle+next race)", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: false,
    });
    const element = harness.mainElement();
    const srcAssignmentsBefore = element.src;
    harness.engine.play();
    assert.equal(element.playCalls, 0, "no play call before readiness");
    assert.equal(element.src, srcAssignmentsBefore, "no re-load");
    element.fireLoadedMetadata(200);
    assert.equal(element.playCalls, 1, "exactly one play call");
});

test("double-play regression: rapid track spam leaves one element and at most one non-paused stream", async () => {
    const harness = createHarness();
    for (let index = 0; index < 25; index += 1) {
        harness.engine.load(`https://stream.example/track-${index}.flac`, {
            autoplay: true,
        });
        if (index % 3 === 0) {
            harness.engine.play();
        }
        if (index % 5 === 0) {
            harness.mainElement().fireLoadedMetadata(200);
        }
    }
    harness.mainElement().fireLoadedMetadata(200);
    await flushMicrotasks();

    // Structural assertion: the engine never created a second playable
    // element, so two audible streams are impossible.
    assert.equal(harness.elements.length, 1);
    const nonPaused = harness.elements.filter((element) => !element.paused);
    assert.ok(nonPaused.length <= 1);
    assert.equal(
        harness.mainElement().src,
        "https://stream.example/track-24.flac",
    );
});

// ---------------------------------------------------------------------------
// Pause / stop / volume
// ---------------------------------------------------------------------------

test("pause during load suppresses the captured autoplay", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.engine.pause();
    harness.mainElement().fireLoadedMetadata(200);
    assert.equal(harness.mainElement().playCalls, 0);
});

test("stop halts the element, resets position, and emits stop", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.mainElement().currentTime = 42;
    harness.engine.stop();
    assert.equal(harness.mainElement().paused, true);
    assert.equal(harness.mainElement().currentTime, 0);
    assert.ok(eventTypes(harness).includes("stop"));
});

test("volume and mute apply to the element and volume changes are emitted", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac");
    harness.engine.setVolume(0.4);
    assert.equal(harness.mainElement().volume, 0.4);
    harness.engine.setMuted(true);
    assert.equal(harness.mainElement().muted, true);
    const volumeEvents = harness.events.filter(
        (event) => event.type === "volume",
    );
    assert.equal(volumeEvents.length, 1);
    assert.deepEqual(volumeEvents[0].payload, { volume: 0.4 });
});

test("volume changed while muted is applied on the element so unmute uses the fresh volume", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac");
    harness.engine.setMuted(true);
    harness.engine.setVolume(0.7);
    harness.engine.setMuted(false);
    assert.equal(harness.mainElement().muted, false);
    assert.equal(harness.mainElement().volume, 0.7);
});

// ---------------------------------------------------------------------------
// Seek — queued before readiness (podcast/audiobook resume), marks after
// ---------------------------------------------------------------------------

test("seek before readiness is queued and applied on loadedmetadata", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/episode.mp3", {
        autoplay: false,
    });
    harness.engine.seek(1_800);
    assert.equal(
        harness.mainElement().currentTime,
        0,
        "seek not applied before readiness",
    );
    assert.equal(harness.engine.isCurrentlySeeking(), true);
    assert.equal(harness.engine.getSeekTarget(), 1_800);

    harness.mainElement().fireLoadedMetadata(3_600);
    assert.equal(harness.mainElement().currentTime, 1_800);
});

test("startTimeSec load option resumes at position via the same queued-seek path", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/audiobook.m4b", {
        autoplay: true,
        startTimeSec: 900,
    });
    harness.mainElement().fireLoadedMetadata(7_200);
    assert.equal(harness.mainElement().currentTime, 900);
    assert.equal(harness.mainElement().playCalls, 1);
});

test("stale timeupdate positions are suppressed during the seek mark, then flow again", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(300);
    harness.events.length = 0;

    harness.setNow(2_000);
    harness.engine.seek(120);
    harness.mainElement().currentTime = 4; // stale pipeline position
    harness.setNow(2_050);
    harness.mainElement().fire("timeupdate");
    assert.equal(
        harness.events.filter((event) => event.type === "timeupdate").length,
        0,
        "stale position suppressed",
    );

    harness.mainElement().currentTime = 120.5;
    harness.setNow(2_100);
    harness.mainElement().fire("timeupdate");
    const updates = harness.events.filter(
        (event) => event.type === "timeupdate",
    );
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].payload, { timeSec: 120.5 });
});

// ---------------------------------------------------------------------------
// End detection — native ended only
// ---------------------------------------------------------------------------

test("native ended event emits end exactly once and stops the ticker", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    assert.equal(harness.scheduler.activeTickerCount(), 1);

    harness.mainElement().ended = true;
    harness.mainElement().fire("ended");
    harness.mainElement().fire("ended");
    assert.equal(
        harness.events.filter((event) => event.type === "end").length,
        1,
    );
    assert.equal(harness.scheduler.activeTickerCount(), 0);
    assert.equal(harness.engine.hasTrackEnded(), true);
});

test("notifyTrackEnded emits while playing, re-emits after end, and no-ops without a source", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.engine.notifyTrackEnded();
    assert.equal(
        harness.events.filter((event) => event.type === "end").length,
        1,
    );
    harness.engine.notifyTrackEnded();
    assert.equal(
        harness.events.filter((event) => event.type === "end").length,
        2,
    );

    const unloadedHarness = createHarness();
    unloadedHarness.engine.notifyTrackEnded();
    assert.equal(
        unloadedHarness.events.filter((event) => event.type === "end").length,
        0,
    );
});

// ---------------------------------------------------------------------------
// Errors, retries, and recovery
// ---------------------------------------------------------------------------

test("transient network load error retries via timer and recovers", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireError(2, "network hiccup");
    assert.equal(harness.telemetryEvents[0]?.event, "recovery_attempt");

    harness.scheduler.firePendingTimer();
    assert.equal(
        harness.mainElement().src,
        "https://stream.example/track.flac",
        "retry re-applies the same source",
    );
    harness.mainElement().fireLoadedMetadata(200);
    assert.equal(harness.mainElement().playCalls, 1);
});

test("retries exhaust into a loaderror with the MEDIA_ERR code as a string", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    for (
        let attempt = 0;
        attempt <= NATIVE_ENGINE_MAX_AUTOMATIC_RETRIES;
        attempt += 1
    ) {
        harness.mainElement().fireError(2, "network down");
    }
    const loadErrors = harness.events.filter(
        (event) => event.type === "loaderror",
    );
    assert.equal(loadErrors.length, 1);
    const payload = loadErrors[0].payload as {
        error: Error;
        code?: string;
        recoverable?: boolean;
    };
    assert.equal(payload.code, "2");
    assert.ok(payload.error.message.includes("MEDIA_ERR_NETWORK"));
    assert.equal(payload.recoverable, false);
});

test("background network error surfaces a recoverable playerror and preserves the element", () => {
    const harness = createHarness({ isPageHidden: () => true });
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.mainElement().fireError(2, "session reclaimed");

    const playErrors = harness.events.filter(
        (event) => event.type === "playerror",
    );
    assert.equal(playErrors.length, 1);
    const payload = playErrors[0].payload as {
        error: Error;
        code?: string;
        recoverable?: boolean;
    };
    assert.equal(payload.code, "2");
    assert.ok(payload.error.message.includes("MEDIA_ERR_NETWORK"));
    assert.equal(payload.recoverable, true);
    assert.equal(
        harness.mainElement().src,
        "https://stream.example/track.flac",
        "media preserved for foreground recovery",
    );
});

test("mid-playback transient error recovers by reloading at position and resuming playback", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.mainElement().currentTime = 88;
    harness.mainElement().fireError(3, "decode glitch mid-playback");

    // The engine re-applies the load immediately (no dangling timer)…
    assert.equal(
        harness.scheduler.timers.filter((timer) => !timer.cleared).length,
        0,
    );
    assert.equal(
        harness.mainElement().src,
        "https://stream.example/track.flac",
    );
    // …and readiness resumes at the position where the error hit.
    const playCallsBefore = harness.mainElement().playCalls;
    harness.mainElement().fireLoadedMetadata(200);
    assert.equal(harness.mainElement().currentTime, 88);
    assert.equal(harness.mainElement().playCalls, playCallsBefore + 1);
});

test("play() after an error state reloads from the stored source at the current position", () => {
    const harness = createHarness({ isPageHidden: () => true });
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.mainElement().currentTime = 63;
    harness.mainElement().fireError(2, "session reclaimed");

    const playCallsBeforeRecovery = harness.mainElement().playCalls;
    harness.engine.play();
    harness.mainElement().fireLoadedMetadata(200);
    assert.equal(
        harness.mainElement().currentTime,
        63,
        "resume position restored by queued seek",
    );
    assert.equal(harness.mainElement().playCalls, playCallsBeforeRecovery + 1);
});

// ---------------------------------------------------------------------------
// Autoplay policy — NotAllowedError and the single gesture retry
// ---------------------------------------------------------------------------

test("NotAllowedError emits playerror and retries exactly once on the next gesture", async () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().playBehavior = {
        kind: "reject",
        name: "NotAllowedError",
        message: "user gesture required",
    };
    harness.mainElement().fireLoadedMetadata(200);
    await flushMicrotasks();

    const playErrors = harness.events.filter(
        (event) => event.type === "playerror",
    );
    assert.equal(playErrors.length, 1);
    const gestureBindings = harness.bindings.filter(
        (binding) => binding.target === "document" && !binding.removed,
    );
    assert.ok(gestureBindings.length > 0, "gesture retry armed");

    harness.mainElement().playBehavior = { kind: "resolve" };
    gestureBindings[0].handler({});
    await flushMicrotasks();
    assert.equal(harness.mainElement().playCalls, 2);
    assert.ok(
        harness.bindings
            .filter((binding) => binding.target === "document")
            .every((binding) => binding.removed),
        "gesture retry disarmed after firing",
    );
});

test("no automatic retry timers are scheduled for NotAllowedError", async () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().playBehavior = {
        kind: "reject",
        name: "NotAllowedError",
        message: "blocked",
    };
    harness.mainElement().fireLoadedMetadata(200);
    await flushMicrotasks();
    assert.equal(
        harness.scheduler.timers.filter((timer) => !timer.cleared).length,
        0,
    );
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

test("reload() rebuilds from the stored source without autoplay (orchestrator restores position)", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.events.length = 0;

    harness.engine.reload();
    harness.mainElement().fireLoadedMetadata(200);
    assert.equal(harness.mainElement().playCalls, 1, "no autoplay on reload");
    assert.ok(eventTypes(harness).includes("load"));
});

// ---------------------------------------------------------------------------
// Preload — one muted, never-audible buffer element
// ---------------------------------------------------------------------------

test("preload uses a single muted buffer element that never plays", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track-1.flac", {
        autoplay: true,
    });
    harness.engine.preload("https://stream.example/track-2.flac", {
        format: "flac",
    });
    harness.engine.preload("https://stream.example/track-3.flac", {
        format: "flac",
    });

    assert.equal(harness.elements.length, 2, "main + one preload buffer");
    const buffer = harness.elements[1];
    assert.equal(buffer.muted, true);
    assert.equal(buffer.volume, 0);
    assert.equal(buffer.playCalls, 0);
    assert.equal(buffer.src, "https://stream.example/track-3.flac");
});

test("preload skips the currently loaded source", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track-1.flac");
    harness.engine.preload("https://stream.example/track-1.flac");
    assert.equal(harness.elements.length, 1, "no buffer element created");
});

// ---------------------------------------------------------------------------
// iOS standalone bridge gating
// ---------------------------------------------------------------------------

test("iOS bridge is established lazily on play only when the gate passes", () => {
    let created = 0;
    const bridge = new IosStandaloneAudioContextBridge(() => {
        created += 1;
        return {
            state: "running" as AudioContextState,
            destination: {} as AudioDestinationNode,
            createMediaElementSource: () => ({ connect: () => undefined }),
            resume: () => Promise.resolve(),
            close: () => Promise.resolve(),
        };
    });
    const harness = createHarness({
        iosBridgeGate: () => true,
        iosBridge: bridge,
    });
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: false,
    });
    harness.mainElement().fireLoadedMetadata(200);
    assert.equal(created, 0, "no bridge before a play call");
    harness.engine.play();
    assert.equal(created, 1);
    assert.equal(bridge.isActive(), true);
});

test("no AudioContext bridge on the default (non-iOS-standalone) path", () => {
    let created = 0;
    const bridge = new IosStandaloneAudioContextBridge(() => {
        created += 1;
        return null;
    });
    const harness = createHarness({
        iosBridgeGate: () => false,
        iosBridge: bridge,
    });
    harness.engine.load("https://stream.example/hires-24-192.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.engine.play();
    assert.equal(created, 0, "bare element pipeline for hi-res");
});

// ---------------------------------------------------------------------------
// BFCache page restore
// ---------------------------------------------------------------------------

test("pageshow with persisted=true resyncs a stale playing state", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.events.length = 0;

    // Simulate a BFCache restore where the element is actually paused.
    harness.mainElement().paused = true;
    const pageShow = harness.bindings.find(
        (binding) => binding.target === "window" && binding.type === "pageshow",
    );
    assert.ok(pageShow, "pageshow listener bound");
    pageShow.handler({ persisted: true });
    assert.ok(eventTypes(harness).includes("pause"));
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

test("playback start latency is reported through the telemetry sink", () => {
    const harness = createHarness();
    harness.setNow(1_000);
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.setNow(1_450);
    harness.mainElement().fireLoadedMetadata(200);
    const latency = harness.telemetryEvents.find(
        (entry) => entry.event === "playback_start_latency",
    );
    assert.ok(latency);
    assert.equal(latency.fields.latencyMs, 450);
});

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

test("destroy releases elements, timers, and global listeners", () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().fireLoadedMetadata(200);
    harness.engine.preload("https://stream.example/next.flac");

    harness.engine.destroy();
    assert.equal(harness.scheduler.activeTickerCount(), 0);
    assert.ok(
        harness.bindings.every((binding) => binding.removed),
        "all global listeners removed",
    );
    assert.equal(harness.mainElement().listenerCount(), 0);
    assert.equal(harness.mainElement().src, "");
    assert.equal(harness.engine.isPlaying(), false);
});

test("NotAllowedError in a hidden tab retries automatically when the page becomes visible", async () => {
    let hidden = true;
    const harness = createHarness({ isPageHidden: () => hidden });
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().playBehavior = {
        kind: "reject",
        name: "NotAllowedError",
        message: "background tab autoplay blocked",
    };
    harness.mainElement().fireLoadedMetadata(200);
    await flushMicrotasks();

    const visibilityBindings = harness.bindings.filter(
        (binding) =>
            binding.target === "document" &&
            binding.type === "visibilitychange" &&
            !binding.removed,
    );
    assert.equal(visibilityBindings.length, 1, "visibility retry armed");

    // A visibility event while still hidden must not retry.
    visibilityBindings[0].handler({});
    await flushMicrotasks();
    assert.equal(harness.mainElement().playCalls, 1);

    // Tab returns to the foreground: exactly one automatic retry.
    hidden = false;
    harness.mainElement().playBehavior = { kind: "resolve" };
    visibilityBindings[0].handler({});
    await flushMicrotasks();
    assert.equal(harness.mainElement().playCalls, 2);
    assert.ok(
        harness.bindings
            .filter((binding) => binding.type === "visibilitychange")
            .every((binding) => binding.removed),
        "visibility retry disarmed after firing",
    );
});

test("NotAllowedError in a visible tab does not arm a visibility retry", async () => {
    const harness = createHarness();
    harness.engine.load("https://stream.example/track.flac", {
        autoplay: true,
    });
    harness.mainElement().playBehavior = {
        kind: "reject",
        name: "NotAllowedError",
        message: "user gesture required",
    };
    harness.mainElement().fireLoadedMetadata(200);
    await flushMicrotasks();
    assert.equal(
        harness.bindings.filter(
            (binding) => binding.type === "visibilitychange",
        ).length,
        0,
    );
});
