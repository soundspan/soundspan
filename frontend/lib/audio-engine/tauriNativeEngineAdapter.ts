import type {
  AudioEngine,
  AudioEngineBufferingPayload,
  AudioEngineErrorPayload,
  AudioEngineEventHandler,
  AudioEngineEventType,
  AudioEngineLoadOptions,
  AudioEngineLoadPayload,
  AudioEngineSource,
  AudioEngineTimeUpdatePayload,
} from "@/lib/audio-engine/types";

// ---------------------------------------------------------------------------
// Tauri API lazy loaders — dynamic import keeps non-Tauri builds working
// ---------------------------------------------------------------------------

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

const getTauriInvoke = async (): Promise<InvokeFn> => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
};

const getTauriEvents = async (): Promise<ListenFn> => {
  const { listen } = await import("@tauri-apps/api/event");
  return listen;
};

// ---------------------------------------------------------------------------
// Format resolution helpers (mirrored from howlerEngineAdapter)
// ---------------------------------------------------------------------------

const MIME_TYPE_FORMAT_MAP: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-flac": "flac",
  "audio/x-wav": "wav",
  "application/ogg": "ogg",
};

const FILE_EXTENSION_FORMAT_MAP: Record<string, string> = {
  aac: "aac",
  flac: "flac",
  m4a: "mp4",
  mp3: "mp3",
  mp4: "mp4",
  ogg: "ogg",
  opus: "opus",
  wav: "wav",
  webm: "webm",
};

const inferFormatFromUrl = (url: string): string | undefined => {
  const withoutQuery = url.split(/[?#]/, 1)[0];
  const dotIndex = withoutQuery.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === withoutQuery.length - 1) {
    return undefined;
  }
  const extension = withoutQuery.slice(dotIndex + 1).toLowerCase();
  return FILE_EXTENSION_FORMAT_MAP[extension];
};

const resolveSource = (
  source: AudioEngineSource | string,
): AudioEngineSource => {
  if (typeof source === "string") {
    return { url: source };
  }
  return source;
};

const resolveFormat = (
  source: AudioEngineSource,
  options?: AudioEngineLoadOptions,
): string | undefined => {
  const explicitFormat = options?.format?.trim().toLowerCase();
  if (explicitFormat) {
    return explicitFormat;
  }
  const mimeType = source.mimeType?.trim().toLowerCase();
  if (mimeType && MIME_TYPE_FORMAT_MAP[mimeType]) {
    return MIME_TYPE_FORMAT_MAP[mimeType];
  }
  return inferFormatFromUrl(source.url);
};

// ---------------------------------------------------------------------------
// Tauri backend event / state payloads
// ---------------------------------------------------------------------------

interface NativeAudioTimeUpdate {
  position_secs: number;
  duration_secs: number;
}

interface NativeAudioLoaded {
  duration_secs: number;
}

interface NativeAudioError {
  message: string;
  code?: string;
  recoverable?: boolean;
  phase?: "load" | "play";
}

interface NativeAudioState {
  status: "playing" | "paused" | "stopped" | "idle";
  position_secs: number;
  duration_secs: number;
  volume: number;
}

interface NativeAudioBuffering {
  is_buffering: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Seek constants (same semantics as HowlerEngine)
// ---------------------------------------------------------------------------

const SEEK_LOCK_TIMEOUT_MS = 300;
const SEEK_STALE_WINDOW_MS = 2_000;

// ---------------------------------------------------------------------------
// Handler type alias
// ---------------------------------------------------------------------------

type AnyHandler = (payload: unknown) => void;

// ---------------------------------------------------------------------------
// TauriNativeEngineAdapter
// ---------------------------------------------------------------------------

/**
 * AudioEngine adapter that routes audio through Tauri IPC commands to a
 * native Rust backend. Designed for platforms where the Chromium webview
 * audio stack is insufficient (Windows, Android).
 */
export class TauriNativeEngineAdapter implements AudioEngine {
  // State -------------------------------------------------------------------
  private currentPosition = 0;
  private currentDuration = 0;
  private playing = false;
  private seeking = false;
  private seekTarget: number | null = null;
  private seekTimestamp = 0;
  private lastVolume = 1;
  private muted = false;
  private trackEnded = false;
  private destroyed = false;

  // Listeners ---------------------------------------------------------------
  private listeners = new Map<AudioEngineEventType, Set<AnyHandler>>();
  private unlistenFns: Array<() => void> = [];
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.registerTauriListeners();
  }

  // -- AudioEngine: load ----------------------------------------------------

  async load(
    source: AudioEngineSource | string,
    options?: AudioEngineLoadOptions,
  ): Promise<void> {
    await this.initPromise;
    const resolved = resolveSource(source);
    if (!resolved.url) {
      throw new Error(
        "TauriNativeEngineAdapter.load requires a non-empty source URL.",
      );
    }

    const format = resolveFormat(resolved, options);
    const invoke = await getTauriInvoke();

    this.trackEnded = false;
    this.currentPosition = 0;
    this.currentDuration = 0;

    await invoke("native_audio_play", {
      url: resolved.url,
      format,
      headers: options?.requestHeaders,
      autoplay: options?.autoplay ?? false,
    });

    if (options?.autoplay) {
      this.playing = true;
    }

    if (options?.startTimeSec && options.startTimeSec > 0) {
      await this.seek(options.startTimeSec);
    }
  }

  // -- AudioEngine: transport controls --------------------------------------

  async play(): Promise<void> {
    const invoke = await getTauriInvoke();
    await invoke("native_audio_resume");
    this.playing = true;
  }

  async pause(): Promise<void> {
    const invoke = await getTauriInvoke();
    await invoke("native_audio_pause");
    this.playing = false;
  }

  async stop(): Promise<void> {
    const invoke = await getTauriInvoke();
    await invoke("native_audio_stop");
    this.playing = false;
    this.currentPosition = 0;
  }

  async seek(timeSec: number): Promise<void> {
    this.seeking = true;
    this.seekTarget = timeSec;
    this.seekTimestamp = Date.now();

    const invoke = await getTauriInvoke();
    await invoke("native_audio_seek", { position_secs: timeSec });

    // Release seek lock after timeout
    setTimeout(() => {
      if (this.seekTarget === timeSec) {
        this.seeking = false;
        this.seekTarget = null;
      }
    }, SEEK_LOCK_TIMEOUT_MS);
  }

  // -- AudioEngine: volume --------------------------------------------------

  setVolume(value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    this.lastVolume = clamped;

    if (!this.muted) {
      getTauriInvoke()
        .then((invoke) => invoke("native_audio_set_volume", { level: clamped }))
        .catch(() => {});
    }
  }

  setMuted(value: boolean): void {
    this.muted = value;
    const level = value ? 0 : this.lastVolume;

    getTauriInvoke()
      .then((invoke) => invoke("native_audio_set_volume", { level }))
      .catch(() => {});
  }

  // -- AudioEngine: getters -------------------------------------------------

  getCurrentTime(): number {
    return this.currentPosition;
  }

  getDuration(): number {
    return this.currentDuration;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  // -- AudioEngine: event management ----------------------------------------

  on<T extends AudioEngineEventType>(
    event: T,
    handler: AudioEngineEventHandler<T>,
  ): void {
    const h = handler as unknown as AnyHandler;
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(h);
  }

  off<T extends AudioEngineEventType>(
    event: T,
    handler: AudioEngineEventHandler<T>,
  ): void {
    const h = handler as unknown as AnyHandler;
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(h);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  // -- AudioEngine: optional members ----------------------------------------

  async preload(
    source: AudioEngineSource | string,
    options?: AudioEngineLoadOptions,
  ): Promise<void> {
    const resolved = resolveSource(source);
    if (!resolved.url) return;

    const format = resolveFormat(resolved, options);
    const invoke = await getTauriInvoke();
    await invoke("native_audio_preload", {
      url: resolved.url,
      format,
      headers: options?.requestHeaders,
    });
  }

  getActualCurrentTime(): number {
    return this.currentPosition;
  }

  hasTrackEnded(): boolean {
    return this.trackEnded;
  }

  notifyTrackEnded(): void {
    this.trackEnded = true;
    this.playing = false;
    this.emit("end", undefined as never);
  }

  isCurrentlySeeking(): boolean {
    return this.seeking;
  }

  getSeekTarget(): number | null {
    return this.seekTarget;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    this.listeners.clear();

    getTauriInvoke()
      .then((invoke) => invoke("native_audio_stop"))
      .catch(() => {});
  }

  // -- Internal: emit helper ------------------------------------------------

  private emit<T extends AudioEngineEventType>(
    event: T,
    payload: unknown,
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch {
        // handler errors must not break the adapter
      }
    }
  }

  // -- Internal: Tauri event registration -----------------------------------

  private async registerTauriListeners(): Promise<void> {
    let listen: ListenFn;
    try {
      listen = await getTauriEvents();
    } catch {
      // Not in a Tauri context — no-op
      return;
    }

    const reg = async <T>(
      event: string,
      handler: (payload: T) => void,
    ): Promise<void> => {
      const unlisten = await listen<T>(event, (e) => handler(e.payload));
      this.unlistenFns.push(unlisten);
    };

    // timeupdate ----------------------------------------------------------
    await reg<NativeAudioTimeUpdate>(
      "native-audio-timeupdate",
      (payload) => {
        // Suppress stale timeupdates while seeking
        if (
          this.seeking &&
          this.seekTarget !== null &&
          Math.abs(payload.position_secs - this.seekTarget) > SEEK_STALE_WINDOW_MS / 1000
        ) {
          return;
        }

        this.currentPosition = payload.position_secs;
        if (
          payload.duration_secs > 0 &&
          payload.duration_secs !== this.currentDuration
        ) {
          this.currentDuration = payload.duration_secs;
        }

        const updatePayload: AudioEngineTimeUpdatePayload = {
          timeSec: payload.position_secs,
        };
        this.emit("timeupdate", updatePayload);
      },
    );

    // loaded --------------------------------------------------------------
    await reg<NativeAudioLoaded>("native-audio-loaded", (payload) => {
      this.currentDuration = payload.duration_secs;
      const loadPayload: AudioEngineLoadPayload = {
        durationSec: payload.duration_secs,
      };
      this.emit("load", loadPayload);
    });

    // ended ---------------------------------------------------------------
    await reg<void>("native-audio-ended", () => {
      this.playing = false;
      this.trackEnded = true;
      this.emit("end", undefined as never);
    });

    // error ---------------------------------------------------------------
    await reg<NativeAudioError>("native-audio-error", (payload) => {
      const errorPayload: AudioEngineErrorPayload = {
        error: payload.message,
        code: payload.code,
        recoverable: payload.recoverable,
      };

      if (payload.phase === "load") {
        this.emit("loaderror", errorPayload);
      } else if (payload.phase === "play") {
        this.emit("playerror", errorPayload);
      }
      this.emit("error", errorPayload);
    });

    // state ---------------------------------------------------------------
    await reg<NativeAudioState>("native-audio-state", (payload) => {
      this.currentPosition = payload.position_secs;
      if (payload.duration_secs > 0) {
        this.currentDuration = payload.duration_secs;
      }

      switch (payload.status) {
        case "playing":
          this.playing = true;
          this.emit("play", undefined as never);
          break;
        case "paused":
          this.playing = false;
          this.emit("pause", undefined as never);
          break;
        case "stopped":
        case "idle":
          this.playing = false;
          this.emit("stop", undefined as never);
          break;
      }
    });

    // buffering -----------------------------------------------------------
    await reg<NativeAudioBuffering>(
      "native-audio-buffering",
      (payload) => {
        const bufferingPayload: AudioEngineBufferingPayload = {
          isBuffering: payload.is_buffering,
          reason: payload.reason,
        };
        this.emit("buffering", bufferingPayload);
      },
    );
  }
}
