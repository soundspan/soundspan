import videojs from "video.js";
import type {
  AudioEngine,
  AudioEngineEventHandler,
  AudioEngineEventPayloadMap,
  AudioEngineEventType,
  AudioEngineLoadOptions,
  AudioEngineManifestStallPayload,
  AudioEngineRepresentationFailoverResult,
  AudioEngineSource,
} from "@/lib/audio-engine/types";
import {
  resolveSegmentRepresentationIdFromUri,
} from "@/lib/audio-engine/segmentedRepresentationPolicy";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

type AnyAudioEventHandler = (payload: unknown) => void;

interface VideoJsRequestConfig {
  headers?: Record<string, string>;
  withCredentials?: boolean;
  [key: string]: unknown;
}

interface VideoJsVhsXhr {
  onRequest: (
    callback: (config: VideoJsRequestConfig) => VideoJsRequestConfig,
  ) => void;
  onResponse?: (
    callback: (
      request: VideoJsResponseHookRequest,
      error: unknown,
      response: VideoJsResponseHookResponse,
    ) => void,
  ) => void;
  offRequest?: (
    callback: (config: VideoJsRequestConfig) => VideoJsRequestConfig,
  ) => void;
  offResponse?: (
    callback: (
      request: VideoJsResponseHookRequest,
      error: unknown,
      response: VideoJsResponseHookResponse,
    ) => void,
  ) => void;
}

interface VideoJsResponseHookRequest {
  uri?: string;
  requestType?: string;
  statusCode?: number;
  requestTime?: number;
  roundTripTime?: number;
  bytesReceived?: number;
  bandwidth?: number;
}

interface VideoJsResponseHookResponse {
  statusCode?: number;
  headers?: Record<string, string>;
}

interface VideoJsVhsStatsSnapshot {
  bandwidth?: number;
  throughput?: number;
  systemBandwidth?: number;
  statsBandwidth?: number;
  mediaRequests?: number;
  mediaRequestsErrored?: number;
  mediaRequestsTimedout?: number;
  mediaRequestsAborted?: number;
  mediaTransferDurationMs?: number;
  mediaBytesTransferred?: number;
  mediaSecondsLoaded?: number;
  statsTimestamp?: number;
}

interface VideoJsUsageEvent {
  name?: string;
  type?: string;
  [key: string]: unknown;
}

interface VideoJsEventTarget {
  on: (event: string, callback: (event: VideoJsUsageEvent) => void) => void;
  off?: (event: string, callback: (event: VideoJsUsageEvent) => void) => void;
}

interface VideoJsQualityLevel {
  id?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  enabled?: boolean | ((value?: boolean) => boolean);
}

interface VideoJsQualityLevelEvent {
  qualityLevel?: VideoJsQualityLevel;
}

interface VideoJsQualityLevelList {
  length: number;
  selectedIndex?: number;
  on: (event: string, callback: (event: VideoJsQualityLevelEvent) => void) => void;
  off?: (
    event: string,
    callback: (event: VideoJsQualityLevelEvent) => void,
  ) => void;
  [index: number]: VideoJsQualityLevel;
}

interface VideoJsPlayerWithQualityLevels {
  qualityLevels?: () => VideoJsQualityLevelList | null | undefined;
}

interface VideoJsAudioModeController {
  audioOnlyMode?: (value?: boolean) => boolean;
  audioPosterMode?: (value?: boolean) => boolean;
}

interface VideoJsVhsInitializationOptions {
  overrideNative: boolean;
  withCredentials: boolean;
  useBandwidthFromLocalStorage?: boolean;
  maxPlaylistRetries?: number;
  playlistExclusionDuration?: number;
  enableLowInitialPlaylist?: boolean;
  bufferBasedABR?: boolean;
  handlePartialData?: boolean;
  liveRangeSafeTimeDelta?: number;
}

interface VideoJsVhsUnsafeBufferControls {
  GOAL_BUFFER_LENGTH?: number;
  MAX_GOAL_BUFFER_LENGTH?: number;
  BUFFER_LOW_WATER_LINE?: number;
  MAX_BUFFER_LOW_WATER_LINE?: number;
}

interface VideoJsVhsManifestLoader {
  load?: () => void;
  refreshXml_?: () => void;
}

interface VideoJsVhsManifestController {
  mainPlaylistLoader_?: VideoJsVhsManifestLoader;
}

type VhsRequestKind = "manifest" | "init" | "segment" | "other";
type VhsBufferControlPreset =
  | "steady_state"
  | "startup_low_latency"
  | "vod_full_track";
type DashLiveState = "live" | "vod" | "unknown";
type DashStartupReconciliationTrigger =
  | "loadedmetadata"
  | "durationchange"
  | "timeupdate";

interface VideoJsDashLiveDelaySettings {
  streaming?: {
    delay?: {
      liveDelay?: number;
    };
  };
}

interface VideoJsDashMediaPlayer {
  updateSettings?: (settings: VideoJsDashLiveDelaySettings) => void;
}

interface VideoJsDashRuntimeTech {
  dash?: {
    mediaPlayer?: VideoJsDashMediaPlayer;
    mediaPlayer_?: VideoJsDashMediaPlayer;
  };
  mediaPlayer?: VideoJsDashMediaPlayer;
}

interface VideoJsVhsPlaylistSnapshot {
  endList?: boolean;
}

interface VideoJsVhsRuntimeTech {
  playlists?: {
    media?: () => VideoJsVhsPlaylistSnapshot | null | undefined;
  };
}

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const VHS_SEGMENT_SAMPLE_EVERY = 10;
const VHS_USAGE_EVENT_MAX_PER_NAME = 4;
const VHS_QUALITY_EVENT_MAX_PER_SOURCE = 16;
const VHS_HIGH_SIGNAL_USAGE_EVENTS = new Set<string>([
  "vhs-gap-skip",
  "vhs-unknown-waiting",
  "vhs-video-underflow",
  "vhs-live-resync",
  "vhs-rendition-excluded",
  "vhs-error-reload",
  "vhs-error-reload-canceled",
]);
const VHS_ABR_POLICY_MODE = "auto";
const VHS_ABR_POLICY_MANUAL_PINNING = "disabled_client_side";
const VHS_ABR_POLICY_SELECTION_AUTHORITY = "server_segmented_session_quality";
const SOUNDSPAN_RUNTIME_CONFIG_KEY = "__SOUNDSPAN_RUNTIME_CONFIG__";
const SEGMENTED_VHS_PROFILE_KEY = "SEGMENTED_VHS_PROFILE";
const SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC_KEY =
  "SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC";
const SEGMENTED_VHS_GOAL_BUFFER_SEC_KEY = "SEGMENTED_VHS_GOAL_BUFFER_SEC";
const SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC_KEY = "SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC";
const SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC_KEY =
  "SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC";
const SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC_KEY =
  "SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC";
type SegmentedVhsProfile = "balanced" | "legacy";
const DEFAULT_SEGMENTED_VHS_PROFILE: SegmentedVhsProfile = "balanced";
const DEFAULT_SEGMENTED_VHS_GOAL_BUFFER_SEC = 180;
const DEFAULT_SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC = 600;
const DEFAULT_SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC = 15;
const DEFAULT_SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC = 120;
const DEFAULT_SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC = 0.2;
const LOW_LATENCY_STARTUP_BUFFER_MULTIPLIER = 2;
const DASH_VOD_FULL_TRACK_BUFFER_PADDING_SEC = 15;
const DASH_VOD_FULL_TRACK_BUFFER_MAX_SEC = 3_600;
const DASHJS_LIVE_DELAY_TARGET_SEC = 1.5;
const DASH_UNKNOWN_LIVE_STATE_FALLBACK_MAX_MS = 6_000;
const DASH_UNKNOWN_LIVE_STATE_PROGRESS_SAMPLE_MIN_TIME_SEC = 1;
const DASH_UNKNOWN_LIVE_STATE_PROGRESS_SAMPLE_THRESHOLD = 3;
const DASH_MANIFEST_SEGMENT_STALL_TIMEOUT_MS = 4_000;
const MANIFEST_STALL_REASON_PLAYLIST_REFRESH_TIMEOUT =
  "playlist_refresh_timeout";

const readRuntimeSegmentedVhsProfile = (): string | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }

  const runtimeConfig = (
    window as Window & {
      [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
    }
  )[SOUNDSPAN_RUNTIME_CONFIG_KEY];
  const runtimeValue = runtimeConfig?.[SEGMENTED_VHS_PROFILE_KEY];
  return typeof runtimeValue === "string" ? runtimeValue : undefined;
};

const readRuntimeConfigValue = (key: string): unknown => {
  if (typeof window === "undefined") {
    return undefined;
  }

  const runtimeConfig = (
    window as Window & {
      [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
    }
  )[SOUNDSPAN_RUNTIME_CONFIG_KEY];

  return runtimeConfig?.[key];
};

const readRuntimeNonNegativeNumber = (
  key: string,
  fallback: number,
): number => {
  const runtimeValue = readRuntimeConfigValue(key);
  if (typeof runtimeValue === "number" && Number.isFinite(runtimeValue)) {
    return Math.max(0, runtimeValue);
  }
  if (typeof runtimeValue === "string") {
    const parsed = Number.parseFloat(runtimeValue);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return fallback;
};

const readRuntimePositiveNumber = (
  key: string,
  fallback: number,
): number => {
  const value = readRuntimeNonNegativeNumber(key, fallback);
  return value > 0 ? value : fallback;
};

const hasRuntimeConfigValue = (key: string): boolean => {
  const runtimeValue = readRuntimeConfigValue(key);
  if (runtimeValue === undefined || runtimeValue === null) {
    return false;
  }
  if (typeof runtimeValue === "string") {
    return runtimeValue.trim().length > 0;
  }
  return true;
};

const hasRuntimeVhsBufferControlOverride = (): boolean =>
  hasRuntimeConfigValue(SEGMENTED_VHS_GOAL_BUFFER_SEC_KEY) ||
  hasRuntimeConfigValue(SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC_KEY) ||
  hasRuntimeConfigValue(SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC_KEY) ||
  hasRuntimeConfigValue(SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC_KEY);

const resolveUnsafeVhsBufferControls = (): Required<VideoJsVhsUnsafeBufferControls> => {
  const goalBufferSec = readRuntimeNonNegativeNumber(
    SEGMENTED_VHS_GOAL_BUFFER_SEC_KEY,
    DEFAULT_SEGMENTED_VHS_GOAL_BUFFER_SEC,
  );
  const maxGoalBufferSec = Math.max(
    goalBufferSec,
    readRuntimeNonNegativeNumber(
      SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC_KEY,
      DEFAULT_SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC,
    ),
  );
  const bufferLowWaterLineSec = readRuntimeNonNegativeNumber(
    SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC_KEY,
    DEFAULT_SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC,
  );
  const maxBufferLowWaterLineSec = Math.max(
    bufferLowWaterLineSec,
    readRuntimeNonNegativeNumber(
      SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC_KEY,
      DEFAULT_SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC,
    ),
  );

  return {
    GOAL_BUFFER_LENGTH: goalBufferSec,
    MAX_GOAL_BUFFER_LENGTH: maxGoalBufferSec,
    BUFFER_LOW_WATER_LINE: bufferLowWaterLineSec,
    MAX_BUFFER_LOW_WATER_LINE: maxBufferLowWaterLineSec,
  };
};

const resolveLowLatencyStartupVhsBufferControls =
  (): Required<VideoJsVhsUnsafeBufferControls> => {
    const fragmentDurationSec = readRuntimePositiveNumber(
      SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC_KEY,
      DEFAULT_SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC,
    );
    const startupGoalBufferSec =
      fragmentDurationSec * LOW_LATENCY_STARTUP_BUFFER_MULTIPLIER;

    return {
      GOAL_BUFFER_LENGTH: startupGoalBufferSec,
      MAX_GOAL_BUFFER_LENGTH: startupGoalBufferSec,
      BUFFER_LOW_WATER_LINE: fragmentDurationSec,
      MAX_BUFFER_LOW_WATER_LINE: startupGoalBufferSec,
    };
  };

const resolveSegmentedVhsProfile = (): SegmentedVhsProfile => {
  const runtimeValue = readRuntimeSegmentedVhsProfile();
  const normalized = runtimeValue?.trim().toLowerCase();
  if (normalized === "legacy" || normalized === "balanced") {
    return normalized;
  }
  return DEFAULT_SEGMENTED_VHS_PROFILE;
};

const resolveVhsInitializationOptions = (
  profile: SegmentedVhsProfile,
): VideoJsVhsInitializationOptions => {
  if (profile === "legacy") {
    return {
      overrideNative: true,
      withCredentials: false,
    };
  }

  return {
    overrideNative: true,
    withCredentials: false,
    useBandwidthFromLocalStorage: true,
    maxPlaylistRetries: 6,
    playlistExclusionDuration: 15,
    enableLowInitialPlaylist: true,
    bufferBasedABR: true,
    handlePartialData: true,
    liveRangeSafeTimeDelta: 0,
  };
};

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
  private playerVhsXhr: VideoJsVhsXhr | null = null;
  private playerRequestHook:
    | ((config: VideoJsRequestConfig) => VideoJsRequestConfig)
    | null = null;
  private playerResponseHook:
    | ((
        request: VideoJsResponseHookRequest,
        error: unknown,
        response: VideoJsResponseHookResponse,
      ) => void)
    | null = null;
  private segmentResponseCount = 0;
  private usageEventCounts = new Map<string, number>();
  private usageEventSourceKey: string | null = null;
  private usagePlayerHandler: ((event: VideoJsUsageEvent) => void) | null = null;
  private usageTechTarget: VideoJsEventTarget | null = null;
  private usageTechHandler: ((event: VideoJsUsageEvent) => void) | null = null;
  private qualityLevelList: VideoJsQualityLevelList | null = null;
  private qualityLevelChangeHandler:
    | ((event: VideoJsQualityLevelEvent) => void)
    | null = null;
  private qualityLevelAddHandler:
    | ((event: VideoJsQualityLevelEvent) => void)
    | null = null;
  private readonly representationQuarantineUntilMs = new Map<string, number>();
  private readonly representationQuarantineTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private representationQuarantineResetPending = false;
  private qualityEventCount = 0;
  private qualityPolicyLoggedSourceKey: string | null = null;
  private readonly segmentedVhsProfile: SegmentedVhsProfile;
  private readonly vhsInitializationOptions: VideoJsVhsInitializationOptions;
  private readonly runtimeVhsBufferControlsOverridden: boolean;
  private activeVhsBufferControlPreset: VhsBufferControlPreset | null = null;
  private vodFullTrackBufferAppliedForSourceKey: string | null = null;
  private startupBufferTuningPendingForSourceKey: string | null = null;
  private dashJsLiveDelayEvaluatedForSourceKey: string | null = null;
  private dashUnknownLiveStateSourceKey: string | null = null;
  private dashUnknownLiveStateObservedAtMs: number | null = null;
  private dashUnknownLiveStateProgressSampleCount = 0;
  private manifestStallDetectionSourceKey: string | null = null;
  private manifestStallDetectionSegmentSeen = false;
  private manifestStallDetectionEventEmitted = false;
  private manifestStallDetectionTimer: ReturnType<typeof setTimeout> | null = null;
  private audioModeStrategy: "audioOnlyMode" | "hiddenVideoFallback" =
    "hiddenVideoFallback";

  constructor() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("VideoJsSegmentedEngine requires a browser environment.");
    }

    this.segmentedVhsProfile = resolveSegmentedVhsProfile();
    this.vhsInitializationOptions = resolveVhsInitializationOptions(
      this.segmentedVhsProfile,
    );
    this.runtimeVhsBufferControlsOverridden =
      hasRuntimeVhsBufferControlOverride();
    this.applyVhsBufferControls("steady_state", "engine_init");

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
        nativeAudioTracks: false,
        nativeVideoTracks: false,
        vhs: {
          ...this.vhsInitializationOptions,
        },
      },
    });

    this.configureAudioOnlyMode();
    this.logVhsStartupConfig();
    this.installPlayerRequestHook();
    this.installVhsUsageHooks();
    this.installVhsQualityLevelHooks();
    this.bindPlayerEvents();
  }

  private applyVhsBufferControls(
    preset: VhsBufferControlPreset,
    reason: string,
    overrideControls?: Required<VideoJsVhsUnsafeBufferControls>,
    additionalMetricFields: Record<string, unknown> = {},
  ): void {
    const vhsGlobal = (
      videojs as typeof videojs & {
        Vhs?: VideoJsVhsUnsafeBufferControls;
      }
    ).Vhs;

    if (!vhsGlobal) {
      return;
    }

    const controls =
      overrideControls ??
      (preset === "startup_low_latency"
        ? resolveLowLatencyStartupVhsBufferControls()
        : resolveUnsafeVhsBufferControls());
    const controlsAlreadyApplied = Object.entries(controls).every(([key, value]) => {
      if (!isFiniteNumber(value)) {
        return true;
      }
      const controlKey = key as keyof VideoJsVhsUnsafeBufferControls;
      return vhsGlobal[controlKey] === value;
    });

    if (
      this.activeVhsBufferControlPreset === preset &&
      controlsAlreadyApplied
    ) {
      return;
    }

    const applied: Record<string, number> = {};
    for (const [key, value] of Object.entries(controls)) {
      if (!isFiniteNumber(value)) {
        continue;
      }
      try {
        const controlKey = key as keyof VideoJsVhsUnsafeBufferControls;
        vhsGlobal[controlKey] = value;
        applied[key] = value;
      } catch {
        // Ignore unavailable/immutable VHS globals on unsupported builds.
      }
    }

    if (Object.keys(applied).length === 0) {
      return;
    }

    this.activeVhsBufferControlPreset = preset;

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.vhs_buffer_controls_applied",
      timestamp: new Date().toISOString(),
      preset,
      reason,
      controls: applied,
      ...additionalMetricFields,
    });
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

    this.removePlayerRequestHook();
    this.resetManifestStallDetection(resolvedSource);
    this.lastSource = resolvedSource;
    this.lastLoadOptions = normalizedOptions;
    this.resetUsageEventCountersIfNeeded(resolvedSource);
    this.vodFullTrackBufferAppliedForSourceKey = null;
    if (resolvedSource.protocol === "dash") {
      this.emitVhsAbrPolicyTelemetry(resolvedSource);
      // DASH startup uses steady-state buffer controls to avoid ultra-low
      // startup targets that can amplify early rebuffer loops on cold starts.
      // Keep startup reconciliation enabled for balanced profile so live-delay
      // tuning still applies when live state is discovered.
      this.startupBufferTuningPendingForSourceKey =
        this.segmentedVhsProfile === "balanced"
          ? this.getUsageEventSourceKey(resolvedSource)
          : null;
      this.applyVhsBufferControls("steady_state", "dash_startup");
    } else {
      this.startupBufferTuningPendingForSourceKey = null;
      this.applyVhsBufferControls("steady_state", "non_dash_source");
    }
    this.resetDashUnknownLiveStateTracking();
    this.dashJsLiveDelayEvaluatedForSourceKey = null;
    this.requestHeaders = normalizedOptions.requestHeaders;
    this.requestWithCredentials = normalizedOptions.withCredentials;
    this.resetRepresentationQuarantineState();
    this.representationQuarantineResetPending = true;

    const withCredentials = normalizedOptions.withCredentials === true;
    this.mediaElement.crossOrigin = withCredentials ? "use-credentials" : "anonymous";
    const explicitStartTimeSec = isFiniteNumber(normalizedOptions.startTimeSec)
      ? Math.max(0, normalizedOptions.startTimeSec)
      : null;
    const shouldForceDashStartAtZero =
      resolvedSource.protocol === "dash" && explicitStartTimeSec === null;
    this.seekTarget = explicitStartTimeSec ?? (shouldForceDashStartAtZero ? 0 : null);
    if (shouldForceDashStartAtZero && isFiniteNumber(this.player.currentTime())) {
      this.player.currentTime(0);
    }

    this.player.src({
      src: resolvedSource.url,
      type: resolveMimeType(resolvedSource, normalizedOptions),
    });
    this.attachPlayerRequestHookIfAvailable();
    this.player.load();
    this.attachPlayerRequestHookIfAvailable();

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

  refreshManifest(): void {
    if (!this.lastSource || this.lastSource.protocol !== "dash") {
      return;
    }

    const tech = this.player.tech(true) as unknown as {
      vhs?: {
        playlistController_?: VideoJsVhsManifestController;
        masterPlaylistController_?: VideoJsVhsManifestController;
        masterPlaylistLoader_?: VideoJsVhsManifestLoader;
        playlists?: VideoJsVhsManifestLoader;
      };
    } | null;

    const vhs = tech?.vhs;
    const manifestLoaderCandidates: Array<VideoJsVhsManifestLoader | undefined> = [
      vhs?.playlistController_?.mainPlaylistLoader_,
      vhs?.masterPlaylistController_?.mainPlaylistLoader_,
      vhs?.masterPlaylistLoader_,
      vhs?.playlists,
    ];

    for (const loader of manifestLoaderCandidates) {
      if (!loader) {
        continue;
      }
      if (typeof loader.load === "function") {
        loader.load();
        sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
          event: "player.vhs_manifest_refresh_forced",
          timestamp: new Date().toISOString(),
          mode: "playlist_loader_load",
          trackId: this.lastSource.trackId ?? null,
          sessionId: this.lastSource.sessionId ?? null,
        });
        return;
      }
      if (typeof loader.refreshXml_ === "function") {
        loader.refreshXml_();
        sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
          event: "player.vhs_manifest_refresh_forced",
          timestamp: new Date().toISOString(),
          mode: "playlist_loader_refreshXml",
          trackId: this.lastSource.trackId ?? null,
          sessionId: this.lastSource.sessionId ?? null,
        });
        return;
      }
    }

    sharedFrontendLogger.warn(
      "[VideoJsSegmentedEngine] Unable to force manifest refresh; VHS playlist loader unavailable."
    );
  }

  quarantineRepresentation(
    representationId: string,
    cooldownMs: number,
  ): AudioEngineRepresentationFailoverResult | null {
    const normalizedRepresentationId =
      this.normalizeRepresentationId(representationId);
    if (!normalizedRepresentationId) {
      return null;
    }

    const levels = this.qualityLevelList;
    if (!levels || levels.length <= 0) {
      return null;
    }
    let representationExists = false;
    for (let index = 0; index < levels.length; index += 1) {
      if (
        this.resolveQualityLevelRepresentationId(levels[index]) ===
        normalizedRepresentationId
      ) {
        representationExists = true;
        break;
      }
    }
    if (!representationExists) {
      return null;
    }

    const nowMs = Date.now();
    const selectedBefore = this.getSelectedRepresentationId(levels);
    const safeCooldownMs =
      isFiniteNumber(cooldownMs) && cooldownMs > 0 ? Math.floor(cooldownMs) : 0;
    this.representationQuarantineUntilMs.set(
      normalizedRepresentationId,
      nowMs + safeCooldownMs,
    );
    this.scheduleRepresentationReenable(normalizedRepresentationId, safeCooldownMs);
    const snapshot = this.reconcileRepresentationQuarantine(nowMs);
    const selectedAfter = snapshot.selectedRepresentationId;
    const didSwitchRepresentation =
      selectedBefore === normalizedRepresentationId &&
      selectedAfter !== null &&
      selectedAfter !== selectedBefore;

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.representation_quarantined",
      timestamp: new Date(nowMs).toISOString(),
      trackId: this.lastSource?.trackId ?? null,
      sessionId: this.lastSource?.sessionId ?? null,
      sourceType: this.lastSource?.sourceType ?? "unknown",
      quarantinedRepresentationId: normalizedRepresentationId,
      selectedRepresentationIdBefore: selectedBefore,
      selectedRepresentationIdAfter: selectedAfter,
      didSwitchRepresentation,
      enabledRepresentationCount: snapshot.enabledRepresentationCount,
      totalRepresentationCount: snapshot.totalRepresentationCount,
      allRepresentationsUnhealthy: snapshot.allRepresentationsUnhealthy,
      cooldownMs: safeCooldownMs,
    });

    return {
      quarantinedRepresentationId: normalizedRepresentationId,
      selectedRepresentationId: selectedAfter,
      enabledRepresentationCount: snapshot.enabledRepresentationCount,
      totalRepresentationCount: snapshot.totalRepresentationCount,
      allRepresentationsUnhealthy: snapshot.allRepresentationsUnhealthy,
      didSwitchRepresentation,
    };
  }

  private resetRepresentationQuarantineState(): void {
    this.representationQuarantineUntilMs.clear();
    this.representationQuarantineTimers.forEach((timer) => {
      clearTimeout(timer);
    });
    this.representationQuarantineTimers.clear();
  }

  clearRepresentationQuarantine(): void {
    this.resetRepresentationQuarantineState();
    this.representationQuarantineResetPending = false;
    const levels = this.qualityLevelList;
    if (!levels) {
      return;
    }
    for (let index = 0; index < levels.length; index += 1) {
      this.setQualityLevelEnabled(levels[index], true);
    }
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
    this.clearRepresentationQuarantine();
    this.resetManifestStallDetection();
    this.removePlayerRequestHook();
    this.removeTechUsageHook();
    this.removePlayerUsageHook();
    this.removeQualityLevelHooks();

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

  private logVhsStartupConfig(): void {
    const startupFragmentDurationSec = readRuntimePositiveNumber(
      SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC_KEY,
      DEFAULT_SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC,
    );
    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.vhs_startup_config",
      timestamp: new Date().toISOString(),
      profile: this.segmentedVhsProfile,
      audioModeStrategy: this.audioModeStrategy,
      options: this.vhsInitializationOptions,
      runtimeVhsBufferControlsOverridden:
        this.runtimeVhsBufferControlsOverridden,
      startupFragmentDurationSec,
      startupGoalBufferSec:
        startupFragmentDurationSec * LOW_LATENCY_STARTUP_BUFFER_MULTIPLIER,
    });
  }

  private configureAudioOnlyMode(): void {
    const audioModePlayer = this.player as unknown as VideoJsAudioModeController;
    const supportsAudioOnlyMode =
      typeof audioModePlayer.audioOnlyMode === "function";
    const supportsAudioPosterMode =
      typeof audioModePlayer.audioPosterMode === "function";

    if (supportsAudioPosterMode) {
      audioModePlayer.audioPosterMode?.(false);
    }
    if (supportsAudioOnlyMode) {
      audioModePlayer.audioOnlyMode?.(true);
      this.audioModeStrategy = "audioOnlyMode";
    } else {
      this.audioModeStrategy = "hiddenVideoFallback";
    }

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.videojs_audio_mode",
      timestamp: new Date().toISOString(),
      strategy: this.audioModeStrategy,
      supportsAudioOnlyMode,
      supportsAudioPosterMode,
      audioOnlyModeEnabled: supportsAudioOnlyMode
        ? audioModePlayer.audioOnlyMode?.()
        : null,
      audioPosterModeEnabled: supportsAudioPosterMode
        ? audioModePlayer.audioPosterMode?.()
        : null,
    });
  }

  private installPlayerRequestHook(): void {
    // Official VHS hook point for per-player request interceptors.
    this.bindPlayerEvent("xhr-hooks-ready", () => {
      this.attachPlayerRequestHookIfAvailable();
    });
    this.bindPlayerEvent("techchange", () => {
      this.attachPlayerRequestHookIfAvailable();
    });
    this.bindPlayerEvent("loadstart", () => {
      this.attachPlayerRequestHookIfAvailable();
    });
    this.player.ready(() => {
      this.attachPlayerRequestHookIfAvailable();
    });
  }

  private attachPlayerRequestHookIfAvailable(): void {
    const nextVhsXhr = this.getPlayerVhsXhr();
    if (!nextVhsXhr) {
      return;
    }

    if (this.playerRequestHook && this.playerVhsXhr === nextVhsXhr) {
      return;
    }

    this.removePlayerRequestHook();

    const requestHook = (
      config: VideoJsRequestConfig,
    ): VideoJsRequestConfig => {
      const nextConfig: VideoJsRequestConfig = {
        ...config,
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

    nextVhsXhr.onRequest(requestHook);
    const responseHook = (
      request: VideoJsResponseHookRequest,
      error: unknown,
      response: VideoJsResponseHookResponse,
    ): void => {
      this.captureVhsResponseTelemetry(request, error, response);
    };

    if (typeof nextVhsXhr.onResponse === "function") {
      nextVhsXhr.onResponse(responseHook);
    }
    this.playerVhsXhr = nextVhsXhr;
    this.playerRequestHook = requestHook;
    this.playerResponseHook = responseHook;
  }

  private removePlayerRequestHook(): void {
    if (!this.playerVhsXhr || !this.playerRequestHook) {
      return;
    }

    if (typeof this.playerVhsXhr.offRequest === "function") {
      this.playerVhsXhr.offRequest(this.playerRequestHook);
    }
    if (
      this.playerResponseHook &&
      typeof this.playerVhsXhr.offResponse === "function"
    ) {
      this.playerVhsXhr.offResponse(this.playerResponseHook);
    }

    this.playerVhsXhr = null;
    this.playerRequestHook = null;
    this.playerResponseHook = null;
  }

  private getPlayerVhsXhr(): VideoJsVhsXhr | null {
    const tech = this.player.tech(true) as unknown as {
      vhs?: {
        xhr?: VideoJsVhsXhr;
      };
    } | null;

    return tech?.vhs?.xhr ?? null;
  }

  private installVhsUsageHooks(): void {
    const playerEventTarget = this.player as unknown as VideoJsEventTarget;
    const playerUsageHandler = (event: VideoJsUsageEvent): void => {
      this.captureVhsUsageTelemetry(event, "player");
    };
    playerEventTarget.on("usage", playerUsageHandler);
    this.usagePlayerHandler = playerUsageHandler;
    this.teardownCallbacks.push(() => {
      this.removePlayerUsageHook();
    });

    const attachTechUsageHook = (): void => {
      const nextTechTarget = this.getPlayerTechEventTarget();
      if (!nextTechTarget) {
        return;
      }

      if (this.usageTechTarget === nextTechTarget && this.usageTechHandler) {
        return;
      }

      this.removeTechUsageHook();

      const techUsageHandler = (event: VideoJsUsageEvent): void => {
        this.captureVhsUsageTelemetry(event, "tech");
      };

      nextTechTarget.on("usage", techUsageHandler);
      this.usageTechTarget = nextTechTarget;
      this.usageTechHandler = techUsageHandler;
    };

    this.bindPlayerEvent("techchange", () => {
      attachTechUsageHook();
    });
    this.bindPlayerEvent("loadedmetadata", () => {
      attachTechUsageHook();
    });
    this.player.ready(() => {
      attachTechUsageHook();
    });
  }

  private getPlayerTechEventTarget(): VideoJsEventTarget | null {
    const tech = this.player.tech(true) as unknown as VideoJsEventTarget | null;
    if (!tech || typeof tech.on !== "function") {
      return null;
    }
    return tech;
  }

  private removePlayerUsageHook(): void {
    if (!this.usagePlayerHandler) {
      return;
    }

    const playerEventTarget = this.player as unknown as VideoJsEventTarget;
    if (typeof playerEventTarget.off === "function") {
      playerEventTarget.off("usage", this.usagePlayerHandler);
    }
    this.usagePlayerHandler = null;
  }

  private removeTechUsageHook(): void {
    if (!this.usageTechTarget || !this.usageTechHandler) {
      return;
    }

    if (typeof this.usageTechTarget.off === "function") {
      this.usageTechTarget.off("usage", this.usageTechHandler);
    }
    this.usageTechTarget = null;
    this.usageTechHandler = null;
  }

  private installVhsQualityLevelHooks(): void {
    const attachQualityLevelHooks = (): void => {
      const nextQualityLevelList = this.getPlayerQualityLevelList();
      if (!nextQualityLevelList) {
        return;
      }

      if (
        this.qualityLevelList === nextQualityLevelList &&
        this.qualityLevelChangeHandler &&
        this.qualityLevelAddHandler
      ) {
        return;
      }

      this.removeQualityLevelHooks();

      const changeHandler = (event: VideoJsQualityLevelEvent): void => {
        this.captureVhsQualityLevelTelemetry("change", event);
      };
      const addHandler = (event: VideoJsQualityLevelEvent): void => {
        this.captureVhsQualityLevelTelemetry("addqualitylevel", event);
      };

      nextQualityLevelList.on("change", changeHandler);
      nextQualityLevelList.on("addqualitylevel", addHandler);
      this.qualityLevelList = nextQualityLevelList;
      this.qualityLevelChangeHandler = changeHandler;
      this.qualityLevelAddHandler = addHandler;
      if (this.representationQuarantineResetPending) {
        this.clearRepresentationQuarantine();
      } else {
        this.reconcileRepresentationQuarantine();
      }

      this.captureVhsQualityLevelTelemetry("snapshot");
    };

    this.bindPlayerEvent("loadedmetadata", () => {
      attachQualityLevelHooks();
    });
    this.bindPlayerEvent("techchange", () => {
      attachQualityLevelHooks();
    });
    this.player.ready(() => {
      attachQualityLevelHooks();
    });
  }

  private getPlayerQualityLevelList(): VideoJsQualityLevelList | null {
    const playerWithQualityLevels =
      this.player as unknown as VideoJsPlayerWithQualityLevels;

    if (typeof playerWithQualityLevels.qualityLevels !== "function") {
      return null;
    }

    const qualityLevels = playerWithQualityLevels.qualityLevels();
    if (!qualityLevels || typeof qualityLevels.on !== "function") {
      return null;
    }
    return qualityLevels;
  }

  private removeQualityLevelHooks(): void {
    if (!this.qualityLevelList) {
      return;
    }

    if (
      this.qualityLevelChangeHandler &&
      typeof this.qualityLevelList.off === "function"
    ) {
      this.qualityLevelList.off("change", this.qualityLevelChangeHandler);
    }
    if (
      this.qualityLevelAddHandler &&
      typeof this.qualityLevelList.off === "function"
    ) {
      this.qualityLevelList.off("addqualitylevel", this.qualityLevelAddHandler);
    }

    this.qualityLevelList = null;
    this.qualityLevelChangeHandler = null;
    this.qualityLevelAddHandler = null;
  }

  private reconcileRepresentationQuarantine(
    nowMs: number = Date.now(),
  ): {
    selectedRepresentationId: string | null;
    enabledRepresentationCount: number;
    totalRepresentationCount: number;
    allRepresentationsUnhealthy: boolean;
  } {
    this.pruneExpiredRepresentationQuarantine(nowMs);

    const levels = this.qualityLevelList;
    if (!levels || levels.length <= 0) {
      return {
        selectedRepresentationId: null,
        enabledRepresentationCount: 0,
        totalRepresentationCount: 0,
        allRepresentationsUnhealthy: false,
      };
    }

    const allRepresentationIds = new Set<string>();
    const healthyRepresentationIds = new Set<string>();
    const quarantinedRepresentationIds = new Set<string>();

    for (let index = 0; index < levels.length; index += 1) {
      const levelRepresentationId = this.resolveQualityLevelRepresentationId(
        levels[index],
      );
      if (!levelRepresentationId) {
        continue;
      }
      allRepresentationIds.add(levelRepresentationId);
      const quarantineUntilMs =
        this.representationQuarantineUntilMs.get(levelRepresentationId) ?? 0;
      if (quarantineUntilMs > nowMs) {
        quarantinedRepresentationIds.add(levelRepresentationId);
      } else {
        healthyRepresentationIds.add(levelRepresentationId);
      }
    }

    const totalRepresentationCount = allRepresentationIds.size;
    const allRepresentationsUnhealthy =
      totalRepresentationCount > 0 &&
      healthyRepresentationIds.size === 0 &&
      quarantinedRepresentationIds.size > 0;
    const enabledRepresentationCount = allRepresentationsUnhealthy
      ? totalRepresentationCount
      : healthyRepresentationIds.size;

    for (let index = 0; index < levels.length; index += 1) {
      const level = levels[index];
      const levelRepresentationId = this.resolveQualityLevelRepresentationId(level);
      if (!levelRepresentationId) {
        continue;
      }
      const shouldEnable =
        allRepresentationsUnhealthy ||
        !quarantinedRepresentationIds.has(levelRepresentationId);
      const didApply = this.setQualityLevelEnabled(level, shouldEnable);
      if (!didApply && !shouldEnable) {
        sharedFrontendLogger.warn(
          "[VideoJsSegmentedEngine] Quarantine disable failed for representation",
          { representationId: levelRepresentationId, shouldEnable },
        );
      }
    }

    return {
      selectedRepresentationId: this.getSelectedRepresentationId(levels),
      enabledRepresentationCount,
      totalRepresentationCount,
      allRepresentationsUnhealthy,
    };
  }

  private pruneExpiredRepresentationQuarantine(nowMs: number): void {
    const idsToClear: string[] = [];
    this.representationQuarantineUntilMs.forEach((untilMs, representationId) => {
      if (untilMs > nowMs) {
        return;
      }
      idsToClear.push(representationId);
    });

    if (idsToClear.length === 0) {
      return;
    }

    for (const representationId of idsToClear) {
      this.representationQuarantineUntilMs.delete(representationId);
      const timeout = this.representationQuarantineTimers.get(representationId);
      if (timeout) {
        clearTimeout(timeout);
        this.representationQuarantineTimers.delete(representationId);
      }
    }
  }

  private scheduleRepresentationReenable(
    representationId: string,
    cooldownMs: number,
  ): void {
    const existingTimeout =
      this.representationQuarantineTimers.get(representationId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.representationQuarantineTimers.delete(representationId);
    }

    if (cooldownMs <= 0) {
      this.reconcileRepresentationQuarantine();
      return;
    }

    const timeout = setTimeout(() => {
      this.representationQuarantineTimers.delete(representationId);
      const nowMs = Date.now();
      const hadRepresentation =
        this.representationQuarantineUntilMs.delete(representationId);
      const snapshot = this.reconcileRepresentationQuarantine(nowMs);
      if (!hadRepresentation) {
        return;
      }
      sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
        event: "player.representation_reenabled",
        timestamp: new Date(nowMs).toISOString(),
        trackId: this.lastSource?.trackId ?? null,
        sessionId: this.lastSource?.sessionId ?? null,
        sourceType: this.lastSource?.sourceType ?? "unknown",
        representationId,
        enabledRepresentationCount: snapshot.enabledRepresentationCount,
        totalRepresentationCount: snapshot.totalRepresentationCount,
      });
    }, cooldownMs);
    this.representationQuarantineTimers.set(representationId, timeout);
  }

  private normalizeRepresentationId(value: string): string | null {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private resolveQualityLevelRepresentationId(
    level: VideoJsQualityLevel | null | undefined,
  ): string | null {
    if (!level || typeof level.id !== "string") {
      return null;
    }
    return this.normalizeRepresentationId(level.id);
  }

  private getSelectedRepresentationId(
    levels: VideoJsQualityLevelList | null | undefined,
  ): string | null {
    if (!levels || !isFiniteNumber(levels.selectedIndex)) {
      return null;
    }
    const index = levels.selectedIndex;
    if (index < 0 || index >= levels.length) {
      return null;
    }
    return this.resolveQualityLevelRepresentationId(levels[index]);
  }

  private setQualityLevelEnabled(
    level: VideoJsQualityLevel,
    shouldEnable: boolean,
  ): boolean {
    const levelId = this.resolveQualityLevelRepresentationId(level);
    if (typeof level.enabled === "function") {
      try {
        level.enabled(shouldEnable);
        return true;
      } catch (err) {
        sharedFrontendLogger.warn(
          "[VideoJsSegmentedEngine] setQualityLevelEnabled failed",
          { shouldEnable, levelId, err },
        );
        return false;
      }
    }

    if (typeof level.enabled === "boolean") {
      try {
        level.enabled = shouldEnable;
        return true;
      } catch (err) {
        sharedFrontendLogger.warn(
          "[VideoJsSegmentedEngine] setQualityLevelEnabled failed",
          { shouldEnable, levelId, err },
        );
        return false;
      }
    }

    try {
      (
        level as unknown as {
          enabled?: boolean;
        }
      ).enabled = shouldEnable;
      return true;
    } catch (err) {
      sharedFrontendLogger.warn(
        "[VideoJsSegmentedEngine] setQualityLevelEnabled failed",
        { shouldEnable, levelId, err },
      );
      return false;
    }
  }

  private resetDashUnknownLiveStateTracking(): void {
    this.dashUnknownLiveStateSourceKey = null;
    this.dashUnknownLiveStateObservedAtMs = null;
    this.dashUnknownLiveStateProgressSampleCount = 0;
  }

  private maybeApplyVodFullTrackBufferControls(
    sourceKey: string,
    reason: string,
  ): void {
    if (this.runtimeVhsBufferControlsOverridden) {
      return;
    }
    if (this.vodFullTrackBufferAppliedForSourceKey === sourceKey) {
      return;
    }

    const durationSec = this.player.duration();
    if (!isFiniteNumber(durationSec) || durationSec <= 0) {
      return;
    }

    const goalBufferSec = Math.max(
      DEFAULT_SEGMENTED_VHS_GOAL_BUFFER_SEC,
      Math.min(
        DASH_VOD_FULL_TRACK_BUFFER_MAX_SEC,
        Math.ceil(durationSec + DASH_VOD_FULL_TRACK_BUFFER_PADDING_SEC),
      ),
    );
    const maxGoalBufferSec = goalBufferSec;
    const bufferLowWaterLineSec = Math.min(
      goalBufferSec,
      DEFAULT_SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC,
    );
    const maxBufferLowWaterLineSec = Math.min(
      goalBufferSec,
      Math.max(
        bufferLowWaterLineSec,
        DEFAULT_SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC,
      ),
    );

    this.applyVhsBufferControls(
      "vod_full_track",
      reason,
      {
        GOAL_BUFFER_LENGTH: goalBufferSec,
        MAX_GOAL_BUFFER_LENGTH: maxGoalBufferSec,
        BUFFER_LOW_WATER_LINE: bufferLowWaterLineSec,
        MAX_BUFFER_LOW_WATER_LINE: maxBufferLowWaterLineSec,
      },
      {
        trackDurationSec: durationSec,
        fullTrackBufferPaddingSec: DASH_VOD_FULL_TRACK_BUFFER_PADDING_SEC,
        fullTrackBufferCapSec: DASH_VOD_FULL_TRACK_BUFFER_MAX_SEC,
      },
    );
    this.vodFullTrackBufferAppliedForSourceKey = sourceKey;
  }

  private reconcileDashStartupLatencyTuning(
    trigger: DashStartupReconciliationTrigger,
  ): void {
    const source = this.lastSource;
    if (!source || source.protocol !== "dash") {
      this.startupBufferTuningPendingForSourceKey = null;
      this.resetDashUnknownLiveStateTracking();
      return;
    }

    const sourceKey = this.getUsageEventSourceKey(source);
    if (this.startupBufferTuningPendingForSourceKey !== sourceKey) {
      this.resetDashUnknownLiveStateTracking();
      return;
    }

    const liveState = this.resolveDashLiveState();
    if (liveState === "unknown") {
      const nowMs = Date.now();
      if (this.dashUnknownLiveStateSourceKey !== sourceKey) {
        this.dashUnknownLiveStateSourceKey = sourceKey;
        this.dashUnknownLiveStateObservedAtMs = nowMs;
        this.dashUnknownLiveStateProgressSampleCount = 0;
      }
      if (trigger === "timeupdate") {
        const currentTimeSec = this.getCurrentTime();
        if (
          isFiniteNumber(currentTimeSec) &&
          currentTimeSec >= DASH_UNKNOWN_LIVE_STATE_PROGRESS_SAMPLE_MIN_TIME_SEC
        ) {
          this.dashUnknownLiveStateProgressSampleCount += 1;
        }
      }

      const observedAtMs = this.dashUnknownLiveStateObservedAtMs ?? nowMs;
      const unknownElapsedMs = Math.max(0, nowMs - observedAtMs);
      const shouldFallbackToSteadyState =
        this.dashUnknownLiveStateProgressSampleCount >=
          DASH_UNKNOWN_LIVE_STATE_PROGRESS_SAMPLE_THRESHOLD ||
        unknownElapsedMs >= DASH_UNKNOWN_LIVE_STATE_FALLBACK_MAX_MS;
      if (!shouldFallbackToSteadyState) {
        return;
      }

      this.startupBufferTuningPendingForSourceKey = null;
      this.resetDashUnknownLiveStateTracking();
      this.applyVhsBufferControls(
        "steady_state",
        "dash_vod_unknown_live_state_fallback",
      );
      return;
    }

    this.resetDashUnknownLiveStateTracking();
    this.startupBufferTuningPendingForSourceKey = null;

    if (liveState === "live") {
      this.maybeApplyDashJsLowLiveDelayTarget(sourceKey);
      return;
    }

    this.maybeApplyVodFullTrackBufferControls(sourceKey, "dash_vod_full_track");
    if (this.vodFullTrackBufferAppliedForSourceKey !== sourceKey) {
      this.applyVhsBufferControls("steady_state", "dash_vod_after_startup");
    }
  }

  private resolveDashLiveState(): DashLiveState {
    const vhsState = this.resolveDashLiveStateFromVhsPlaylist();
    if (vhsState !== null) {
      return vhsState;
    }

    const durationSec = this.player.duration();
    if (durationSec === Number.POSITIVE_INFINITY) {
      return "live";
    }
    if (isFiniteNumber(durationSec) && durationSec > 0) {
      return "vod";
    }
    return "unknown";
  }

  private resolveDashLiveStateFromVhsPlaylist(): DashLiveState | null {
    const tech = this.player.tech(true) as unknown as {
      vhs?: VideoJsVhsRuntimeTech;
    } | null;

    const mediaPlaylist = tech?.vhs?.playlists?.media?.();
    if (!mediaPlaylist || typeof mediaPlaylist.endList !== "boolean") {
      return null;
    }
    return mediaPlaylist.endList ? "vod" : "live";
  }

  private maybeApplyDashJsLowLiveDelayTarget(sourceKey: string): void {
    if (this.dashJsLiveDelayEvaluatedForSourceKey === sourceKey) {
      return;
    }
    this.dashJsLiveDelayEvaluatedForSourceKey = sourceKey;

    const mediaPlayer = this.getDashJsMediaPlayer();
    if (!mediaPlayer || typeof mediaPlayer.updateSettings !== "function") {
      sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
        event: "player.dashjs_live_delay_target_unavailable",
        timestamp: new Date().toISOString(),
        targetLiveDelaySec: DASHJS_LIVE_DELAY_TARGET_SEC,
        reason: "dashjs_runtime_not_detected",
      });
      return;
    }

    try {
      mediaPlayer.updateSettings({
        streaming: {
          delay: {
            liveDelay: DASHJS_LIVE_DELAY_TARGET_SEC,
          },
        },
      });
      sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
        event: "player.dashjs_live_delay_target_applied",
        timestamp: new Date().toISOString(),
        targetLiveDelaySec: DASHJS_LIVE_DELAY_TARGET_SEC,
      });
    } catch (error) {
      sharedFrontendLogger.warn(
        "[VideoJsSegmentedEngine] Failed to apply dash.js live delay target.",
        error,
      );
    }
  }

  private getDashJsMediaPlayer(): VideoJsDashMediaPlayer | null {
    const tech = this.player.tech(true) as unknown as VideoJsDashRuntimeTech | null;
    if (!tech) {
      return null;
    }

    const candidates = [
      tech.dash?.mediaPlayer,
      tech.dash?.mediaPlayer_,
      tech.mediaPlayer,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate.updateSettings === "function") {
        return candidate;
      }
    }
    return null;
  }

  private bindPlayerEvents(): void {
    this.bindPlayerEvent("loadedmetadata", () => {
      this.reconcileDashStartupLatencyTuning("loadedmetadata");
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

    this.bindPlayerEvent("durationchange", () => {
      this.reconcileDashStartupLatencyTuning("durationchange");
    });

    this.bindPlayerEvent("timeupdate", () => {
      this.reconcileDashStartupLatencyTuning("timeupdate");
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

  private captureVhsResponseTelemetry(
    request: VideoJsResponseHookRequest,
    error: unknown,
    response: VideoJsResponseHookResponse,
  ): void {
    const source = this.lastSource;
    if (!source || source.protocol !== "dash") {
      return;
    }

    const requestUri = request.uri ?? "";
    const kind = this.classifyVhsRequestKind(requestUri, request.requestType);
    const statusCode = this.resolveStatusCode(request, response);
    const hasError = Boolean(error) || (isFiniteNumber(statusCode) && statusCode >= 400);
    const representationId = resolveSegmentRepresentationIdFromUri(requestUri);
    const sourceKey = this.getUsageEventSourceKey(source);
    const sanitizedUri = this.sanitizeUri(requestUri);

    this.updateManifestStallDetectionState(
      kind,
      hasError,
      source,
      sourceKey,
      sanitizedUri,
    );

    if (!this.shouldEmitVhsMetric(kind, hasError)) {
      return;
    }

    const nowMs = Date.now();
    const requestStartedAtMs = isFiniteNumber(request.requestTime)
      ? request.requestTime
      : null;
    const roundTripMs = isFiniteNumber(request.roundTripTime)
      ? request.roundTripTime
      : requestStartedAtMs !== null
        ? Math.max(0, nowMs - requestStartedAtMs)
        : null;
    const bytesReceived = isFiniteNumber(request.bytesReceived)
      ? request.bytesReceived
      : null;
    const estimatedBandwidthbps =
      isFiniteNumber(request.bandwidth) && request.bandwidth > 0
        ? request.bandwidth
        : bytesReceived !== null &&
            roundTripMs !== null &&
            roundTripMs > 0
          ? Math.floor((bytesReceived / roundTripMs) * 8000)
          : null;
    const vhs = this.getVhsRuntimeStatsSnapshot();
    const normalizedSourceType = this.resolveNormalizedSourceType(source);
    const fields: Record<string, unknown> = {
      kind,
      requestType: request.requestType ?? null,
      uri: sanitizedUri,
      representationId,
      statusCode,
      hasError,
      roundTripMs,
      bytesReceived,
      estimatedBandwidthbps,
      sourceType: normalizedSourceType,
      sessionId: source.sessionId ?? null,
      trackId: source.trackId ?? null,
      vhsBandwidth: vhs.bandwidth ?? null,
      vhsThroughput: vhs.throughput ?? null,
      vhsSystemBandwidth: vhs.systemBandwidth ?? null,
      vhsStatsBandwidth: vhs.statsBandwidth ?? null,
      vhsMediaRequests: vhs.mediaRequests ?? null,
      vhsMediaRequestsErrored: vhs.mediaRequestsErrored ?? null,
      vhsMediaRequestsTimedout: vhs.mediaRequestsTimedout ?? null,
      vhsMediaRequestsAborted: vhs.mediaRequestsAborted ?? null,
      vhsMediaTransferDurationMs: vhs.mediaTransferDurationMs ?? null,
      vhsMediaBytesTransferred: vhs.mediaBytesTransferred ?? null,
      vhsMediaSecondsLoaded: vhs.mediaSecondsLoaded ?? null,
      vhsStatsTimestamp: vhs.statsTimestamp ?? null,
      error:
        error instanceof Error
          ? error.message
          : error
            ? String(error)
            : null,
    };

    this.emit("vhsresponse", {
      kind,
      uri: sanitizedUri,
      representationId,
      statusCode,
      hasError,
      roundTripMs,
      bytesReceived,
      sourceType: normalizedSourceType,
      sessionId: source.sessionId ?? null,
      trackId: source.trackId ?? null,
      timestampMs: nowMs,
    });

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.vhs_response",
      timestamp: new Date(nowMs).toISOString(),
      ...fields,
    });
  }

  private captureVhsUsageTelemetry(
    event: VideoJsUsageEvent,
    emitter: "player" | "tech",
  ): void {
    const source = this.lastSource;
    if (!source || source.protocol !== "dash") {
      return;
    }

    const usageName = this.resolveUsageEventName(event);
    if (!usageName || !VHS_HIGH_SIGNAL_USAGE_EVENTS.has(usageName)) {
      return;
    }

    this.resetUsageEventCountersIfNeeded(source);
    const nextCount = (this.usageEventCounts.get(usageName) ?? 0) + 1;
    this.usageEventCounts.set(usageName, nextCount);
    if (nextCount > VHS_USAGE_EVENT_MAX_PER_NAME) {
      return;
    }

    const nowMs = Date.now();
    const vhs = this.getVhsRuntimeStatsSnapshot();

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.vhs_usage",
      timestamp: new Date(nowMs).toISOString(),
      usageName,
      usageEmitter: emitter,
      occurrence: nextCount,
      maxOccurrencesPerTrack: VHS_USAGE_EVENT_MAX_PER_NAME,
      sourceType: source.sourceType ?? "unknown",
      sessionId: source.sessionId ?? null,
      trackId: source.trackId ?? null,
      currentTimeSec: this.getCurrentTime(),
      bufferedAheadSec: this.getBufferedAheadSec(),
      isPlaying: this.isPlaying(),
      isSeeking: this.isSeeking,
      vhsBandwidth: vhs.bandwidth ?? null,
      vhsThroughput: vhs.throughput ?? null,
      vhsSystemBandwidth: vhs.systemBandwidth ?? null,
      vhsStatsBandwidth: vhs.statsBandwidth ?? null,
      vhsMediaRequests: vhs.mediaRequests ?? null,
      vhsMediaRequestsErrored: vhs.mediaRequestsErrored ?? null,
      vhsMediaRequestsTimedout: vhs.mediaRequestsTimedout ?? null,
      vhsMediaRequestsAborted: vhs.mediaRequestsAborted ?? null,
      vhsMediaTransferDurationMs: vhs.mediaTransferDurationMs ?? null,
      vhsMediaBytesTransferred: vhs.mediaBytesTransferred ?? null,
      vhsMediaSecondsLoaded: vhs.mediaSecondsLoaded ?? null,
      vhsStatsTimestamp: vhs.statsTimestamp ?? null,
    });
  }

  private captureVhsQualityLevelTelemetry(
    reason: "change" | "addqualitylevel" | "snapshot",
    event?: VideoJsQualityLevelEvent,
  ): void {
    const source = this.lastSource;
    if (!source || source.protocol !== "dash") {
      return;
    }

    this.resetUsageEventCountersIfNeeded(source);
    this.emitVhsAbrPolicyTelemetry(source);

    const nextCount = this.qualityEventCount + 1;
    this.qualityEventCount = nextCount;
    if (nextCount > VHS_QUALITY_EVENT_MAX_PER_SOURCE) {
      return;
    }

    const snapshot = this.getQualityLevelsSnapshot();
    const eventQualityLevel = event?.qualityLevel;
    const nowMs = Date.now();
    const vhs = this.getVhsRuntimeStatsSnapshot();

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.vhs_quality_levels",
      timestamp: new Date(nowMs).toISOString(),
      reason,
      occurrence: nextCount,
      maxOccurrencesPerTrack: VHS_QUALITY_EVENT_MAX_PER_SOURCE,
      sourceType: source.sourceType ?? "unknown",
      sessionId: source.sessionId ?? null,
      trackId: source.trackId ?? null,
      levelsCount: snapshot.levelsCount,
      selectedIndex: snapshot.selectedIndex,
      enabledLevelsCount: snapshot.enabledLevelsCount,
      disabledLevelsCount: snapshot.disabledLevelsCount,
      availableBitratesbps: snapshot.availableBitratesbps,
      selectedBitratebps: snapshot.selectedBitratebps,
      eventBitratebps: isFiniteNumber(eventQualityLevel?.bitrate)
        ? eventQualityLevel?.bitrate
        : null,
      eventWidth: isFiniteNumber(eventQualityLevel?.width)
        ? eventQualityLevel?.width
        : null,
      eventHeight: isFiniteNumber(eventQualityLevel?.height)
        ? eventQualityLevel?.height
        : null,
      eventLevelId:
        typeof eventQualityLevel?.id === "string" ? eventQualityLevel.id : null,
      vhsBandwidth: vhs.bandwidth ?? null,
      vhsThroughput: vhs.throughput ?? null,
    });
  }

  private emitVhsAbrPolicyTelemetry(source: AudioEngineSource): void {
    const sourceKey = this.getUsageEventSourceKey(source);
    if (this.qualityPolicyLoggedSourceKey === sourceKey) {
      return;
    }
    this.qualityPolicyLoggedSourceKey = sourceKey;

    const snapshot = this.getQualityLevelsSnapshot();

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.vhs_quality_policy",
      timestamp: new Date().toISOString(),
      sourceType: source.sourceType ?? "unknown",
      sessionId: source.sessionId ?? null,
      trackId: source.trackId ?? null,
      abrMode: VHS_ABR_POLICY_MODE,
      manualPinning: VHS_ABR_POLICY_MANUAL_PINNING,
      selectionAuthority: VHS_ABR_POLICY_SELECTION_AUTHORITY,
      vhsProfile: this.segmentedVhsProfile,
      audioModeStrategy: this.audioModeStrategy,
      vhsStartupOptions: this.vhsInitializationOptions,
      levelsCount: snapshot.levelsCount,
      selectedIndex: snapshot.selectedIndex,
      selectedBitratebps: snapshot.selectedBitratebps,
      availableBitratesbps: snapshot.availableBitratesbps,
    });
  }

  private getQualityLevelsSnapshot(): {
    levelsCount: number;
    selectedIndex: number | null;
    enabledLevelsCount: number | null;
    disabledLevelsCount: number | null;
    availableBitratesbps: number[];
    selectedBitratebps: number | null;
  } {
    const levels = this.qualityLevelList;
    if (!levels) {
      return {
        levelsCount: 0,
        selectedIndex: null,
        enabledLevelsCount: null,
        disabledLevelsCount: null,
        availableBitratesbps: [],
        selectedBitratebps: null,
      };
    }

    const availableBitrates: number[] = [];
    let enabledLevelsCount = 0;
    let disabledLevelsCount = 0;
    for (let index = 0; index < levels.length; index += 1) {
      const level = levels[index];
      if (isFiniteNumber(level?.bitrate)) {
        availableBitrates.push(level.bitrate);
      }
      if (typeof level?.enabled === "boolean") {
        if (level.enabled) {
          enabledLevelsCount += 1;
        } else {
          disabledLevelsCount += 1;
        }
      }
    }

    const selectedIndex = isFiniteNumber(levels.selectedIndex)
      ? levels.selectedIndex
      : null;
    const selectedLevel =
      selectedIndex !== null && selectedIndex >= 0 && selectedIndex < levels.length
        ? levels[selectedIndex]
        : null;
    const selectedBitrate = isFiniteNumber(selectedLevel?.bitrate)
      ? selectedLevel?.bitrate
      : null;

    return {
      levelsCount: levels.length,
      selectedIndex,
      enabledLevelsCount:
        enabledLevelsCount > 0 || disabledLevelsCount > 0
          ? enabledLevelsCount
          : null,
      disabledLevelsCount:
        enabledLevelsCount > 0 || disabledLevelsCount > 0
          ? disabledLevelsCount
          : null,
      availableBitratesbps: availableBitrates,
      selectedBitratebps: selectedBitrate,
    };
  }

  private resolveUsageEventName(event: VideoJsUsageEvent): string | null {
    if (typeof event.name !== "string") {
      return null;
    }
    const normalized = event.name.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private resetUsageEventCountersIfNeeded(source: AudioEngineSource): void {
    const nextSourceKey = this.getUsageEventSourceKey(source);
    if (this.usageEventSourceKey === nextSourceKey) {
      return;
    }

    this.usageEventSourceKey = nextSourceKey;
    this.usageEventCounts.clear();
    this.qualityEventCount = 0;
    this.qualityPolicyLoggedSourceKey = null;
  }

  private getUsageEventSourceKey(source: AudioEngineSource): string {
    return [
      source.protocol ?? "",
      source.sourceType ?? "",
      source.sessionId ?? "",
      source.trackId ?? "",
      source.url,
    ].join("|");
  }

  private getBufferedAheadSec(): number | null {
    const currentTimeSec = this.getCurrentTime();
    const { buffered } = this.mediaElement;
    if (!buffered || buffered.length === 0) {
      return null;
    }

    for (let index = 0; index < buffered.length; index += 1) {
      const rangeStart = buffered.start(index);
      const rangeEnd = buffered.end(index);

      if (currentTimeSec >= rangeStart && currentTimeSec <= rangeEnd) {
        return Math.max(0, rangeEnd - currentTimeSec);
      }
      if (rangeStart > currentTimeSec) {
        return Math.max(0, rangeStart - currentTimeSec);
      }
    }

    return 0;
  }

  private classifyVhsRequestKind(
    uri: string,
    requestType?: string,
  ): VhsRequestKind {
    const normalizedRequestType = requestType?.trim().toLowerCase() ?? "";
    if (normalizedRequestType.includes("manifest")) {
      return "manifest";
    }
    if (normalizedRequestType.includes("segment")) {
      return "segment";
    }

    const normalizedUri = uri.trim().toLowerCase();
    if (normalizedUri.endsWith(".mpd")) {
      return "manifest";
    }
    if (normalizedUri.includes("init-") || normalizedUri.includes("/init")) {
      return "init";
    }
    if (
      normalizedUri.endsWith(".m4s") ||
      normalizedUri.includes("chunk-") ||
      normalizedUri.includes("/segments/")
    ) {
      return "segment";
    }
    return "other";
  }

  private resetManifestStallDetection(nextSource?: AudioEngineSource): void {
    this.clearManifestStallDetectionTimer();
    this.manifestStallDetectionSourceKey = nextSource
      ? this.getUsageEventSourceKey(nextSource)
      : null;
    this.manifestStallDetectionSegmentSeen = false;
    this.manifestStallDetectionEventEmitted = false;
  }

  private clearManifestStallDetectionTimer(): void {
    if (!this.manifestStallDetectionTimer) {
      return;
    }
    clearTimeout(this.manifestStallDetectionTimer);
    this.manifestStallDetectionTimer = null;
  }

  private updateManifestStallDetectionState(
    kind: VhsRequestKind,
    hasError: boolean,
    source: AudioEngineSource,
    sourceKey: string,
    manifestUri: string,
  ): void {
    if (this.manifestStallDetectionSourceKey !== sourceKey) {
      return;
    }

    if (kind === "segment") {
      this.manifestStallDetectionSegmentSeen = true;
      this.clearManifestStallDetectionTimer();
      return;
    }

    if (
      kind !== "manifest" ||
      hasError ||
      this.manifestStallDetectionSegmentSeen ||
      this.manifestStallDetectionEventEmitted
    ) {
      return;
    }

    this.clearManifestStallDetectionTimer();
    this.manifestStallDetectionTimer = setTimeout(() => {
      this.manifestStallDetectionTimer = null;

      if (this.manifestStallDetectionSourceKey !== sourceKey) {
        return;
      }
      if (
        this.manifestStallDetectionSegmentSeen ||
        this.manifestStallDetectionEventEmitted
      ) {
        return;
      }

      this.manifestStallDetectionEventEmitted = true;
      this.emitManifestStall(source, manifestUri);
    }, DASH_MANIFEST_SEGMENT_STALL_TIMEOUT_MS);
  }

  private emitManifestStall(
    source: AudioEngineSource,
    manifestUri: string,
  ): void {
    const nowMs = Date.now();
    const sourceType = this.resolveNormalizedSourceType(source);
    const payload: AudioEngineManifestStallPayload = {
      trackId: source.trackId ?? null,
      sessionId: source.sessionId ?? null,
      reason: MANIFEST_STALL_REASON_PLAYLIST_REFRESH_TIMEOUT,
      timeoutMs: DASH_MANIFEST_SEGMENT_STALL_TIMEOUT_MS,
      manifestUri: manifestUri || null,
      sourceType,
      timestampMs: nowMs,
    };

    this.emit("manifeststall", payload);
    this.emit("manifest-stall", payload);

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
      event: "player.manifest_stall",
      timestamp: new Date(nowMs).toISOString(),
      reason: payload.reason,
      timeoutMs: payload.timeoutMs,
      manifestUri: payload.manifestUri,
      sourceType: payload.sourceType,
      sessionId: payload.sessionId,
      trackId: payload.trackId,
    });
  }

  private resolveNormalizedSourceType(
    source: AudioEngineSource | null | undefined,
  ): "local" | "tidal" | "ytmusic" | "unknown" {
    return source?.sourceType === "local" ||
      source?.sourceType === "tidal" ||
      source?.sourceType === "ytmusic"
      ? source.sourceType
      : "unknown";
  }

  private shouldEmitVhsMetric(kind: VhsRequestKind, hasError: boolean): boolean {
    if (hasError || kind === "manifest" || kind === "init") {
      return true;
    }

    if (kind === "segment") {
      this.segmentResponseCount += 1;
      return (
        this.segmentResponseCount === 1 ||
        this.segmentResponseCount % VHS_SEGMENT_SAMPLE_EVERY === 0
      );
    }

    return false;
  }

  private resolveStatusCode(
    request: VideoJsResponseHookRequest,
    response: VideoJsResponseHookResponse,
  ): number | null {
    if (isFiniteNumber(response.statusCode)) {
      return response.statusCode;
    }
    if (isFiniteNumber(request.statusCode)) {
      return request.statusCode;
    }
    return null;
  }

  private sanitizeUri(uri: string): string {
    if (!uri) {
      return "";
    }

    try {
      const parsed = new URL(uri, window.location.origin);
      parsed.searchParams.delete("st");
      return parsed.pathname;
    } catch {
      const [pathOnly] = uri.split("?");
      return pathOnly;
    }
  }

  private getVhsRuntimeStatsSnapshot(): VideoJsVhsStatsSnapshot {
    const tech = this.player.tech(true) as unknown as {
      vhs?: {
        bandwidth?: number;
        throughput?: number;
        systemBandwidth?: number;
        stats?: {
          bandwidth?: number;
          mediaRequests?: number;
          mediaRequestsErrored?: number;
          mediaRequestsTimedout?: number;
          mediaRequestsAborted?: number;
          mediaTransferDuration?: number;
          mediaBytesTransferred?: number;
          mediaSecondsLoaded?: number;
          timestamp?: number;
        };
      };
    } | null;

    const vhs = tech?.vhs;
    if (!vhs) {
      return {};
    }

    return {
      bandwidth: isFiniteNumber(vhs.bandwidth) ? vhs.bandwidth : undefined,
      throughput: isFiniteNumber(vhs.throughput) ? vhs.throughput : undefined,
      systemBandwidth: isFiniteNumber(vhs.systemBandwidth)
        ? vhs.systemBandwidth
        : undefined,
      statsBandwidth: isFiniteNumber(vhs.stats?.bandwidth)
        ? vhs.stats?.bandwidth
        : undefined,
      mediaRequests: isFiniteNumber(vhs.stats?.mediaRequests)
        ? vhs.stats?.mediaRequests
        : undefined,
      mediaRequestsErrored: isFiniteNumber(vhs.stats?.mediaRequestsErrored)
        ? vhs.stats?.mediaRequestsErrored
        : undefined,
      mediaRequestsTimedout: isFiniteNumber(vhs.stats?.mediaRequestsTimedout)
        ? vhs.stats?.mediaRequestsTimedout
        : undefined,
      mediaRequestsAborted: isFiniteNumber(vhs.stats?.mediaRequestsAborted)
        ? vhs.stats?.mediaRequestsAborted
        : undefined,
      mediaTransferDurationMs: isFiniteNumber(vhs.stats?.mediaTransferDuration)
        ? vhs.stats?.mediaTransferDuration
        : undefined,
      mediaBytesTransferred: isFiniteNumber(vhs.stats?.mediaBytesTransferred)
        ? vhs.stats?.mediaBytesTransferred
        : undefined,
      mediaSecondsLoaded: isFiniteNumber(vhs.stats?.mediaSecondsLoaded)
        ? vhs.stats?.mediaSecondsLoaded
        : undefined,
      statsTimestamp: isFiniteNumber(vhs.stats?.timestamp)
        ? vhs.stats?.timestamp
        : undefined,
    };
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
