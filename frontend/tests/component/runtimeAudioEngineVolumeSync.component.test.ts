import assert from "node:assert/strict";
import test from "node:test";
import { HybridRuntimeAudioEngine } from "../../lib/audio-engine/index.ts";
import type {
    AudioEngine,
    AudioEngineEventHandler,
    AudioEngineEventType,
    AudioEngineLoadOptions,
    AudioEngineRepresentationFailoverResult,
    AudioEngineSource,
} from "../../lib/audio-engine/types.ts";

class FakeAudioEngine implements AudioEngine {
    public readonly loadCalls: Array<{
        source: AudioEngineSource | string;
        options: AudioEngineLoadOptions | undefined;
    }> = [];
    public readonly setVolumeCalls: number[] = [];
    public readonly setMutedCalls: boolean[] = [];
    public readonly quarantineRepresentationCalls: Array<{
        representationId: string;
        cooldownMs: number;
    }> = [];
    public stopCalls = 0;
    public destroyCalls = 0;
    public clearRepresentationQuarantineCalls = 0;
    public quarantineRepresentationResult: AudioEngineRepresentationFailoverResult | null =
        null;
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

    quarantineRepresentation(
        representationId: string,
        cooldownMs: number
    ): AudioEngineRepresentationFailoverResult | null {
        this.quarantineRepresentationCalls.push({
            representationId,
            cooldownMs,
        });
        return this.quarantineRepresentationResult;
    }

    clearRepresentationQuarantine(): void {
        this.clearRepresentationQuarantineCalls += 1;
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

test("forwards representation quarantine to active DASH engine", () => {
    const howlerEngine = new FakeAudioEngine();
    const videoJsEngine = new FakeAudioEngine();
    videoJsEngine.quarantineRepresentationResult = {
        quarantinedRepresentationId: "0",
        selectedRepresentationId: "1",
        enabledRepresentationCount: 2,
        totalRepresentationCount: 3,
        allRepresentationsUnhealthy: false,
        didSwitchRepresentation: true,
    };
    const runtimeEngine = new HybridRuntimeAudioEngine({
        howlerEngine,
        createVideoJsEngine: () => videoJsEngine,
        resolveMode: () => "videojs",
    });

    runtimeEngine.load({
        url: "https://example.test/segmented.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });
    const result = runtimeEngine.quarantineRepresentation("0", 20_000);
    runtimeEngine.clearRepresentationQuarantine();

    assert.deepEqual(videoJsEngine.quarantineRepresentationCalls, [
        {
            representationId: "0",
            cooldownMs: 20_000,
        },
    ]);
    assert.equal(howlerEngine.quarantineRepresentationCalls.length, 0);
    assert.equal(videoJsEngine.clearRepresentationQuarantineCalls, 1);
    assert.deepEqual(result, videoJsEngine.quarantineRepresentationResult);
});

test("falls back safely when active engine does not expose segmented helpers", () => {
    let currentTime = 0;
    const howlerEngine = {
        load: (_source: AudioEngineSource | string, _options?: AudioEngineLoadOptions) =>
            undefined,
        play: () => undefined,
        pause: () => undefined,
        stop: () => undefined,
        seek: (timeSec: number) => {
            currentTime = timeSec;
        },
        setVolume: (_value: number) => undefined,
        setMuted: (_value: boolean) => undefined,
        getCurrentTime: () => currentTime,
        getDuration: () => 0,
        isPlaying: () => false,
        on: (_event: AudioEngineEventType, _handler: (payload: unknown) => void) =>
            undefined,
        off: (_event: AudioEngineEventType, _handler: (payload: unknown) => void) =>
            undefined,
    } as AudioEngine;
    const runtimeEngine = new HybridRuntimeAudioEngine({
        howlerEngine,
        createVideoJsEngine: () => new FakeAudioEngine(),
        resolveMode: () => "howler",
    });

    howlerEngine.seek(9.75);

    assert.equal(runtimeEngine.quarantineRepresentation("rep-1", 5_000), null);
    runtimeEngine.clearRepresentationQuarantine();
    assert.equal(runtimeEngine.getActualCurrentTime(), 9.75);
    assert.equal(runtimeEngine.isCurrentlySeeking(), false);
    assert.equal(runtimeEngine.getSeekTarget(), null);
});

test("uses safe helper fallbacks when active DASH engine lacks optional helper APIs", () => {
    const howlerEngine = new FakeAudioEngine();
    let activeTimeSec = 0;
    const minimalVideoJsEngine = {
        load: (_source: AudioEngineSource | string, _options?: AudioEngineLoadOptions) =>
            undefined,
        play: () => undefined,
        pause: () => undefined,
        stop: () => undefined,
        seek: (timeSec: number) => {
            activeTimeSec = timeSec;
        },
        setVolume: (_value: number) => undefined,
        setMuted: (_value: boolean) => undefined,
        getCurrentTime: () => activeTimeSec,
        getDuration: () => 0,
        isPlaying: () => false,
        on: (_event: AudioEngineEventType, _handler: (payload: unknown) => void) =>
            undefined,
        off: (_event: AudioEngineEventType, _handler: (payload: unknown) => void) =>
            undefined,
    } as AudioEngine;
    const runtimeEngine = new HybridRuntimeAudioEngine({
        howlerEngine,
        createVideoJsEngine: () => minimalVideoJsEngine,
        resolveMode: () => "videojs",
    });

    runtimeEngine.load({
        url: "https://example.test/live.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });
    runtimeEngine.seek(3.5);

    assert.equal(runtimeEngine.quarantineRepresentation("rep-1", 1_000), null);
    runtimeEngine.clearRepresentationQuarantine();
    assert.equal(runtimeEngine.getActualCurrentTime(), 3.5);
    assert.equal(runtimeEngine.isCurrentlySeeking(), false);
    assert.equal(runtimeEngine.getSeekTarget(), null);
});
