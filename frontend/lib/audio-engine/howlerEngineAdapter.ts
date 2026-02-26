import {
  howlerEngine,
  type HowlerEventCallback,
  type HowlerEventType,
  type HowlerRequestOptions,
} from "@/lib/howler-engine";
import {
  type AudioEngine,
  type AudioEngineErrorPayload,
  type AudioEngineEventHandler,
  type AudioEngineEventType,
  type AudioEngineLoadOptions,
  type AudioEngineSource,
  type StreamingEngineMode,
} from "@/lib/audio-engine/types";
import { isHowlerModeEnabled } from "@/lib/audio-engine/engineMode";

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

type AnyAudioEventHandler = (payload: unknown) => void;

interface HowlerHandlerRegistration {
  eventTypes: HowlerEventType[];
  callbacks: HowlerEventCallback[];
}

interface HowlerEngineLike {
  load(
    src: string,
    autoplay?: boolean,
    format?: string,
    isRetry?: boolean,
    requestOptions?: HowlerRequestOptions,
  ): void;
  play(): void;
  pause(): void;
  stop(): void;
  seek(time: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
  on(event: HowlerEventType, callback: HowlerEventCallback): void;
  off(event: HowlerEventType, callback: HowlerEventCallback): void;
  preload(
    src: string,
    format?: string,
    requestOptions?: HowlerRequestOptions,
  ): void;
  reload(): void;
  getActualCurrentTime(): number;
  isCurrentlySeeking(): boolean;
  getSeekTarget(): number | null;
}

export interface HowlerEngineAdapterOptions {
  engine?: HowlerEngineLike;
}

export interface CreateHowlerEngineOptions
  extends HowlerEngineAdapterOptions {
  mode?: StreamingEngineMode | string;
}

const getRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
};

const getNumericValue = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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

const resolveSource = (source: AudioEngineSource | string): AudioEngineSource => {
  if (typeof source === "string") {
    return { url: source };
  }
  return source;
};

const toHowlerRequestOptions = (
  options?: AudioEngineLoadOptions,
): HowlerRequestOptions | undefined => {
  if (!options) {
    return undefined;
  }

  const requestHeaders =
    options.requestHeaders && Object.keys(options.requestHeaders).length > 0
      ? { ...options.requestHeaders }
      : undefined;
  const withCredentials =
    typeof options.withCredentials === "boolean"
      ? options.withCredentials
      : undefined;
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : undefined;

  if (
    !requestHeaders &&
    typeof withCredentials !== "boolean" &&
    typeof timeoutMs !== "number"
  ) {
    return undefined;
  }

  return {
    requestHeaders,
    withCredentials,
    timeoutMs,
  };
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

const toErrorPayload = (payload: unknown): AudioEngineErrorPayload => {
  const recordPayload = getRecord(payload);
  const nestedError = recordPayload?.error;
  const error = nestedError ?? payload;
  const code =
    typeof recordPayload?.code === "string" ? recordPayload.code : undefined;
  const recoverable =
    typeof recordPayload?.recoverable === "boolean"
      ? recordPayload.recoverable
      : undefined;

  return {
    error,
    code,
    recoverable,
  };
};

const eventTypeForSimpleEvents: Partial<
  Record<AudioEngineEventType, HowlerEventType>
> = {
  play: "play",
  pause: "pause",
  stop: "stop",
  end: "end",
};

/**
 * AudioEngine compatibility adapter for the existing Howler runtime.
 */
export class HowlerEngineAdapter implements AudioEngine {
  private readonly engine: HowlerEngineLike;
  private readonly registrations = new Map<
    AudioEngineEventType,
    Map<AnyAudioEventHandler, HowlerHandlerRegistration>
  >();

  constructor(options: HowlerEngineAdapterOptions = {}) {
    this.engine = options.engine ?? howlerEngine;
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
      throw new Error("HowlerEngineAdapter.load requires a non-empty source URL.");
    }

    const normalizedOptions: AudioEngineLoadOptions =
      typeof optionsOrAutoplay === "boolean"
        ? {
            autoplay: optionsOrAutoplay,
            format,
          }
        : optionsOrAutoplay;

    this.engine.load(
      resolvedSource.url,
      normalizedOptions.autoplay ?? false,
      resolveFormat(resolvedSource, normalizedOptions),
      false,
      toHowlerRequestOptions(normalizedOptions),
    );
  }

  play(): void {
    this.engine.play();
  }

  pause(): void {
    this.engine.pause();
  }

  stop(): void {
    this.engine.stop();
  }

  seek(timeSec: number): void {
    this.engine.seek(timeSec);
  }

  setVolume(value: number): void {
    this.engine.setVolume(value);
  }

  setMuted(value: boolean): void {
    this.engine.setMuted(value);
  }

  getCurrentTime(): number {
    return this.engine.getCurrentTime();
  }

  getDuration(): number {
    return this.engine.getDuration();
  }

  isPlaying(): boolean {
    return this.engine.isPlaying();
  }

  on<T extends AudioEngineEventType>(
    event: T,
    handler: AudioEngineEventHandler<T>,
  ): void {
    const listener = handler as unknown as AnyAudioEventHandler;
    let eventRegistrations = this.registrations.get(event);
    if (!eventRegistrations) {
      eventRegistrations = new Map();
      this.registrations.set(event, eventRegistrations);
    }
    if (eventRegistrations.has(listener)) {
      return;
    }

    const registration = this.createRegistration(event, listener);
    if (!registration) {
      return;
    }

    registration.eventTypes.forEach((eventType, index) => {
      this.engine.on(eventType, registration.callbacks[index]);
    });
    eventRegistrations.set(listener, registration);
  }

  off<T extends AudioEngineEventType>(
    event: T,
    handler: AudioEngineEventHandler<T>,
  ): void {
    const listener = handler as unknown as AnyAudioEventHandler;
    const eventRegistrations = this.registrations.get(event);
    if (!eventRegistrations) {
      return;
    }

    const registration = eventRegistrations.get(listener);
    if (!registration) {
      return;
    }

    registration.eventTypes.forEach((eventType, index) => {
      this.engine.off(eventType, registration.callbacks[index]);
    });
    eventRegistrations.delete(listener);
    if (eventRegistrations.size === 0) {
      this.registrations.delete(event);
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

    this.engine.preload(
      resolvedSource.url,
      resolveFormat(resolvedSource, normalizedOptions),
      toHowlerRequestOptions(normalizedOptions),
    );
  }

  reload(): void {
    this.engine.reload();
  }

  getActualCurrentTime(): number {
    return this.engine.getActualCurrentTime();
  }

  isCurrentlySeeking(): boolean {
    return this.engine.isCurrentlySeeking();
  }

  getSeekTarget(): number | null {
    return this.engine.getSeekTarget();
  }

  destroy(): void {
    for (const handlers of this.registrations.values()) {
      for (const registration of handlers.values()) {
        registration.eventTypes.forEach((eventType, index) => {
          this.engine.off(eventType, registration.callbacks[index]);
        });
      }
    }
    this.registrations.clear();
  }

  private createRegistration(
    event: AudioEngineEventType,
    handler: AnyAudioEventHandler,
  ): HowlerHandlerRegistration | null {
    const simpleEvent = eventTypeForSimpleEvents[event];
    if (simpleEvent) {
      return {
        eventTypes: [simpleEvent],
        callbacks: [() => handler(undefined)],
      };
    }

    switch (event) {
      case "load":
        return {
          eventTypes: ["load"],
          callbacks: [
            (payload?: unknown) => {
              const duration =
                getNumericValue(getRecord(payload)?.duration) ??
                this.engine.getDuration();
              handler({
                durationSec: duration,
                duration,
              });
            },
          ],
        };
      case "seek":
        return {
          eventTypes: ["seek"],
          callbacks: [
            (payload?: unknown) => {
              const timeSec =
                getNumericValue(getRecord(payload)?.time) ??
                this.engine.getCurrentTime();
              handler({
                timeSec,
                time: timeSec,
              });
            },
          ],
        };
      case "timeupdate":
        return {
          eventTypes: ["timeupdate"],
          callbacks: [
            (payload?: unknown) => {
              const timeSec =
                getNumericValue(getRecord(payload)?.time) ??
                this.engine.getCurrentTime();
              handler({
                timeSec,
                time: timeSec,
              });
            },
          ],
        };
      case "volume":
        return {
          eventTypes: ["volume"],
          callbacks: [
            (payload?: unknown) => {
              const volume = getNumericValue(getRecord(payload)?.volume) ?? 0;
              handler({ volume });
            },
          ],
        };
      case "loaderror":
        return {
          eventTypes: ["loaderror"],
          callbacks: [(payload?: unknown) => handler(toErrorPayload(payload))],
        };
      case "playerror":
        return {
          eventTypes: ["playerror"],
          callbacks: [(payload?: unknown) => handler(toErrorPayload(payload))],
        };
      case "error":
        return {
          eventTypes: ["loaderror", "playerror"],
          callbacks: [
            (payload?: unknown) => handler(toErrorPayload(payload)),
            (payload?: unknown) => handler(toErrorPayload(payload)),
          ],
        };
      case "buffering":
      case "vhsresponse":
        return null;
      default:
        return null;
    }
  }
}

/**
 * Creates a Howler adapter only when explicit howler mode is enabled.
 */
export const createHowlerEngine = (
  options: CreateHowlerEngineOptions = {},
): HowlerEngineAdapter => {
  if (!isHowlerModeEnabled(options.mode)) {
    throw new Error(
      "Howler is the primary direct engine. This adapter only initializes when STREAMING_ENGINE_MODE=howler.",
    );
  }

  return new HowlerEngineAdapter({ engine: options.engine });
};
