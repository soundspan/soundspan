export type StreamingEngineMode =
  | "videojs"
  | "react-all-player"
  | "howler-rollback";

export const DEFAULT_STREAMING_ENGINE_MODE: StreamingEngineMode = "videojs";

export type StreamingProtocolMode = "dash" | "hls" | "direct";

export interface AudioEngineSource {
  url: string;
  trackId?: string;
  sessionId?: string;
  sourceType?: "local" | "tidal" | "ytmusic" | "unknown";
  protocol?: StreamingProtocolMode;
  mimeType?: string;
}

export interface AudioEngineLoadOptions {
  autoplay?: boolean;
  format?: string;
  startTimeSec?: number;
  withCredentials?: boolean;
  requestHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface AudioEngineErrorPayload {
  error: unknown;
  code?: string;
  recoverable?: boolean;
}

export interface AudioEngineLoadPayload {
  durationSec: number;
}

export interface AudioEngineSeekPayload {
  timeSec: number;
}

export interface AudioEngineTimeUpdatePayload {
  timeSec: number;
}

export interface AudioEngineVolumePayload {
  volume: number;
  muted?: boolean;
}

export interface AudioEngineBufferingPayload {
  isBuffering: boolean;
  reason?: string;
}

export interface AudioEngineEventPayloadMap {
  load: AudioEngineLoadPayload;
  play: void;
  pause: void;
  stop: void;
  end: void;
  seek: AudioEngineSeekPayload;
  timeupdate: AudioEngineTimeUpdatePayload;
  volume: AudioEngineVolumePayload;
  buffering: AudioEngineBufferingPayload;
  loaderror: AudioEngineErrorPayload;
  playerror: AudioEngineErrorPayload;
  error: AudioEngineErrorPayload;
}

export type AudioEngineEventType = keyof AudioEngineEventPayloadMap;

export type AudioEngineEventHandler<T extends AudioEngineEventType> = (
  payload: AudioEngineEventPayloadMap[T],
) => void;

/**
 * Shared playback runtime contract used by segmented and legacy adapters.
 * Implementations may return sync or async for load/seek/control operations.
 */
export interface AudioEngine {
  load(
    source: AudioEngineSource | string,
    options?: AudioEngineLoadOptions,
  ): void | Promise<void>;
  play(): void | Promise<void>;
  pause(): void | Promise<void>;
  stop(): void | Promise<void>;
  seek(timeSec: number): void | Promise<void>;
  setVolume(value: number): void;
  setMuted(value: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
  on<T extends AudioEngineEventType>(
    event: T,
    handler: AudioEngineEventHandler<T>,
  ): void;
  off<T extends AudioEngineEventType>(
    event: T,
    handler: AudioEngineEventHandler<T>,
  ): void;
  destroy?(): void;
  preload?(
    source: AudioEngineSource | string,
    options?: AudioEngineLoadOptions,
  ): void | Promise<void>;
  reload?(): void | Promise<void>;
  getActualCurrentTime?(): number;
  isCurrentlySeeking?(): boolean;
  getSeekTarget?(): number | null;
}
