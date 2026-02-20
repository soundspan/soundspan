import videojs from "video.js";
import type {
  AudioEngine,
  AudioEngineEventHandler,
  AudioEngineEventPayloadMap,
  AudioEngineEventType,
  AudioEngineLoadOptions,
  AudioEngineSource,
} from "@/lib/audio-engine/types";

type AnyAudioEventHandler = (payload: unknown) => void;

interface VideoJsRequestConfig {
  headers?: Record<string, string>;
  withCredentials?: boolean;
  [key: string]: unknown;
}

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const resolveSource = (source: AudioEngineSource | string): AudioEngineSource => {
  if (typeof source === "string") {
    return { url: source };
  }
  return source;
};

const formatToMimeType = (format?: string): string | undefined => {
  const normalized = format?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "flac":
      return "audio/flac";
    case "mp3":
      return "audio/mpeg";
    case "mp4":
    case "m4a":
    case "aac":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "opus":
      return "audio/ogg; codecs=opus";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    default:
      return undefined;
  }
};

const resolveMimeType = (
  source: AudioEngineSource,
  options?: AudioEngineLoadOptions,
): string | undefined => {
  if (source.mimeType) {
    return source.mimeType;
  }
  if (source.protocol === "dash") {
    return "application/dash+xml";
  }
  return formatToMimeType(options?.format);
};

const toErrorPayload = (error: unknown) => {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: number | string;
      message?: string;
    };
    return {
      error,
      code:
        typeof candidate.code === "string"
          ? candidate.code
          : typeof candidate.code === "number"
            ? String(candidate.code)
            : undefined,
      recoverable: false,
    };
  }
  return {
    error,
    recoverable: false,
  };
};

/**
 * Video.js-backed audio engine optimized for DASH session playback.
 * This implementation is intentionally headless (no controls UI) and emits
 * the shared AudioEngine event contract used by existing player logic.
 */
export class VideoJsSegmentedEngine implements AudioEngine {
  private readonly mediaElement: HTMLVideoElement;
  private readonly player: ReturnType<typeof videojs>;
  private readonly listeners = new Map<
    AudioEngineEventType,
    Set<AnyAudioEventHandler>
  >();
  private readonly teardownCallbacks: Array<() => void> = [];
  private lastSource: AudioEngineSource | null = null;
  private lastLoadOptions: AudioEngineLoadOptions | null = null;
  private isSeeking = false;
  private seekTarget: number | null = null;
  private requestHeaders: Record<string, string> | undefined;
  private requestWithCredentials: boolean | undefined;
  private restoreBeforeRequestHook: (() => void) | null = null;

  constructor() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("VideoJsSegmentedEngine requires a browser environment.");
    }

    this.mediaElement = document.createElement("video");
    this.mediaElement.preload = "auto";
    this.mediaElement.playsInline = true;
    this.mediaElement.controls = false;
    this.mediaElement.style.position = "fixed";
    this.mediaElement.style.width = "1px";
    this.mediaElement.style.height = "1px";
    this.mediaElement.style.opacity = "0";
    this.mediaElement.style.pointerEvents = "none";
    this.mediaElement.style.left = "-9999px";

    document.body.appendChild(this.mediaElement);

    this.player = videojs(this.mediaElement, {
      autoplay: false,
      controls: false,
      preload: "auto",
      muted: false,
      fluid: false,
      html5: {
        vhs: {
          overrideNative: true,
          withCredentials: false,
        },
      },
    });

    this.installBeforeRequestHook();
    this.bindPlayerEvents();
  }

  load(source: AudioEngineSource | string, options?: AudioEngineLoadOptions): void;
  load(source: AudioEngineSource | string, autoplay?: boolean, format?: string): void;
  load(
    source: AudioEngineSource | string,
    optionsOrAutoplay: AudioEngineLoadOptions | boolean = {},
    format?: string,
  ): void {
    const resolvedSource = resolveSource(source);
    if (!resolvedSource.url) {
      throw new Error("VideoJsSegmentedEngine.load requires a non-empty URL.");
    }

    const normalizedOptions: AudioEngineLoadOptions =
      typeof optionsOrAutoplay === "boolean"
        ? {
            autoplay: optionsOrAutoplay,
            format,
          }
        : optionsOrAutoplay;

    this.lastSource = resolvedSource;
    this.lastLoadOptions = normalizedOptions;
    this.requestHeaders = normalizedOptions.requestHeaders;
    this.requestWithCredentials = normalizedOptions.withCredentials;

    const withCredentials = normalizedOptions.withCredentials === true;
    this.mediaElement.crossOrigin = withCredentials ? "use-credentials" : "anonymous";
    this.seekTarget = isFiniteNumber(normalizedOptions.startTimeSec)
      ? Math.max(0, normalizedOptions.startTimeSec)
      : null;

    this.player.src({
      src: resolvedSource.url,
      type: resolveMimeType(resolvedSource, normalizedOptions),
    });

    if (normalizedOptions.autoplay) {
      void this.play();
    }
  }

  async play(): Promise<void> {
    try {
      await this.player.play();
    } catch (error) {
      const payload = toErrorPayload(error);
      this.emit("playerror", payload);
      this.emit("error", payload);
      throw error;
    }
  }

  pause(): void {
    this.player.pause();
  }

  stop(): void {
    this.player.pause();
    if (isFiniteNumber(this.player.currentTime())) {
      this.player.currentTime(0);
    }
    this.emit("stop", undefined);
  }

  seek(timeSec: number): void {
    const nextTime = Math.max(0, timeSec);
    this.seekTarget = nextTime;
    this.player.currentTime(nextTime);
    this.emit("seek", { timeSec: nextTime });
  }

  setVolume(value: number): void {
    const volume = clamp01(value);
    this.player.volume(volume);
    this.emit("volume", {
      volume,
      muted: this.player.muted(),
    });
  }

  setMuted(value: boolean): void {
    this.player.muted(Boolean(value));
    this.emit("volume", {
      volume: this.player.volume(),
      muted: this.player.muted(),
    });
  }

  getCurrentTime(): number {
    const value = this.player.currentTime();
    return isFiniteNumber(value) ? value : 0;
  }

  getDuration(): number {
    const value = this.player.duration();
    return isFiniteNumber(value) ? value : 0;
  }

  isPlaying(): boolean {
    return !this.player.paused() && !this.player.ended();
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
    const resolvedSource = resolveSource(source);
    if (!resolvedSource.url) {
      return;
    }

    const normalizedOptions: AudioEngineLoadOptions =
      typeof optionsOrFormat === "string"
        ? { format: optionsOrFormat }
        : optionsOrFormat ?? {};

    this.load(resolvedSource, {
      ...normalizedOptions,
      autoplay: false,
    });
    this.pause();
  }

  reload(): void {
    if (!this.lastSource) {
      return;
    }

    const wasPlaying = this.isPlaying();
    const currentTime = this.getCurrentTime();
    this.load(this.lastSource, {
      ...(this.lastLoadOptions ?? {}),
      autoplay: wasPlaying,
      startTimeSec: currentTime,
    });
  }

  getActualCurrentTime(): number {
    return this.getCurrentTime();
  }

  isCurrentlySeeking(): boolean {
    return this.isSeeking;
  }

  getSeekTarget(): number | null {
    return this.seekTarget;
  }

  destroy(): void {
    if (this.restoreBeforeRequestHook) {
      this.restoreBeforeRequestHook();
      this.restoreBeforeRequestHook = null;
    }

    while (this.teardownCallbacks.length > 0) {
      const teardown = this.teardownCallbacks.pop();
      if (teardown) {
        teardown();
      }
    }
    this.listeners.clear();
    this.player.dispose();
    if (this.mediaElement.parentElement) {
      this.mediaElement.parentElement.removeChild(this.mediaElement);
    }
  }

  private installBeforeRequestHook(): void {
    const videoJsAny = videojs as unknown as {
      Vhs?: {
        xhr?: {
          beforeRequest?: (config: VideoJsRequestConfig) => VideoJsRequestConfig;
        };
      };
    };
    const vhsXhr = videoJsAny.Vhs?.xhr;
    if (!vhsXhr) {
      return;
    }

    const previousHook = vhsXhr.beforeRequest;
    vhsXhr.beforeRequest = (config: VideoJsRequestConfig): VideoJsRequestConfig => {
      const baseConfig =
        typeof previousHook === "function"
          ? previousHook(config) ?? config
          : config;
      const nextConfig: VideoJsRequestConfig = {
        ...baseConfig,
      };

      if (this.requestHeaders && Object.keys(this.requestHeaders).length > 0) {
        const existingHeaders =
          nextConfig.headers && typeof nextConfig.headers === "object"
            ? nextConfig.headers
            : {};
        nextConfig.headers = {
          ...existingHeaders,
          ...this.requestHeaders,
        };
      }

      if (typeof this.requestWithCredentials === "boolean") {
        nextConfig.withCredentials = this.requestWithCredentials;
      }

      return nextConfig;
    };

    this.restoreBeforeRequestHook = () => {
      vhsXhr.beforeRequest = previousHook;
    };
  }

  private bindPlayerEvents(): void {
    this.bindPlayerEvent("loadedmetadata", () => {
      const pendingSeek = this.seekTarget;
      if (pendingSeek !== null) {
        this.player.currentTime(pendingSeek);
      }
      this.emit("load", {
        durationSec: this.getDuration(),
      });
      this.emit("buffering", {
        isBuffering: false,
      });
    });

    this.bindPlayerEvent("timeupdate", () => {
      const timeSec = this.getCurrentTime();
      if (this.seekTarget !== null && Math.abs(timeSec - this.seekTarget) < 0.25) {
        this.seekTarget = null;
      }
      this.emit("timeupdate", { timeSec });
    });

    this.bindPlayerEvent("play", () => {
      this.emit("play", undefined);
      this.emit("buffering", {
        isBuffering: false,
      });
    });

    this.bindPlayerEvent("pause", () => {
      this.emit("pause", undefined);
    });

    this.bindPlayerEvent("ended", () => {
      this.emit("end", undefined);
    });

    this.bindPlayerEvent("seeking", () => {
      this.isSeeking = true;
      this.emit("buffering", {
        isBuffering: true,
        reason: "seeking",
      });
    });

    this.bindPlayerEvent("seeked", () => {
      this.isSeeking = false;
      this.emit("seek", { timeSec: this.getCurrentTime() });
      this.emit("buffering", {
        isBuffering: false,
      });
    });

    this.bindPlayerEvent("waiting", () => {
      this.emit("buffering", {
        isBuffering: true,
        reason: "waiting",
      });
    });

    this.bindPlayerEvent("stalled", () => {
      this.emit("buffering", {
        isBuffering: true,
        reason: "stalled",
      });
    });

    this.bindPlayerEvent("error", () => {
      const payload = toErrorPayload(this.player.error());
      this.emit("loaderror", payload);
      this.emit("error", payload);
    });
  }

  private bindPlayerEvent(
    event: string,
    callback: () => void,
  ): void {
    this.player.on(event, callback);
    this.teardownCallbacks.push(() => {
      this.player.off(event, callback);
    });
  }

  private emit<T extends AudioEngineEventType>(
    event: T,
    payload: AudioEngineEventPayloadMap[T],
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers || handlers.size === 0) {
      return;
    }

    handlers.forEach((handler) => {
      handler(payload);
    });
  }
}
