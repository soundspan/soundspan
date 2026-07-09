import {
  HowlerEngineAdapter,
} from "@/lib/audio-engine/howlerEngineAdapter";
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
  AudioEngineRepresentationFailoverResult,
  AudioEngineSource,
} from "@/lib/audio-engine/types";
import { createAudioEngine } from "@/lib/audio-engine/engineFactory";
import {
  DEFAULT_AUDIO_VOLUME,
  clampAudioVolume,
} from "@/lib/audio-volume";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

type EngineKind = "howler" | "videojs";
type AnyAudioEventHandler = (payload: unknown) => void;

/** Which concrete engine occupies the direct-playback slot. */
export type DirectEngineDescriptor = "howler" | "native" | "tauri-native";

/**
 * The engine actually driving playback right now. Distinct from the
 * STREAMING_ENGINE_MODE flag: platform pins, the Tauri upgrade, and
 * per-source videojs routing all make "configured" diverge from
 * "actual" (GH #42 soak telemetry).
 */
export type RuntimeEngineDescriptor = DirectEngineDescriptor | "videojs";

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
  "vhsresponse",
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

// Lazy-load the Video.js segmented engine (and the ~500KB video.js
// dependency) only when a DASH/segmented source is actually selected,
// keeping video.js out of every page's initial bundle.
const loadVideoJsSegmentedEngine = async (): Promise<AudioEngine> => {
  const { VideoJsSegmentedEngine } = await import(
    "@/lib/audio-engine/videoJsSegmentedEngine"
  );
  return new VideoJsSegmentedEngine();
};

interface RuntimeAudioEngine extends AudioEngine {
  load(source: AudioEngineSource | string, options?: AudioEngineLoadOptions): void;
  load(source: AudioEngineSource | string, autoplay?: boolean, format?: string): void;
  preload(source: AudioEngineSource | string, options?: AudioEngineLoadOptions): void;
  preload(source: AudioEngineSource | string, format?: string): void;
  reload(): void;
  refreshManifest(): void;
  quarantineRepresentation(
    representationId: string,
    cooldownMs: number,
  ): AudioEngineRepresentationFailoverResult | null;
  clearRepresentationQuarantine(): void;
  getActualCurrentTime(): number;
  hasTrackEnded(): boolean;
  isCurrentlySeeking(): boolean;
  getSeekTarget(): number | null;
  getActiveEngineDescriptor(): RuntimeEngineDescriptor;
}

interface HybridRuntimeAudioEngineOptions {
  howlerEngine?: AudioEngine;
  createVideoJsEngine?: () => AudioEngine | Promise<AudioEngine>;
  resolveMode?: () => ReturnType<typeof resolveStreamingEngineMode>;
  /** What the injected direct-slot engine actually is (default howler). */
  directEngineDescriptor?: DirectEngineDescriptor;
}

/**
 * Hybrid runtime engine:
 * - Uses the direct slot for byte streams (HowlerEngineAdapter by
 *   default; NativeAudioElementEngine when STREAMING_ENGINE_MODE=native;
 *   TauriNativeEngineAdapter after a platform upgrade)
 * - Uses Video.js for DASH manifests when segmented mode is active
 */
export class HybridRuntimeAudioEngine implements RuntimeAudioEngine {
  private howlerEngine: AudioEngine;
  private videoJsEngine: AudioEngine | null = null;
  private videoJsEnginePromise: Promise<AudioEngine | null> | null = null;
  private readonly createVideoJsEngine: () => AudioEngine | Promise<AudioEngine>;
  private readonly resolveMode: () => ReturnType<typeof resolveStreamingEngineMode>;
  private readonly listeners = new Map<
    AudioEngineEventType,
    Set<AnyAudioEventHandler>
  >();
  private readonly howlerForwarders = new Map<AudioEngineEventType, AnyAudioEventHandler>();
  private readonly videoJsForwarders = new Map<AudioEngineEventType, AnyAudioEventHandler>();
  private activeEngineKind: EngineKind = "howler";
  private directEngineDescriptor: DirectEngineDescriptor;
  private lastSource: AudioEngineSource | null = null;
  private lastLoadOptions: AudioEngineLoadOptions | null = null;
  private loadSequence = 0;
  // Tracks the load that is waiting on the lazy video.js chunk so
  // play()/pause() during the download can redirect intent to it instead
  // of acting on the stale active engine. Non-null only while the most
  // recent load() is deferred; autoplayOverride wins over the original
  // load options when set.
  private pendingLazyLoad: {
    sequence: number;
    autoplayOverride: boolean | null;
  } | null = null;
  private isDestroyed = false;
  private outputVolume = DEFAULT_AUDIO_VOLUME;
  private outputMuted = false;

  constructor(options: HybridRuntimeAudioEngineOptions = {}) {
    this.howlerEngine = options.howlerEngine ?? new HowlerEngineAdapter();
    this.directEngineDescriptor = options.directEngineDescriptor ?? "howler";
    this.createVideoJsEngine =
      options.createVideoJsEngine ?? loadVideoJsSegmentedEngine;
    this.resolveMode = options.resolveMode ?? resolveStreamingEngineMode;
    this.bindEngineEvents("howler", this.howlerEngine);
    this.applyOutputState(this.howlerEngine);
  }

  /**
   * Hot-swap the direct-playback engine (the "howler" slot) with a
   * platform-specific engine such as TauriNativeEngineAdapter.
   *
   * Safe to call while idle or during playback — volume/mute state is
   * re-applied and event forwarding is re-wired automatically.
   * Only takes effect when the howler slot is the active engine.
   */
  upgradeHowlerEngine(
    engine: AudioEngine,
    descriptor: DirectEngineDescriptor = "howler",
  ): void {
    if (engine === this.howlerEngine) {
      return;
    }

    this.unbindEngineEvents("howler", this.howlerEngine);

    if (typeof this.howlerEngine.destroy === "function") {
      this.howlerEngine.destroy();
    }

    this.howlerEngine = engine;
    this.directEngineDescriptor = descriptor;
    this.bindEngineEvents("howler", this.howlerEngine);
    this.applyOutputState(this.howlerEngine);
  }

  /**
   * Reports the engine actually driving playback right now — the
   * direct-slot descriptor, or "videojs" while the segmented engine is
   * active. Pairs with the STREAMING_ENGINE_MODE flag in telemetry so
   * configured-vs-actual divergence (platform pins, Tauri upgrades,
   * per-source routing) is visible.
   */
  getActiveEngineDescriptor(): RuntimeEngineDescriptor {
    return this.activeEngineKind === "videojs"
      ? "videojs"
      : this.directEngineDescriptor;
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
    const sequence = ++this.loadSequence;
    this.pendingLazyLoad = null;

    const preferredKind = this.resolvePreferredEngineKind(normalizedSource);
    if (preferredKind === "videojs" && !this.videoJsEngine) {
      // Halt in-progress playback immediately (mirroring the synchronous
      // engine-switch path in loadWithEngine) so the previous track does
      // not keep playing while the video.js chunk downloads.
      const activeEngine = this.getActiveEngine();
      if (activeEngine.isPlaying()) {
        activeEngine.stop();
      }
      // Video.js engine is lazy-loaded; finish this load once it arrives
      // unless a newer load superseded it in the meantime. play()/pause()
      // in the interim adjust autoplay via pendingLazyLoad rather than
      // cancelling the load (see those methods).
      const pendingLazyLoad: NonNullable<typeof this.pendingLazyLoad> = {
        sequence,
        autoplayOverride: null,
      };
      this.pendingLazyLoad = pendingLazyLoad;
      void this.ensureVideoJsEngine().then((videoJsEngine) => {
        if (this.pendingLazyLoad === pendingLazyLoad) {
          this.pendingLazyLoad = null;
        }
        if (sequence !== this.loadSequence || this.isDestroyed) {
          return;
        }
        const effectiveOptions =
          pendingLazyLoad.autoplayOverride === null
            ? normalizedOptions
            : {
                ...normalizedOptions,
                autoplay: pendingLazyLoad.autoplayOverride,
              };
        this.loadWithEngine(
          videoJsEngine ? "videojs" : "howler",
          videoJsEngine ?? this.howlerEngine,
          normalizedSource,
          effectiveOptions,
        );
      });
      return;
    }

    const targetEngine = this.getEngineByKind(preferredKind);
    const targetKind: EngineKind =
      targetEngine === this.howlerEngine ? "howler" : "videojs";
    this.loadWithEngine(
      targetKind,
      targetEngine,
      normalizedSource,
      normalizedOptions,
    );
  }

  private loadWithEngine(
    targetKind: EngineKind,
    targetEngine: AudioEngine,
    source: AudioEngineSource,
    options: AudioEngineLoadOptions,
  ): void {
    if (this.activeEngineKind !== targetKind) {
      this.getActiveEngine().stop();
      this.activeEngineKind = targetKind;
      this.applyOutputState(targetEngine);
    }

    targetEngine.load(source, options);
    this.applyOutputState(targetEngine);
  }

  play(): void | Promise<void> {
    const pendingLazyLoad = this.pendingLazyLoad;
    if (pendingLazyLoad && pendingLazyLoad.sequence === this.loadSequence) {
      // The queued track is still waiting on the lazy video.js chunk and
      // the active engine only holds the previous (already halted)
      // source; restarting it would play the wrong track from position 0.
      // Record the play intent so the deferred load starts playback as
      // soon as the engine arrives.
      pendingLazyLoad.autoplayOverride = true;
      return;
    }
    return this.getActiveEngine().play();
  }

  pause(): void | Promise<void> {
    const pendingLazyLoad = this.pendingLazyLoad;
    if (pendingLazyLoad && pendingLazyLoad.sequence === this.loadSequence) {
      // Keep the deferred lazy-engine load (see load()) so the queued
      // track still becomes ready (and the orchestrator's load listeners
      // fire), but suppress autoplay so playback cannot start against the
      // user's intent once the chunk arrives.
      pendingLazyLoad.autoplayOverride = false;
    }
    return this.getActiveEngine().pause();
  }

  stop(): void | Promise<void> {
    // Invalidate any deferred lazy-engine load (see load()) so it cannot
    // start playback after the transport was stopped. No cancellation
    // event is needed: every stop() caller either re-issues load() or
    // clears its own load bookkeeping synchronously.
    this.loadSequence += 1;
    this.pendingLazyLoad = null;
    return this.getActiveEngine().stop();
  }

  seek(timeSec: number): void | Promise<void> {
    return this.getActiveEngine().seek(timeSec);
  }

  setVolume(value: number): void {
    this.outputVolume = clampAudioVolume(value);
    this.getActiveEngine().setVolume(this.outputVolume);
  }

  setMuted(value: boolean): void {
    this.outputMuted = Boolean(value);
    this.getActiveEngine().setMuted(this.outputMuted);
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
    if (preferredKind === "videojs" && !this.videoJsEngine) {
      void this.ensureVideoJsEngine().then((videoJsEngine) => {
        if (
          !videoJsEngine ||
          this.isDestroyed ||
          typeof videoJsEngine.preload !== "function"
        ) {
          return;
        }
        videoJsEngine.preload(normalizedSource, normalizedOptions);
      });
      return;
    }

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

  refreshManifest(): void {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.refreshManifest === "function") {
      activeEngine.refreshManifest();
      return;
    }

    if (this.lastSource && isDashProtocol(this.lastSource)) {
      this.reload();
    }
  }

  quarantineRepresentation(
    representationId: string,
    cooldownMs: number,
  ): AudioEngineRepresentationFailoverResult | null {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.quarantineRepresentation !== "function") {
      return null;
    }
    return activeEngine.quarantineRepresentation(representationId, cooldownMs);
  }

  clearRepresentationQuarantine(): void {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.clearRepresentationQuarantine !== "function") {
      return;
    }
    activeEngine.clearRepresentationQuarantine();
  }

  getActualCurrentTime(): number {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.getActualCurrentTime === "function") {
      return activeEngine.getActualCurrentTime();
    }
    return activeEngine.getCurrentTime();
  }

  hasTrackEnded(): boolean {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.hasTrackEnded === "function") {
      return activeEngine.hasTrackEnded();
    }
    const duration = activeEngine.getDuration();
    const position = activeEngine.getCurrentTime();
    return duration > 0 && position >= duration - 0.1;
  }

  notifyTrackEnded(): void {
    const activeEngine = this.getActiveEngine();
    if (typeof activeEngine.notifyTrackEnded === "function") {
      activeEngine.notifyTrackEnded();
    } else {
      // Engine doesn't implement notifyTrackEnded — emit end directly
      // so foreground recovery can still advance tracks.
      this.emit("end", undefined);
    }
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
    this.isDestroyed = true;
    this.loadSequence += 1;
    this.pendingLazyLoad = null;
    this.videoJsEnginePromise = null;
    this.unbindEngineEvents("howler", this.howlerEngine);
    if (this.videoJsEngine) {
      this.unbindEngineEvents("videojs", this.videoJsEngine);
      if (typeof this.videoJsEngine.destroy === "function") {
        this.videoJsEngine.destroy();
      }
      this.videoJsEngine = null;
    }
    if (typeof this.howlerEngine.destroy === "function") {
      this.howlerEngine.destroy();
    }
    this.listeners.clear();
  }

  private getActiveEngine(): AudioEngine {
    return this.activeEngineKind === "videojs"
      ? this.getEngineByKind("videojs")
      : this.howlerEngine;
  }

  private resolvePreferredEngineKind(source: AudioEngineSource): EngineKind {
    const mode = this.resolveMode();
    if (mode === "howler") {
      return "howler";
    }

    if (mode === "videojs") {
      return isDashProtocol(source) ? "videojs" : "howler";
    }

    // "native" (and any future direct mode) routes through the direct
    // slot; createRuntimeAudioEngine seeds that slot with the selected
    // engine (NativeAudioElementEngine when STREAMING_ENGINE_MODE=native).
    return "howler";
  }

  private getEngineByKind(kind: EngineKind): AudioEngine {
    if (kind === "howler") {
      return this.howlerEngine;
    }

    return this.videoJsEngine ?? this.howlerEngine;
  }

  private ensureVideoJsEngine(): Promise<AudioEngine | null> {
    if (this.videoJsEngine) {
      return Promise.resolve(this.videoJsEngine);
    }

    if (!this.videoJsEnginePromise) {
      this.videoJsEnginePromise = Promise.resolve()
        .then(() => this.createVideoJsEngine())
        .then((engine) => {
          if (this.isDestroyed) {
            if (typeof engine.destroy === "function") {
              engine.destroy();
            }
            return null;
          }
          this.videoJsEngine = engine;
          this.bindEngineEvents("videojs", engine);
          this.applyOutputState(engine);
          return engine;
        })
        .catch((error) => {
          sharedFrontendLogger.error(
            "[AudioEngine] Failed to initialize Video.js segmented engine; continuing with primary Howler engine.",
            error,
          );
          this.videoJsEnginePromise = null;
          return null;
        });
    }

    return this.videoJsEnginePromise;
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

  private applyOutputState(engine: AudioEngine): void {
    engine.setVolume(this.outputVolume);
    engine.setMuted(this.outputMuted);
  }
}

let sharedRuntimeAudioEngine: HybridRuntimeAudioEngine | null = null;
let engineUpgradeInitiated = false;

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

    // Kick off async platform detection; if a Tauri native engine is
    // needed, replace the inner direct engine transparently. This path
    // must not fire when the native element mode is active (GH #42 §10).
    if (!engineUpgradeInitiated && selection.allowTauriUpgrade) {
      engineUpgradeInitiated = true;
      createAudioEngine()
        .then((engine) => {
          if (!(engine instanceof HowlerEngineAdapter) && sharedRuntimeAudioEngine) {
            sharedRuntimeAudioEngine.upgradeHowlerEngine(engine, "tauri-native");
          }
        })
        .catch((err) => {
          sharedFrontendLogger.error(
            "[AudioEngine] Platform engine detection failed; continuing with Howler engine.",
            err,
          );
        });
    }
  }
  return sharedRuntimeAudioEngine;
};

export type { RuntimeAudioEngine };
