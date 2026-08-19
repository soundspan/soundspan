import assert from "node:assert/strict";
import test from "node:test";
import { HybridRuntimeAudioEngine } from "../../lib/audio-engine/index";
import {
    NativeAudioElementEngine,
    type NativeAudioElementLike,
    type NativeEngineScheduler,
} from "../../lib/audio-engine/nativeAudioElementEngine";
import type { AudioEngine } from "../../lib/audio-engine/types";

type ElementListener = (event: unknown) => void;

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

    private srcValue = "";
    private readonly listeners = new Map<string, Set<ElementListener>>();

    get src(): string {
        return this.srcValue;
    }

    set src(value: string) {
        this.srcValue = value;
        this.paused = true;
        this.ended = false;
        this.currentTime = 0;
        this.duration = Number.NaN;
        this.error = null;
    }

    play(): Promise<void> {
        this.playCalls += 1;
        this.paused = false;
        this.fire("playing");
        return Promise.resolve();
    }

    pause(): void {
        this.paused = true;
        this.fire("pause");
    }

    removeAttribute(name: string): void {
        if (name === "src") {
            this.srcValue = "";
        }
    }

    load(): void {}

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

    fire(type: string, event: unknown = {}): void {
        this.listeners.get(type)?.forEach((listener) => listener(event));
    }

    fireLoadedMetadata(duration: number): void {
        this.duration = duration;
        this.fire("loadedmetadata");
    }
}

const noopScheduler: NativeEngineScheduler = {
    setTimer: () => null,
    clearTimer: () => undefined,
    setTicker: () => null,
    clearTicker: () => undefined,
};

interface NativeHarness {
    engine: NativeAudioElementEngine;
    elements: FakeAudioElement[];
}

const createNativeEngine = (): NativeHarness => {
    const elements: FakeAudioElement[] = [];
    const engine = new NativeAudioElementEngine({
        createElement: () => {
            const element = new FakeAudioElement();
            elements.push(element);
            return element;
        },
        now: () => 1_000,
        scheduler: noopScheduler,
        bindGlobalListener: () => () => undefined,
        isPageHidden: () => false,
        iosBridgeGate: () => false,
        telemetry: () => undefined,
    });
    return { engine, elements };
};

const createHybridWithNativeSlot = (): {
    hybrid: HybridRuntimeAudioEngine;
    native: NativeHarness;
} => {
    const native = createNativeEngine();
    const hybrid = new HybridRuntimeAudioEngine({
        howlerEngine: native.engine,
        directEngineDescriptor: "native",
        resolveMode: () => "native",
        createVideoJsEngine: () => {
            throw new Error("video.js must not load in native mode");
        },
    });
    return { hybrid, native };
};

test("hybrid routes direct loads to the native engine in native mode", () => {
    const { hybrid, native } = createHybridWithNativeSlot();
    hybrid.load("https://stream.example/track.flac", { autoplay: true });
    assert.equal(native.elements.length, 1);
    assert.equal(native.elements[0].src, "https://stream.example/track.flac");
});

test("hybrid forwards native engine events to its listeners", () => {
    const { hybrid, native } = createHybridWithNativeSlot();
    const seen: Array<{ type: string; payload: unknown }> = [];
    hybrid.on("load", (payload) => seen.push({ type: "load", payload }));
    hybrid.on("play", () => seen.push({ type: "play", payload: undefined }));

    hybrid.load("https://stream.example/track.flac", { autoplay: true });
    native.elements[0].fireLoadedMetadata(240);

    assert.deepEqual(seen[0], {
        type: "load",
        payload: { durationSec: 240 },
    });
    assert.equal(seen[1]?.type, "play");
});

test("volume and mute state are applied to the native slot engine", () => {
    const { hybrid, native } = createHybridWithNativeSlot();
    hybrid.setVolume(0.25);
    hybrid.setMuted(true);
    hybrid.load("https://stream.example/track.flac", { autoplay: false });
    assert.equal(native.elements[0].volume, 0.25);
    assert.equal(native.elements[0].muted, true);
});

test("upgradeHowlerEngine hot-swap preserves volume/mute (rollback path guarantees)", () => {
    const { hybrid } = createHybridWithNativeSlot();
    hybrid.setVolume(0.3);
    hybrid.setMuted(true);

    const replacement = createNativeEngine();
    hybrid.upgradeHowlerEngine(replacement.engine as unknown as AudioEngine);
    hybrid.load("https://stream.example/track.flac", { autoplay: false });
    assert.equal(replacement.elements[0].volume, 0.3);
    assert.equal(replacement.elements[0].muted, true);
});

test("double-play through the hybrid: rapid load/play spam keeps one element, one active stream", async () => {
    const { hybrid, native } = createHybridWithNativeSlot();
    for (let index = 0; index < 20; index += 1) {
        hybrid.load(`https://stream.example/track-${index}.flac`, {
            autoplay: true,
        });
        hybrid.play();
        if (index % 4 === 0) {
            native.elements[0].fireLoadedMetadata(180);
        }
    }
    native.elements[0].fireLoadedMetadata(180);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(native.elements.length, 1, "single engine-owned element");
    assert.equal(
        native.elements.filter((element) => !element.paused).length <= 1,
        true,
    );
    assert.equal(
        native.elements[0].src,
        "https://stream.example/track-19.flac",
    );
});

test("getActiveEngineDescriptor reports the engine actually in use, not just the flag", () => {
    const { hybrid } = createHybridWithNativeSlot();
    assert.equal(hybrid.getActiveEngineDescriptor(), "native");

    const plain = new HybridRuntimeAudioEngine({
        howlerEngine: createNativeEngine().engine,
        resolveMode: () => "howler",
        createVideoJsEngine: () => {
            throw new Error("not used");
        },
    });
    assert.equal(
        plain.getActiveEngineDescriptor(),
        "howler",
        "descriptor defaults to howler when the slot is not declared native",
    );
});

test("upgradeHowlerEngine updates the direct-slot descriptor", () => {
    const hybrid = new HybridRuntimeAudioEngine({
        howlerEngine: createNativeEngine().engine,
        resolveMode: () => "howler",
        createVideoJsEngine: () => {
            throw new Error("not used");
        },
    });
    assert.equal(hybrid.getActiveEngineDescriptor(), "howler");
    hybrid.upgradeHowlerEngine(
        createNativeEngine().engine as unknown as AudioEngine,
        "native",
    );
    assert.equal(hybrid.getActiveEngineDescriptor(), "native");
});

test("getActiveEngineDescriptor reports videojs while the segmented engine is active", async () => {
    const stubVideoJs: AudioEngine = {
        load: () => undefined,
        play: () => undefined,
        pause: () => undefined,
        stop: () => undefined,
        seek: () => undefined,
        setVolume: () => undefined,
        setMuted: () => undefined,
        getCurrentTime: () => 0,
        getDuration: () => 0,
        isPlaying: () => false,
        on: () => undefined,
        off: () => undefined,
    };
    const native = createNativeEngine();
    const hybrid = new HybridRuntimeAudioEngine({
        howlerEngine: native.engine,
        resolveMode: () => "videojs",
        createVideoJsEngine: () => stubVideoJs,
    });

    hybrid.load(
        { url: "https://stream.example/manifest.mpd", protocol: "dash" },
        { autoplay: false },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hybrid.getActiveEngineDescriptor(), "videojs");

    // Loading a direct source routes back to the direct slot.
    hybrid.load("https://stream.example/track.flac", { autoplay: false });
    assert.equal(hybrid.getActiveEngineDescriptor(), "howler");
});

test("existing engine interface methods pass through to the native engine", () => {
    const { hybrid, native } = createHybridWithNativeSlot();
    hybrid.load("https://stream.example/track.flac", { autoplay: true });
    native.elements[0].fireLoadedMetadata(240);
    native.elements[0].currentTime = 12;

    assert.equal(hybrid.getDuration(), 240);
    assert.equal(hybrid.getCurrentTime(), 12);
    assert.equal(hybrid.getActualCurrentTime(), 12);
    assert.equal(hybrid.isPlaying(), true);
    assert.equal(hybrid.hasTrackEnded(), false);
    assert.equal(hybrid.isCurrentlySeeking(), false);
    assert.equal(hybrid.getSeekTarget(), null);
});
