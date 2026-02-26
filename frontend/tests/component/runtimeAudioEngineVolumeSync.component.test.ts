import assert from "node:assert/strict";
import test from "node:test";
import { HybridRuntimeAudioEngine } from "../../lib/audio-engine/index.ts";
import type {
    AudioEngine,
    AudioEngineEventHandler,
    AudioEngineEventType,
    AudioEngineLoadOptions,
    AudioEngineSource,
} from "../../lib/audio-engine/types.ts";

class FakeAudioEngine implements AudioEngine {
    public readonly loadCalls: Array<{
        source: AudioEngineSource | string;
        options: AudioEngineLoadOptions | undefined;
    }> = [];
    public readonly setVolumeCalls: number[] = [];
    public readonly setMutedCalls: boolean[] = [];
    public stopCalls = 0;
    public destroyCalls = 0;
    private currentTime = 0;
    private duration = 0;
    private playing = false;
    private readonly handlers = new Map<
        AudioEngineEventType,
        Set<(payload: unknown) => void>
    >();

    emit(event: AudioEngineEventType, payload: unknown): void {
        this.handlers.get(event)?.forEach((handler) => {
            handler(payload);
        });
    }

    load(source: AudioEngineSource | string, options?: AudioEngineLoadOptions) {
        this.loadCalls.push({ source, options });
    }

    play() {
        this.playing = true;
    }

    pause() {
        this.playing = false;
    }

    stop() {
        this.stopCalls += 1;
        this.playing = false;
    }

    seek(timeSec: number) {
        this.currentTime = timeSec;
    }

    setVolume(value: number) {
        this.setVolumeCalls.push(value);
    }

    setMuted(value: boolean) {
        this.setMutedCalls.push(Boolean(value));
    }

    getCurrentTime(): number {
        return this.currentTime;
    }

    getDuration(): number {
        return this.duration;
    }

    isPlaying(): boolean {
        return this.playing;
    }

    on<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>
    ) {
        let eventHandlers = this.handlers.get(event);
        if (!eventHandlers) {
            eventHandlers = new Set();
            this.handlers.set(event, eventHandlers);
        }
        eventHandlers.add(handler as (payload: unknown) => void);
    }

    off<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>
    ) {
        this.handlers
            .get(event)
            ?.delete(handler as (payload: unknown) => void);
    }

    destroy() {
        this.destroyCalls += 1;
    }
}

test("reapplies persisted volume and mute state when switching to DASH engine", () => {
    const howlerEngine = new FakeAudioEngine();
    const videoJsEngine = new FakeAudioEngine();
    const runtimeEngine = new HybridRuntimeAudioEngine({
        howlerEngine,
        createVideoJsEngine: () => videoJsEngine,
        resolveMode: () => "videojs",
    });

    runtimeEngine.setVolume(0.23);
    runtimeEngine.setMuted(true);

    runtimeEngine.load({
        url: "https://example.test/stream.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(howlerEngine.stopCalls, 1);
    assert.equal(videoJsEngine.loadCalls.length, 1);
    assert.equal(videoJsEngine.setVolumeCalls.at(-1), 0.23);
    assert.equal(videoJsEngine.setMutedCalls.at(-1), true);
});

test("keeps local output state when switching back to direct queue playback", () => {
    const howlerEngine = new FakeAudioEngine();
    const videoJsEngine = new FakeAudioEngine();
    const runtimeEngine = new HybridRuntimeAudioEngine({
        howlerEngine,
        createVideoJsEngine: () => videoJsEngine,
        resolveMode: () => "videojs",
    });

    runtimeEngine.setVolume(0.55);
    runtimeEngine.setMuted(false);
    runtimeEngine.load({
        url: "https://example.test/segmented.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    runtimeEngine.setVolume(0.12);
    runtimeEngine.setMuted(true);
    runtimeEngine.load("https://example.test/track.mp3", {
        autoplay: false,
    });

    assert.equal(videoJsEngine.stopCalls, 1);
    assert.equal(howlerEngine.loadCalls.length, 1);
    assert.equal(howlerEngine.setVolumeCalls.at(-1), 0.12);
    assert.equal(howlerEngine.setMutedCalls.at(-1), true);
});

test("falls back to Howler event stream when Video.js initialization fails", () => {
    const howlerEngine = new FakeAudioEngine();
    const runtimeEngine = new HybridRuntimeAudioEngine({
        howlerEngine,
        createVideoJsEngine: () => {
            throw new Error("videojs init failed");
        },
        resolveMode: () => "videojs",
    });

    let lastTimeUpdate: number | null = null;
    runtimeEngine.on("timeupdate", (payload) => {
        lastTimeUpdate = payload.timeSec;
    });

    runtimeEngine.load({
        url: "https://example.test/segmented.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    howlerEngine.emit("timeupdate", { timeSec: 12.34 });

    assert.equal(howlerEngine.loadCalls.length, 1);
    assert.equal(lastTimeUpdate, 12.34);
});
