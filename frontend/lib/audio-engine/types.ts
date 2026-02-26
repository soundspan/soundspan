import type { AudioEngineSourceType } from "@soundspan/media-metadata-contract";

export type StreamingEngineMode =
  | "videojs"
  | "howler";

export const DEFAULT_STREAMING_ENGINE_MODE: StreamingEngineMode = "howler";

export type StreamingProtocolMode = "dash" | "hls" | "direct";

export interface AudioEngineSource {
  url: string;
  trackId?: string;
  sessionId?: string;
  sourceType?: AudioEngineSourceType | "unknown";
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

export interface AudioEngineVhsResponsePayload {
  kind: "manifest" | "init" | "segment" | "other";
  uri: string;
  representationId: string | null;
  statusCode: number | null;
  hasError: boolean;
  roundTripMs: number | null;
  bytesReceived: number | null;
  sourceType: AudioEngineSourceType | "unknown";
  sessionId: string | null;
  trackId: string | null;
  timestampMs: number;
}

export interface AudioEngineManifestStallPayload {
  trackId: string | null;
  sessionId: string | null;
  reason: string;
  timeoutMs: number;
  manifestUri: string | null;
  sourceType: AudioEngineSourceType | "unknown";
  timestampMs: number;
}

export interface AudioEngineRepresentationFailoverResult {
  quarantinedRepresentationId: string;
  selectedRepresentationId: string | null;
  enabledRepresentationCount: number;
  totalRepresentationCount: number;
  allRepresentationsUnhealthy: boolean;
  didSwitchRepresentation: boolean;
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
  vhsresponse: AudioEngineVhsResponsePayload;
  manifeststall: AudioEngineManifestStallPayload;
  "manifest-stall": AudioEngineManifestStallPayload;
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
  refreshManifest?(): void | Promise<void>;
  quarantineRepresentation?(
    representationId: string,
    cooldownMs: number,
  ): AudioEngineRepresentationFailoverResult | null;
  clearRepresentationQuarantine?(): void;
  getActualCurrentTime?(): number;
  isCurrentlySeeking?(): boolean;
  getSeekTarget?(): number | null;
}
