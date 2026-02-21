import {
  HowlerEngineAdapter,
  resolveStreamingEngineMode,
} from "@/lib/audio-engine/howlerEngineAdapter";
import type {
  AudioEngine,
  AudioEngineEventHandler,
  AudioEngineEventType,
  AudioEngineLoadOptions,
  AudioEngineSource,
} from "@/lib/audio-engine/types";
import { VideoJsSegmentedEngine } from "@/lib/audio-engine/videoJsSegmentedEngine";

type EngineKind = "howler" | "videojs";
type AnyAudioEventHandler = (payload: unknown) => void;

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

const isDashProtocol = (source: AudioEngineSource): boolean => {
  if (source.protocol === "dash") {
    return true;
  }

  const mimeType = source.mimeType?.trim().toLowerCase();
  if (mimeType === "application/dash+xml") {
    return true;
  }

  const normalizedUrl = source.url.trim().toLowerCase();
  return normalizedUrl.endsWith(".mpd") || normalizedUrl.includes(".mpd?");
};

const resolveSource = (source: AudioEngineSource | string): AudioEngineSource => {
  if (typeof source === "string") {
    return { url: source };
  }
  return source;
};

interface RuntimeAudioEngine extends AudioEngine {
  load(source: AudioEngineSource | string, options?: AudioEngineLoadOptions): void;
  load(source: AudioEngineSource | string, autoplay?: boolean, format?: string): void;
  preload(source: AudioEngineSource | string, options?: AudioEngineLoadOptions): void;
  preload(source: AudioEngineSource | string, format?: string): void;
  reload(): void;
  getActualCurrentTime(): number;
  isCurrentlySeeking(): boolean;
  getSeekTarget(): number | null;
}

/**
 * Hybrid runtime engine:
 * - Uses Howler for direct byte streams (legacy-safe path)
 * - Uses Video.js for DASH manifests when segmented mode is active
 */
class HybridRuntimeAudioEngine implements RuntimeAudioEngine {
  private readonly howlerEngine = new HowlerEngineAdapter();
  private videoJsEngine: VideoJsSegmentedEngine | null = null;
  private readonly listeners = new Map<
    AudioEngineEventType,
    Set<AnyAudioEventHandler>
  >();
  private readonly howlerForwarders = new Map<AudioEngineEventType, AnyAudioEventHandler>();
  private readonly videoJsForwarders = new Map<AudioEngineEventType, AnyAudioEventHandler>();
  private activeEngineKind: EngineKind = "howler";
  private lastSource: AudioEngineSource | null = null;
  private lastLoadOptions: AudioEngineLoadOptions | null = null;

  constructor() {
    this.bindEngineEvents("howler", this.howlerEngine);
  }

  load(source: AudioEngineSource | string, options?: AudioEngineLoadOptions): void;
  load(source: AudioEngineSource | string, autoplay?: boolean, format?: string): void;
  load(
    source: AudioEngineSource | string,
    optionsOrAutoplay: AudioEngineLoadOptions | boolean = {},
    format?: string,
  ): void {
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

    const preferredKind = this.resolvePreferredEngineKind(normalizedSource);
    const targetEngine = this.getEngineByKind(preferredKind);
    const targetKind: EngineKind =
      targetEngine instanceof VideoJsSegmentedEngine ? "videojs" : "howler";

    if (this.activeEngineKind !== targetKind) {
      this.getActiveEngine().stop();
      this.activeEngineKind = targetKind;
    }

    targetEngine.load(normalizedSource, normalizedOptions);
  }

  play(): void | Promise<void> {
    return this.getActiveEngine().play();
  }

  pause(): void | Promise<void> {
    return this.getActiveEngine().pause();
  }

  stop(): void | Promise<void> {
    return this.getActiveEngine().stop();
  }

  seek(timeSec: number): void | Promise<void> {
    return this.getActiveEngine().seek(timeSec);
  }

  setVolume(value: number): void {
    this.getActiveEngine().setVolume(value);
  }

  setMuted(value: boolean): void {
    this.getActiveEngine().setMuted(value);
  }

  getCurrentTime(): number {
    return this.getActiveEngine().getCurrentTime();
  }

  getDuration(): number {
    return this.getActiveEngine().getDuration();
  }

  isPlaying(): boolean {
    return this.getActiveEngine().isPlaying();
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

  preload(source: AudioEngineSource | string, options?: AudioEngineLoadOptions): void;
  preload(source: AudioEngineSource | string, format?: string): void;
  preload(
    source: AudioEngineSource | string,
    optionsOrFormat?: AudioEngineLoadOptions | string,
  ): void {
    const normalizedSource = resolveSource(source);
    const normalizedOptions: AudioEngineLoadOptions =
      typeof optionsOrFormat === "string"
        ? { format: optionsOrFormat }
        : optionsOrFormat ?? {};

    const preferredKind = this.resolvePreferredEngineKind(normalizedSource);
    const targetEngine = this.getEngineByKind(preferredKind);
    if (typeof targetEngine.preload === "function") {
      targetEngine.preload(normalizedSource, normalizedOptions);
    }
  }

  reload(): void {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.reload === "function") {
      activeEngine.reload();
      return;
    }

    if (this.lastSource) {
      this.load(this.lastSource, {
        ...(this.lastLoadOptions ?? {}),
      });
    }
  }

  getActualCurrentTime(): number {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.getActualCurrentTime === "function") {
      return activeEngine.getActualCurrentTime();
    }
    return activeEngine.getCurrentTime();
  }

  isCurrentlySeeking(): boolean {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.isCurrentlySeeking === "function") {
      return activeEngine.isCurrentlySeeking();
    }
    return false;
  }

  getSeekTarget(): number | null {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.getSeekTarget === "function") {
      return activeEngine.getSeekTarget();
    }
    return null;
  }

  destroy(): void {
    this.unbindEngineEvents("howler", this.howlerEngine);
    if (this.videoJsEngine) {
      this.unbindEngineEvents("videojs", this.videoJsEngine);
      this.videoJsEngine.destroy();
      this.videoJsEngine = null;
    }
    this.howlerEngine.destroy();
    this.listeners.clear();
  }

  private getActiveEngine(): AudioEngine {
    return this.activeEngineKind === "videojs"
      ? this.getEngineByKind("videojs")
      : this.howlerEngine;
  }

  private resolvePreferredEngineKind(source: AudioEngineSource): EngineKind {
    const mode = resolveStreamingEngineMode();
    if (mode === "howler-rollback") {
      return "howler";
    }

    if (mode === "videojs") {
      return isDashProtocol(source) ? "videojs" : "howler";
    }

    return "howler";
  }

  private getEngineByKind(kind: EngineKind): AudioEngine {
    if (kind === "howler") {
      return this.howlerEngine;
    }

    if (!this.videoJsEngine) {
      try {
        this.videoJsEngine = new VideoJsSegmentedEngine();
        this.bindEngineEvents("videojs", this.videoJsEngine);
      } catch (error) {
        console.error(
          "[AudioEngine] Failed to initialize Video.js segmented engine, falling back to Howler.",
          error,
        );
        return this.howlerEngine;
      }
    }

    return this.videoJsEngine;
  }

  private bindEngineEvents(kind: EngineKind, engine: AudioEngine): void {
    AUDIO_ENGINE_EVENTS.forEach((event) => {
      const forwarder = ((payload: unknown) => {
        if (this.activeEngineKind !== kind) {
          return;
        }
        this.emit(event, payload);
      }) as AnyAudioEventHandler;

      if (kind === "howler") {
        this.howlerForwarders.set(event, forwarder);
      } else {
        this.videoJsForwarders.set(event, forwarder);
      }

      engine.on(event, forwarder as AudioEngineEventHandler<typeof event>);
    });
  }

  private unbindEngineEvents(kind: EngineKind, engine: AudioEngine): void {
    const forwarders = kind === "howler" ? this.howlerForwarders : this.videoJsForwarders;
    forwarders.forEach((forwarder, event) => {
      engine.off(event, forwarder as AudioEngineEventHandler<typeof event>);
    });
    forwarders.clear();
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
}

let sharedRuntimeAudioEngine: HybridRuntimeAudioEngine | null = null;

export const createRuntimeAudioEngine = (): RuntimeAudioEngine => {
  if (!sharedRuntimeAudioEngine) {
    sharedRuntimeAudioEngine = new HybridRuntimeAudioEngine();
  }
  return sharedRuntimeAudioEngine;
};

export type { RuntimeAudioEngine };
