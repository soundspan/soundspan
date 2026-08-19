import { HowlerEngineAdapter } from "@/lib/audio-engine/howlerEngineAdapter";
import { NativeAudioElementEngine } from "@/lib/audio-engine/nativeAudioElementEngine";
import {
    detectAndroidWebView,
    resolveDirectEngineSelection,
} from "@/lib/audio-engine/engineSelectionPolicy";
import { resolveStreamingEngineMode } from "@/lib/audio-engine/engineMode";
import type {
    AudioEngine,
    AudioEngineEventHandler,
    AudioEngineEventType,
    AudioEngineLoadOptions,
    AudioEngineSource,
} from "@/lib/audio-engine/types";
import { DEFAULT_AUDIO_VOLUME, clampAudioVolume } from "@/lib/audio-volume";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

type AnyAudioEventHandler = (payload: unknown) => void;

/** Which concrete engine occupies the direct-playback slot. */
export type DirectEngineDescriptor = "howler" | "native";

/**
 * The engine actually driving playback right now. Distinct from the
 * STREAMING_ENGINE_MODE flag: platform pins (Android WebView → howler)
 * make "configured" diverge from "actual" (GH #42 soak telemetry).
 */
export type RuntimeEngineDescriptor = DirectEngineDescriptor;

const AUDIO_ENGINE_EVENTS: AudioEngineEventType[] = [
    "load",
    "play",
    "pause",
    "stop",
    "end",
    "seek",
    "timeupdate",
    "volume",
    "buffering",
    "loaderror",
    "playerror",
    "error",
];

const resolveSource = (
    source: AudioEngineSource | string,
): AudioEngineSource => {
    if (typeof source === "string") {
        return { url: source };
    }
    return source;
};

interface RuntimeAudioEngine extends AudioEngine {
    load(
        source: AudioEngineSource | string,
        options?: AudioEngineLoadOptions,
    ): void;
    load(
        source: AudioEngineSource | string,
        autoplay?: boolean,
        format?: string,
    ): void;
    preload(
        source: AudioEngineSource | string,
        options?: AudioEngineLoadOptions,
    ): void;
    preload(source: AudioEngineSource | string, format?: string): void;
    reload(): void;
    getActualCurrentTime(): number;
    hasTrackEnded(): boolean;
    isCurrentlySeeking(): boolean;
    getSeekTarget(): number | null;
    getActiveEngineDescriptor(): RuntimeEngineDescriptor;
}

interface HybridRuntimeAudioEngineOptions {
    howlerEngine?: AudioEngine;
    /** What the injected direct-slot engine actually is (default howler). */
    directEngineDescriptor?: DirectEngineDescriptor;
}

/**
 * Runtime engine router: owns the direct-playback slot (HowlerEngineAdapter
 * by default; NativeAudioElementEngine when STREAMING_ENGINE_MODE=native)
 * and forwards its events. The slot engine is fixed at construction.
 */
export class HybridRuntimeAudioEngine implements RuntimeAudioEngine {
    private howlerEngine: AudioEngine;
    private readonly listeners = new Map<
        AudioEngineEventType,
        Set<AnyAudioEventHandler>
    >();
    private readonly howlerForwarders = new Map<
        AudioEngineEventType,
        AnyAudioEventHandler
    >();
    private directEngineDescriptor: DirectEngineDescriptor;
    private lastSource: AudioEngineSource | null = null;
    private lastLoadOptions: AudioEngineLoadOptions | null = null;
    private isDestroyed = false;
    private outputVolume = DEFAULT_AUDIO_VOLUME;
    private outputMuted = false;

    constructor(options: HybridRuntimeAudioEngineOptions = {}) {
        this.howlerEngine = options.howlerEngine ?? new HowlerEngineAdapter();
        this.directEngineDescriptor =
            options.directEngineDescriptor ?? "howler";
        this.bindEngineEvents(this.howlerEngine);
        this.applyOutputState(this.howlerEngine);
    }

    /**
     * Reports the engine actually driving playback right now. Pairs with
     * the STREAMING_ENGINE_MODE flag in telemetry so configured-vs-actual
     * divergence (platform pins) is visible.
     */
    getActiveEngineDescriptor(): RuntimeEngineDescriptor {
        return this.directEngineDescriptor;
    }

    load(
        source: AudioEngineSource | string,
        options?: AudioEngineLoadOptions,
    ): void;
    load(
        source: AudioEngineSource | string,
        autoplay?: boolean,
        format?: string,
    ): void;
    load(
        source: AudioEngineSource | string,
        optionsOrAutoplay: AudioEngineLoadOptions | boolean = {},
        format?: string,
    ): void {
        if (this.isDestroyed) {
            return;
        }
        const normalizedSource = resolveSource(source);
        const normalizedOptions: AudioEngineLoadOptions =
            typeof optionsOrAutoplay === "boolean"
                ? {
                      autoplay: optionsOrAutoplay,
                      format,
                  }
                : optionsOrAutoplay;

        this.lastSource = normalizedSource;
        this.lastLoadOptions = normalizedOptions;

        this.howlerEngine.load(normalizedSource, normalizedOptions);
        this.applyOutputState(this.howlerEngine);
    }

    play(): void | Promise<void> {
        return this.howlerEngine.play();
    }

    pause(): void | Promise<void> {
        return this.howlerEngine.pause();
    }

    stop(): void | Promise<void> {
        return this.howlerEngine.stop();
    }

    seek(timeSec: number): void | Promise<void> {
        return this.howlerEngine.seek(timeSec);
    }

    setVolume(value: number): void {
        this.outputVolume = clampAudioVolume(value);
        this.howlerEngine.setVolume(this.outputVolume);
    }

    setMuted(value: boolean): void {
        this.outputMuted = Boolean(value);
        this.howlerEngine.setMuted(this.outputMuted);
    }

    getCurrentTime(): number {
        return this.howlerEngine.getCurrentTime();
    }

    getDuration(): number {
        return this.howlerEngine.getDuration();
    }

    isPlaying(): boolean {
        return this.howlerEngine.isPlaying();
    }

    on<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>,
    ): void {
        let handlers = this.listeners.get(event);
        if (!handlers) {
            handlers = new Set();
            this.listeners.set(event, handlers);
        }
        handlers.add(handler as unknown as AnyAudioEventHandler);
    }

    off<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>,
    ): void {
        const handlers = this.listeners.get(event);
        if (!handlers) {
            return;
        }
        handlers.delete(handler as unknown as AnyAudioEventHandler);
        if (handlers.size === 0) {
            this.listeners.delete(event);
        }
    }

    preload(
        source: AudioEngineSource | string,
        options?: AudioEngineLoadOptions,
    ): void;
    preload(source: AudioEngineSource | string, format?: string): void;
    preload(
        source: AudioEngineSource | string,
        optionsOrFormat?: AudioEngineLoadOptions | string,
    ): void {
        const normalizedSource = resolveSource(source);
        const normalizedOptions: AudioEngineLoadOptions =
            typeof optionsOrFormat === "string"
                ? { format: optionsOrFormat }
                : (optionsOrFormat ?? {});

        if (typeof this.howlerEngine.preload === "function") {
            this.howlerEngine.preload(normalizedSource, normalizedOptions);
        }
    }

    reload(): void {
        if (typeof this.howlerEngine.reload === "function") {
            this.howlerEngine.reload();
            return;
        }

        if (this.lastSource) {
            this.load(this.lastSource, {
                ...(this.lastLoadOptions ?? {}),
            });
        }
    }

    getActualCurrentTime(): number {
        if (typeof this.howlerEngine.getActualCurrentTime === "function") {
            return this.howlerEngine.getActualCurrentTime();
        }
        return this.howlerEngine.getCurrentTime();
    }

    hasTrackEnded(): boolean {
        if (typeof this.howlerEngine.hasTrackEnded === "function") {
            return this.howlerEngine.hasTrackEnded();
        }
        const duration = this.howlerEngine.getDuration();
        const position = this.howlerEngine.getCurrentTime();
        return duration > 0 && position >= duration - 0.1;
    }

    notifyTrackEnded(): void {
        if (typeof this.howlerEngine.notifyTrackEnded === "function") {
            this.howlerEngine.notifyTrackEnded();
        } else {
            // Engine doesn't implement notifyTrackEnded — emit end directly
            // so foreground recovery can still advance tracks.
            this.emit("end", undefined);
        }
    }

    isCurrentlySeeking(): boolean {
        if (typeof this.howlerEngine.isCurrentlySeeking === "function") {
            return this.howlerEngine.isCurrentlySeeking();
        }
        return false;
    }

    getSeekTarget(): number | null {
        if (typeof this.howlerEngine.getSeekTarget === "function") {
            return this.howlerEngine.getSeekTarget();
        }
        return null;
    }

    destroy(): void {
        this.isDestroyed = true;
        this.unbindEngineEvents(this.howlerEngine);
        if (typeof this.howlerEngine.destroy === "function") {
            this.howlerEngine.destroy();
        }
        this.listeners.clear();
    }

    private bindEngineEvents(engine: AudioEngine): void {
        AUDIO_ENGINE_EVENTS.forEach((event) => {
            const forwarder = ((payload: unknown) => {
                this.emit(event, payload);
            }) as AnyAudioEventHandler;
            this.howlerForwarders.set(event, forwarder);
            engine.on(
                event,
                forwarder as AudioEngineEventHandler<typeof event>,
            );
        });
    }

    private unbindEngineEvents(engine: AudioEngine): void {
        this.howlerForwarders.forEach((forwarder, event) => {
            engine.off(
                event,
                forwarder as AudioEngineEventHandler<typeof event>,
            );
        });
        this.howlerForwarders.clear();
    }

    private emit(event: AudioEngineEventType, payload: unknown): void {
        const handlers = this.listeners.get(event);
        if (!handlers || handlers.size === 0) {
            return;
        }

        handlers.forEach((handler) => {
            handler(payload);
        });
    }

    private applyOutputState(engine: AudioEngine): void {
        engine.setVolume(this.outputVolume);
        engine.setMuted(this.outputMuted);
    }
}

let sharedRuntimeAudioEngine: HybridRuntimeAudioEngine | null = null;

export const createRuntimeAudioEngine = (): RuntimeAudioEngine => {
    if (!sharedRuntimeAudioEngine) {
        // Selection precedence (GH #42 §10): platform pins (Android WebView →
        // howler) override the engine-mode flag, which overrides the default.
        const selection = resolveDirectEngineSelection({
            mode: resolveStreamingEngineMode(),
            isAndroidWebView: detectAndroidWebView(
                typeof navigator !== "undefined" ? navigator.userAgent : "",
            ),
        });

        // Seed the direct slot synchronously so playback is available
        // immediately: the native element engine in native mode, otherwise
        // HowlerEngineAdapter (the constructor default).
        sharedRuntimeAudioEngine = new HybridRuntimeAudioEngine(
            selection.engine === "native"
                ? {
                      howlerEngine: new NativeAudioElementEngine(),
                      directEngineDescriptor: "native",
                  }
                : {},
        );
        if (selection.engine === "native") {
            sharedFrontendLogger.info(
                "[AudioEngine] Native element engine active in the direct slot.",
                { reason: selection.reason },
            );
        }
    }
    return sharedRuntimeAudioEngine;
};

export type { RuntimeAudioEngine };
