"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api, type SegmentedStreamingSessionResponse } from "@/lib/api";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";
import { resolveStreamingEngineMode } from "@/lib/audio-engine/engineMode";
import type {
    AudioEngineSource,
    AudioEngineVhsResponsePayload,
} from "@/lib/audio-engine/types";
import { resolveLocalAuthoritativeRecovery } from "@/lib/audio-engine/recoveryPolicy";
import {
    type ProactiveSegmentedHandoffSkipReason,
    resolveProactiveSegmentedHandoffEligibility,
    resolveSegmentedPrewarmMaxRetries,
} from "@/lib/audio-engine/segmentedStartupPolicy";
import {
    isSeekWithinTolerance,
    resolveStartupGuardedRecoveryPositionSec,
    resolveSegmentedStartupRetryDelayMs,
    resolveBufferingRecoveryAction,
    resolveTrustedTrackPositionSec,
    shouldRetrySegmentedStartupTimeout,
} from "@/lib/audio-engine/segmentedPlaybackRegressionPolicy";
import { audioSeekEmitter } from "@/lib/audio-seek-emitter";
import { dispatchQueryEvent } from "@/lib/query-events";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import { shouldAutoMatchVibeAtQueueEnd } from "./autoMatchVibePlayback";
import {
    createEmptySegmentedStartupRecoveryStageAttempts,
    resolveSegmentedStartupRecoveryDecision,
    type SegmentedStartupRecoveryStage,
    type SegmentedStartupRecoveryStageLimits,
    shouldAttemptSegmentedRecoveryOnUnexpectedPause,
} from "./audioPlaybackOrchestratorPolicy";
import {
    createMigratingStorageKey,
    PODCAST_DEBUG_STORAGE_KEY,
    readMigratingStorageItem,
} from "@/lib/storage-migration";
import {
    playbackStateMachine,
    HeartbeatMonitor,
} from "@/lib/audio";
import { useQueryClient } from "@tanstack/react-query";
import {
    fetchLyrics,
    lyricsQueryKeys,
    type LyricsLookupMetadata,
} from "@/hooks/useLyrics";
import { LYRICS_QUERY_STALE_TIME } from "@/lib/lyrics-cache-policy";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    memo,
    useCallback,
} from "react";
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    normalizeCanonicalMediaProviderIdentity,
    toAudioEngineSourceType,
    type CanonicalMediaProviderIdentity,
    type CanonicalMediaSource,
} from "@soundspan/media-metadata-contract";

interface RuntimeProviderTrack {
    mediaSource?: CanonicalMediaSource;
    provider?: CanonicalMediaProviderIdentity;
    streamSource?: "local" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
}

function getNextTrackInfo(
    queue: {
        id: string;
        filePath?: string;
        mediaSource?: CanonicalMediaSource;
        provider?: CanonicalMediaProviderIdentity;
        streamSource?: "local" | "tidal" | "youtube";
        tidalTrackId?: number;
        youtubeVideoId?: string;
    }[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: number[],
    repeatMode: "off" | "one" | "all"
): {
    id: string;
    filePath?: string;
    mediaSource?: CanonicalMediaSource;
    provider?: CanonicalMediaProviderIdentity;
    streamSource?: "local" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
} | null {
    if (queue.length === 0) return null;

    let nextIndex: number;
    if (isShuffle) {
        const currentShufflePos = shuffleIndices.indexOf(currentIndex);
        if (currentShufflePos < shuffleIndices.length - 1) {
            nextIndex = shuffleIndices[currentShufflePos + 1];
        } else if (repeatMode === "all") {
            nextIndex = shuffleIndices[0];
        } else {
            return null;
        }
    } else {
        if (currentIndex < queue.length - 1) {
            nextIndex = currentIndex + 1;
        } else if (repeatMode === "all") {
            nextIndex = 0;
        } else {
            return null;
        }
    }

    return queue[nextIndex] || null;
}

interface SegmentedTrackContext {
    sourceType: "local";
    sessionTrackId: string;
}

function resolveSegmentedTrackContext(
    track:
        | (RuntimeProviderTrack & {
            id: string;
        })
        | null
        | undefined,
): SegmentedTrackContext | null {
    if (!track) return null;

    // Segmented startup/handoff is local-only. Remote providers (TIDAL/YouTube)
    // always use direct proxy playback and must not create segmented sessions.
    const provider = normalizeCanonicalMediaProviderIdentity({
        mediaSource: track.mediaSource,
        providerTrackId: track.provider?.providerTrackId,
        tidalTrackId: track.provider?.tidalTrackId ?? track.tidalTrackId,
        youtubeVideoId:
            track.provider?.youtubeVideoId ?? track.youtubeVideoId,
        streamSource: track.streamSource,
    });
    if (provider.source !== "local") {
        return null;
    }

    return {
        sourceType: "local",
        sessionTrackId: track.id,
    };
}

function resolveDirectTrackSourceType(
    track: RuntimeProviderTrack
): "local" | "tidal" | "ytmusic" {
    const provider = normalizeCanonicalMediaProviderIdentity({
        mediaSource: track.mediaSource,
        providerTrackId: track.provider?.providerTrackId,
        tidalTrackId: track.provider?.tidalTrackId ?? track.tidalTrackId,
        youtubeVideoId:
            track.provider?.youtubeVideoId ?? track.youtubeVideoId,
        streamSource: track.streamSource,
    });
    return toAudioEngineSourceType(provider.source);
}

function logSegmentedClientMetric(
    event: string,
    fields: Record<string, unknown>,
): void {
    if (typeof window === "undefined") {
        return;
    }

    sharedFrontendLogger.info("[SegmentedStreaming][ClientMetric]", {
        event,
        timestamp: new Date().toISOString(),
        ...fields,
    });

    // Temporary high-signal beaconing to backend for live stall diagnostics.
    if (!SEGMENTED_CLIENT_SIGNAL_EVENTS.has(event)) {
        return;
    }

    void api
        .reportSegmentedStreamingClientMetric({
            event,
            fields,
        })
        .catch(() => undefined);
}

const SEGMENTED_CLIENT_SIGNAL_EVENTS = new Set<string>([
    "player.rebuffer",
    "player.rebuffer_timeout",
    "player.rebuffer_timeout_deferred",
    "player.rebuffer_recovered",
    "player.startup_timeline",
    "player.unexpected_stop",
    "player.unexpected_pause",
    "player.playback_error",
    "session.handoff_attempt",
    "session.handoff_failure",
    "session.handoff_proactive_failure",
    "session.handoff_load_error",
    "session.handoff_proactive_load_error",
]);

function podcastDebugEnabled(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            readMigratingStorageItem(PODCAST_DEBUG_STORAGE_KEY) === "1"
        );
    } catch {
        return false;
    }
}

function podcastDebugLog(message: string, data?: Record<string, unknown>) {
    if (!podcastDebugEnabled()) return;
    sharedFrontendLogger.info(`[PodcastDebug] ${message}`, data || {});
}

function isLikelyTransientStreamError(error: unknown): boolean {
    const message =
        (error instanceof Error ? error.message : String(error || ""))
            .toLowerCase()
            .trim();
    if (!message) return false;

    return (
        message.includes("network") ||
        message.includes("timeout") ||
        message.includes("aborted") ||
        message.includes("interrupted") ||
        message.includes("socket hang up") ||
        message.includes("connection reset") ||
        message.includes("failed to fetch") ||
        message.includes("media_err_network") ||
        message.includes("not ready") ||
        message.includes("being prepared") ||
        message.includes("temporarily unavailable") ||
        message.includes("source unavailable") ||
        message.includes("503") ||
        message.includes("502") ||
        message.includes("504")
    );
}

function isLosslessSegmentedSession(
    session: SegmentedStreamingSessionResponse,
): boolean {
    const sourceType =
        session.playbackProfile?.sourceType ?? session.engineHints?.sourceType;
    const codec = session.playbackProfile?.codec?.trim().toLowerCase();
    return sourceType === "local" && codec === "flac";
}

function supportsLosslessSegmentedPlayback(): boolean {
    if (typeof window === "undefined") {
        return false;
    }

    const mediaSourceCtor = (window as Window & {
        MediaSource?: {
            isTypeSupported?: (mimeType: string) => boolean;
        };
    }).MediaSource;

    if (typeof mediaSourceCtor?.isTypeSupported !== "function") {
        return false;
    }

    return (
        mediaSourceCtor.isTypeSupported('audio/mp4; codecs="fLaC"') ||
        mediaSourceCtor.isTypeSupported('audio/mp4; codecs="flac"')
    );
}

const CURRENT_TIME_KEY = createMigratingStorageKey("current_time");
const CURRENT_TIME_TRACK_ID_KEY = createMigratingStorageKey("current_time_track_id");
const AUDIO_LOAD_TIMEOUT_MS = 20_000;
const AUDIO_LOAD_TIMEOUT_ASSET_BUILD_INFLIGHT_MS = 40_000;
const AUDIO_LOAD_TIMEOUT_RETRIES = 1;
const AUDIO_LOAD_RETRY_DELAY_MS = 350;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_DEFAULT_MS = 5_000;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS = 1_500;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS = 15_000;
const SEGMENTED_STARTUP_ON_DEMAND_TIMEOUT_BONUS_MS = 4_000;
const SEGMENTED_STARTUP_RETRY_DELAY_MS = 900;
const SEGMENTED_STARTUP_RETRY_BACKOFF_MAX_MS = 6_000;
const SEGMENTED_STARTUP_RETRY_JITTER_RATIO = 0.35;
const SEGMENTED_STARTUP_RECOVERY_WINDOW_MS = 30_000;
const SEGMENTED_STARTUP_MAX_SESSION_RESETS = 1;
const SEGMENTED_STARTUP_STAGE_MAX_ATTEMPTS: SegmentedStartupRecoveryStageLimits =
    {
        session_create: 2,
        manifest_readiness: 3,
        engine_load: 2,
    };
const SOUNDSPAN_RUNTIME_CONFIG_KEY = "__SOUNDSPAN_RUNTIME_CONFIG__";
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_KEY =
    "SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS";
const LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_KEY =
    "LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED";
const TRACK_ERROR_SKIP_DELAY_MS = 1200;
const TRANSIENT_TRACK_ERROR_RECOVERY_DELAY_MS = 450;
const TRANSIENT_TRACK_ERROR_RECOVERY_WINDOW_MS = 15_000;
const TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS = 2;
const STARTUP_PLAYBACK_RECOVERY_DELAY_MS = 1400;
const STARTUP_PLAYBACK_RECOVERY_RECHECK_DELAY_MS = 900;
const STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS = 2;
const AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS = 8000;
const SEGMENTED_HEARTBEAT_INTERVAL_MS = 15_000;
const SEGMENTED_HANDOFF_MAX_ATTEMPTS = 4;
const SEGMENTED_HANDOFF_COOLDOWN_MS = 8_000;
const SEGMENTED_HANDOFF_PROGRESS_RESET_MIN_DELTA_SEC = 3;
const SEGMENTED_HANDOFF_RESET_STABLE_PLAYBACK_MS = 20_000;
const SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS = 30_000;
const SEGMENTED_HANDOFF_CIRCUIT_MAX_ATTEMPTS = 2;
const SEGMENTED_PREWARM_EXPIRY_GUARD_MS = 45_000;
const SEGMENTED_PREWARM_RETRY_DELAY_MS = 1_000;
const SEGMENTED_PROACTIVE_HANDOFF_RECHECK_MS = 1_000;
const SEGMENTED_PROACTIVE_HANDOFF_COOLDOWN_MS = 1_200;
const SEGMENTED_PROACTIVE_HANDOFF_MAX_ATTEMPTS = 6;
const SEGMENTED_PROACTIVE_HANDOFF_MIN_STABLE_PLAYBACK_MS = 8_000;
const SEGMENTED_PROACTIVE_HANDOFF_ENABLED = false;
const SEGMENTED_SESSION_PREWARM_ENABLED = false;
const SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MIN_MS = 8_000;
const SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MAX_MS = 20_000;
const SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC = 0.2;
const SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS = 7_000;
const SEGMENTED_COLD_START_REBUFFER_TIMEOUT_MS = 18_000;
const SEGMENTED_COLD_START_REBUFFER_MAX_DEFERRALS = 2;
const SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC = 12;
const SEGMENTED_PAUSE_RECOVERY_DEBOUNCE_MS = 600;
const SEGMENTED_PAUSE_RECOVERY_MIN_SILENCE_MS = 1200;
const SEGMENTED_PAUSE_RECOVERY_MAX_BUFFERED_AHEAD_SEC = 1.0;
const SEGMENTED_STARTUP_MANIFEST_NUDGE_DELAYS_MS = [1_000, 2_000] as const;
const howlerEngine = createRuntimeAudioEngine();

interface ActiveSegmentedSessionSnapshot {
    sessionId: string;
    sessionToken: string;
    trackId: string;
    sourceType: "local" | "tidal" | "ytmusic";
    manifestUrl: string;
    expiresAt: string;
    assetBuildInFlight: boolean;
}

interface SegmentedSessionPrewarmOptions {
    sessionKey: string;
    context: SegmentedTrackContext;
    trackId: string;
    reason: "startup_background" | "next_track";
    retryCount?: number;
}

interface StartupSegmentedSessionSnapshot {
    trackId: string;
    sourceType: "local" | "tidal" | "ytmusic";
    session: SegmentedStreamingSessionResponse;
}

interface SegmentedStartupTimelineSnapshot {
    trackId: string;
    loadId: number;
    sessionId: string | null;
    sourceType: "local" | "tidal" | "ytmusic" | "unknown";
    initSource: "prewarm" | "startup" | "on_demand" | null;
    loadAttemptStartedAtMs: number;
    createRequestedAtMs: number | null;
    createResolvedAtMs: number | null;
    manifestFirstResponseAtMs: number | null;
    firstChunkResponseAtMs: number | null;
    firstChunkName: string | null;
    audibleAtMs: number | null;
    startupRetryCount: number;
    emitted: boolean;
}

const buildSegmentedSessionKey = (context: SegmentedTrackContext): string =>
    `${context.sourceType}:${context.sessionTrackId}`;

const getSegmentedSessionRemainingMs = (
    session: Pick<SegmentedStreamingSessionResponse, "expiresAt">,
): number => {
    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
        return Number.NEGATIVE_INFINITY;
    }
    return expiresAtMs - Date.now();
};

const isSegmentedSessionUsable = (
    session: Pick<SegmentedStreamingSessionResponse, "expiresAt">,
): boolean => {
    return (
        getSegmentedSessionRemainingMs(session) >
        SEGMENTED_PREWARM_EXPIRY_GUARD_MS
    );
};

const clampSegmentedStartupFallbackTimeoutMs = (value: number): number =>
    Math.min(
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS,
        Math.max(SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS, value),
    );

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

const resolveRuntimeConfigBoolean = (key: string): boolean => {
    const runtimeValue = readRuntimeConfigValue(key);
    if (typeof runtimeValue === "boolean") {
        return runtimeValue;
    }

    return String(runtimeValue ?? "").trim().toLowerCase() === "true";
};

const isListenTogetherSegmentedPlaybackEnabled = (): boolean =>
    resolveRuntimeConfigBoolean(LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_KEY);

const resolveSegmentedStartupFallbackTimeoutMs = (): number => {
    const runtimeValue = readRuntimeConfigValue(SEGMENTED_STARTUP_FALLBACK_TIMEOUT_KEY);
    const parsedRuntimeValue =
        typeof runtimeValue === "number"
            ? runtimeValue
            : Number.parseInt(String(runtimeValue ?? ""), 10);

    if (!Number.isFinite(parsedRuntimeValue)) {
        return SEGMENTED_STARTUP_FALLBACK_TIMEOUT_DEFAULT_MS;
    }

    return clampSegmentedStartupFallbackTimeoutMs(parsedRuntimeValue);
};

const durationBetweenMs = (
    startedAtMs: number | null,
    endedAtMs: number | null,
): number | null => {
    if (typeof startedAtMs !== "number" || typeof endedAtMs !== "number") {
        return null;
    }
    return Math.max(0, endedAtMs - startedAtMs);
};

const resolveSegmentNameFromUri = (uri: string): string | null => {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
        return null;
    }
    const segments = normalizedUri.split("/");
    const finalSegment = segments[segments.length - 1];
    return finalSegment ? finalSegment : null;
};

const resolveSegmentedUnexpectedStopStartupGuardMs = (): number => {
    const fallbackTimeoutMs = resolveSegmentedStartupFallbackTimeoutMs();
    const computedGuardMs = fallbackTimeoutMs + 4_000;
    return Math.min(
        SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MAX_MS,
        Math.max(SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MIN_MS, computedGuardMs),
    );
};

/**
 * AudioPlaybackOrchestrator - Unified audio playback using Howler.js
 *
 * Handles: web playback, progress saving for audiobooks/podcasts
 * Browser media controls are handled separately by useMediaSession hook
 */
export const AudioPlaybackOrchestrator = memo(function AudioPlaybackOrchestrator() {
    // State context
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        repeatMode,
        setCurrentAudiobook,
        setCurrentTrack,
        setCurrentPodcast,
        setPlaybackType,
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
    } = useAudioState();

    // Playback context
    const {
        isPlaying,
        currentTime,
        setCurrentTime,
        setCurrentTimeFromEngine,
        setDuration,
        setIsPlaying,
        isBuffering,
        setIsBuffering,
        setTargetSeekPosition,
        canSeek,
        setCanSeek,
        setDownloadProgress,
        setStreamProfile,
    } = useAudioPlayback();

    // Controls context
    const { pause, next, nextPodcastEpisode, startVibeMode } = useAudioControls();
    const queryClient = useQueryClient();

    // Refs
    const lastTrackIdRef = useRef<string | null>(null);
    const lastPlayingStateRef = useRef<boolean>(isPlaying);
    const progressSaveIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const lastProgressSaveRef = useRef<number>(0);
    const isUserInitiatedRef = useRef<boolean>(false);
    const isLoadingRef = useRef<boolean>(false);
    const outputStateRef = useRef<{ volume: number; isMuted: boolean }>({
        volume,
        isMuted,
    });
    const loadIdRef = useRef<number>(0);
    const cachePollingRef = useRef<NodeJS.Timeout | null>(null);
    const seekCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const cacheStatusPollingRef = useRef<NodeJS.Timeout | null>(null);
    const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const segmentedStartupFallbackTimeoutRef = useRef<NodeJS.Timeout | null>(
        null
    );
    const loadTimeoutRetryCountRef = useRef<number>(0);
    const seekReloadListenerRef = useRef<(() => void) | null>(null);
    const seekReloadInProgressRef = useRef<boolean>(false);
    // Track when a seek operation is in progress to prevent load effect from interfering
    const isSeekingRef = useRef<boolean>(false);
    // Track load listeners for cleanup to prevent memory leaks
    const loadListenerRef = useRef<(() => void) | null>(null);
    const loadErrorListenerRef = useRef<(() => void) | null>(null);
    const cachePollingLoadListenerRef = useRef<(() => void) | null>(null);
    // Counter to track seek operations and abort stale ones
    const seekOperationIdRef = useRef<number>(0);
    // Debounce timer for rapid podcast seeks
    const seekDebounceRef = useRef<NodeJS.Timeout | null>(null);
    const pendingSeekTimeRef = useRef<number | null>(null);
    // Preload management
    const lastPreloadedTrackIdRef = useRef<string | null>(null);
    const prewarmedSegmentedSessionRef = useRef<
        Map<string, SegmentedStreamingSessionResponse>
    >(new Map());
    const segmentedPrewarmInFlightRef = useRef<Set<string>>(new Set());
    const segmentedPrewarmRetryTimeoutsRef = useRef<
        Map<string, NodeJS.Timeout>
    >(new Map());
    const pendingTrackErrorSkipRef = useRef<NodeJS.Timeout | null>(null);
    const pendingTrackErrorTrackIdRef = useRef<string | null>(null);
    const currentTrackRef = useRef(currentTrack);
    const currentTimeSnapshotRef = useRef<number>(currentTime);
    const currentTimeSnapshotTrackIdRef = useRef<string | null>(
        playbackType === "track" ? currentTrack?.id ?? null : null,
    );
    const queueLengthRef = useRef(queue.length);
    const playbackTypeRef = useRef(playbackType);
    const activeEngineTrackIdRef = useRef<string | null>(null);
    const startupRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const startupRecoveryLoadListenerRef = useRef<(() => void) | null>(null);
    const startupRecoveryAttemptedTrackIdRef = useRef<string | null>(null);
    const unexpectedPauseRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastTrackTimeUpdateAtMsRef = useRef<number>(Date.now());
    const segmentedManifestNudgeTimeoutsRef = useRef<NodeJS.Timeout[]>([]);
    const transientTrackRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const transientTrackRecoveryLoadListenerRef = useRef<(() => void) | null>(
        null
    );
    const transientTrackRecoveryTrackIdRef = useRef<string | null>(null);
    const transientTrackRecoveryAttemptRef = useRef<number>(0);
    const transientTrackRecoveryWindowStartedAtRef = useRef<number>(0);
    const autoMatchVibePromiseRef = useRef<Promise<boolean> | null>(null);
    const autoMatchVibeTrackIdRef = useRef<string | null>(null);
    const autoMatchVibeLastAttemptAtRef = useRef<number>(0);
    const activeSegmentedSessionRef =
        useRef<ActiveSegmentedSessionSnapshot | null>(null);
    const activeSegmentedPlaybackTrackIdRef = useRef<string | null>(null);
    const segmentedHandoffInProgressRef = useRef<boolean>(false);
    const segmentedHandoffAttemptRef = useRef<number>(0);
    const segmentedHandoffLastAttemptAtRef = useRef<number>(0);
    const segmentedHandoffCircuitRef = useRef<{
        trackId: string | null;
        windowStartedAtMs: number;
        attempts: number;
    }>({
        trackId: null,
        windowStartedAtMs: 0,
        attempts: 0,
    });
    const segmentedHandoffLastRecoveryRef = useRef<{
        trackId: string | null;
        resumeAtSec: number;
        recoveredAtMs: number;
    }>({
        trackId: null,
        resumeAtSec: 0,
        recoveredAtMs: 0,
    });
    const segmentedProactiveHandoffAttemptedTrackIdRef = useRef<string | null>(
        null
    );
    const segmentedProactiveHandoffAttemptCountRef = useRef<number>(0);
    const segmentedProactiveHandoffLastAttemptAtRef = useRef<number>(0);
    const segmentedProactiveHandoffCompletedTrackIdRef = useRef<string | null>(
        null
    );
    const segmentedProactiveHandoffLastSkipKeyRef = useRef<string | null>(null);
    const startupSegmentedSessionRef =
        useRef<StartupSegmentedSessionSnapshot | null>(null);
    const startupSegmentedSessionInFlightRef = useRef<Set<string>>(new Set());
    const startupSegmentedSessionPromisesRef = useRef<
        Map<string, Promise<SegmentedStreamingSessionResponse | null>>
    >(new Map());
    const segmentedStartupRetryCountRef = useRef<number>(0);
    const segmentedStartupStageAttemptsRef = useRef(
        createEmptySegmentedStartupRecoveryStageAttempts(),
    );
    const segmentedStartupRecoveryWindowStartedAtMsRef = useRef<number | null>(
        null,
    );
    const segmentedStartupSessionResetCountRef = useRef<number>(0);
    const segmentedStartupTimelineRef =
        useRef<SegmentedStartupTimelineSnapshot | null>(null);
    const segmentedStartupStabilityRef = useRef<{
        trackId: string | null;
        firstProgressAtMs: number | null;
        lastObservedProgressSec: number;
    }>({
        trackId: null,
        firstProgressAtMs: null,
        lastObservedProgressSec: 0,
    });
    const segmentedUnexpectedStopStartupGuardRef = useRef<{
        trackId: string | null;
        suppressUntilMs: number;
        reason: string | null;
    }>({
        trackId: null,
        suppressUntilMs: 0,
        reason: null,
    });
    const segmentedColdStartRebufferDeferralRef = useRef<{
        trackId: string | null;
        count: number;
    }>({
        trackId: null,
        count: 0,
    });
    const lastHandledTrackEndRef = useRef<{
        trackId: string | null;
        loadId: number;
        handledAtMs: number;
    }>({
        trackId: null,
        loadId: -1,
        handledAtMs: 0,
    });

    // Heartbeat monitor for detecting stalled playback
    const heartbeatRef = useRef<HeartbeatMonitor | null>(null);

    const isListenTogetherSegmentedPlaybackAllowed = useCallback((): boolean => {
        const hasActiveListenTogetherGroup = Boolean(
            getListenTogetherSessionSnapshot()?.groupId
        );
        if (!hasActiveListenTogetherGroup) {
            return true;
        }
        return isListenTogetherSegmentedPlaybackEnabled();
    }, []);

    const shouldResetHandoffBudgetAfterRecovery = useCallback(
        (trackId: string, resumeAtSec: number): boolean => {
            const normalizedResumeAtSec = Math.max(0, resumeAtSec);
            const previousRecovery = segmentedHandoffLastRecoveryRef.current;
            const now = Date.now();
            const elapsedSincePreviousRecoveryMs =
                previousRecovery.recoveredAtMs > 0
                    ? Math.max(0, now - previousRecovery.recoveredAtMs)
                    : Number.POSITIVE_INFINITY;
            const progressedSincePreviousRecoverySec =
                normalizedResumeAtSec - previousRecovery.resumeAtSec;
            const shouldReset =
                previousRecovery.trackId !== trackId ||
                (elapsedSincePreviousRecoveryMs >=
                    SEGMENTED_HANDOFF_RESET_STABLE_PLAYBACK_MS &&
                    progressedSincePreviousRecoverySec >=
                        SEGMENTED_HANDOFF_PROGRESS_RESET_MIN_DELTA_SEC);
            segmentedHandoffLastRecoveryRef.current = {
                trackId,
                resumeAtSec: normalizedResumeAtSec,
                recoveredAtMs: now,
            };
            return shouldReset;
        },
        [],
    );

    const ensureSegmentedStartupTimeline = useCallback(
        (
            trackId: string,
            loadId: number,
            loadAttemptStartedAtMs: number,
        ): SegmentedStartupTimelineSnapshot => {
            const existing = segmentedStartupTimelineRef.current;
            if (existing && existing.trackId === trackId && existing.loadId === loadId) {
                return existing;
            }

            const created: SegmentedStartupTimelineSnapshot = {
                trackId,
                loadId,
                sessionId: null,
                sourceType: "unknown",
                initSource: null,
                loadAttemptStartedAtMs,
                createRequestedAtMs: null,
                createResolvedAtMs: null,
                manifestFirstResponseAtMs: null,
                firstChunkResponseAtMs: null,
                firstChunkName: null,
                audibleAtMs: null,
                startupRetryCount: 0,
                emitted: false,
            };
            segmentedStartupTimelineRef.current = created;
            return created;
        },
        [],
    );

    const emitSegmentedStartupTimeline = useCallback(
        (
            outcome:
                | "audible"
                | "playback_error"
                | "unexpected_stop"
                | "startup_timeout",
            fields: Record<string, unknown> = {},
        ): void => {
            const current = segmentedStartupTimelineRef.current;
            if (!current || current.emitted) {
                return;
            }

            current.emitted = true;
            const timelineAnchorMs =
                current.createRequestedAtMs ?? current.loadAttemptStartedAtMs;
            const createToManifestMs = durationBetweenMs(
                timelineAnchorMs,
                current.manifestFirstResponseAtMs,
            );
            const manifestToFirstChunkMs = durationBetweenMs(
                current.manifestFirstResponseAtMs,
                current.firstChunkResponseAtMs,
            );
            const firstChunkToAudibleMs = durationBetweenMs(
                current.firstChunkResponseAtMs,
                current.audibleAtMs,
            );
            const totalToAudibleMs = durationBetweenMs(
                timelineAnchorMs,
                current.audibleAtMs,
            );

            logSegmentedClientMetric("player.startup_timeline", {
                outcome,
                trackId: current.trackId,
                sessionId: current.sessionId,
                sourceType: current.sourceType,
                initSource: current.initSource,
                loadId: current.loadId,
                startupRetryCount: current.startupRetryCount,
                hadCreateRequest: current.createRequestedAtMs !== null,
                createLatencyMs: durationBetweenMs(
                    current.createRequestedAtMs,
                    current.createResolvedAtMs,
                ),
                createToManifestMs,
                manifestToFirstChunkMs,
                firstChunkToAudibleMs,
                totalToAudibleMs,
                firstChunkName: current.firstChunkName,
                loadAttemptStartedAtMs: current.loadAttemptStartedAtMs,
                createRequestedAtMs: current.createRequestedAtMs,
                createResolvedAtMs: current.createResolvedAtMs,
                manifestFirstResponseAtMs: current.manifestFirstResponseAtMs,
                firstChunkResponseAtMs: current.firstChunkResponseAtMs,
                audibleAtMs: current.audibleAtMs,
                ...fields,
            });
        },
        [],
    );

    const clearSegmentedStartupFallback = useCallback(() => {
        if (segmentedStartupFallbackTimeoutRef.current) {
            clearTimeout(segmentedStartupFallbackTimeoutRef.current);
            segmentedStartupFallbackTimeoutRef.current = null;
        }
    }, []);

    const clearSegmentedManifestNudges = useCallback(() => {
        const nudgeTimeouts = segmentedManifestNudgeTimeoutsRef.current;
        if (nudgeTimeouts.length === 0) {
            return;
        }
        for (const timeout of nudgeTimeouts) {
            clearTimeout(timeout);
        }
        segmentedManifestNudgeTimeoutsRef.current = [];
    }, []);

    const applyCurrentOutputState = useCallback(() => {
        const { volume: currentVolume, isMuted: currentMuted } =
            outputStateRef.current;
        howlerEngine.setVolume(currentVolume);
        howlerEngine.setMuted(currentMuted);
    }, []);

    const markSegmentedStartupRampWindow = useCallback(
        (trackId: string | null, reason: string): void => {
            segmentedStartupStabilityRef.current = {
                trackId,
                firstProgressAtMs: null,
                lastObservedProgressSec: 0,
            };
            segmentedUnexpectedStopStartupGuardRef.current = {
                trackId,
                suppressUntilMs: trackId
                    ? Date.now() + resolveSegmentedUnexpectedStopStartupGuardMs()
                    : 0,
                reason: trackId ? reason : null,
            };
        },
        [],
    );

    const noteSegmentedStartupProgress = useCallback(
        (trackId: string | null, timeSec: number): void => {
            if (!trackId || !Number.isFinite(timeSec)) {
                return;
            }

            const current = segmentedStartupStabilityRef.current;
            if (current.trackId !== trackId) {
                segmentedStartupStabilityRef.current = {
                    trackId,
                    firstProgressAtMs: null,
                    lastObservedProgressSec: Math.max(0, timeSec),
                };
                return;
            }

            const normalizedTimeSec = Math.max(0, timeSec);
            const progressed =
                normalizedTimeSec >
                current.lastObservedProgressSec + 0.15;
            if (progressed && normalizedTimeSec >= 0.2) {
                segmentedStartupStabilityRef.current = {
                    ...current,
                    firstProgressAtMs:
                        current.firstProgressAtMs ?? Date.now(),
                    lastObservedProgressSec: normalizedTimeSec,
                };
                return;
            }

            if (normalizedTimeSec > current.lastObservedProgressSec) {
                segmentedStartupStabilityRef.current = {
                    ...current,
                    lastObservedProgressSec: normalizedTimeSec,
                };
            }
        },
        [],
    );

    const noteSegmentedStartupVhsResponse = useCallback(
        (payload: AudioEngineVhsResponsePayload): void => {
            const current = segmentedStartupTimelineRef.current;
            if (!current || current.emitted) {
                return;
            }

            if (payload.trackId && payload.trackId !== current.trackId) {
                return;
            }
            if (
                payload.sessionId &&
                current.sessionId &&
                payload.sessionId !== current.sessionId
            ) {
                return;
            }
            if (payload.hasError) {
                return;
            }

            if (
                payload.kind === "manifest" &&
                current.manifestFirstResponseAtMs === null
            ) {
                current.manifestFirstResponseAtMs = payload.timestampMs;
                return;
            }

            if (
                payload.kind === "segment" &&
                current.firstChunkResponseAtMs === null
            ) {
                current.firstChunkResponseAtMs = payload.timestampMs;
                current.firstChunkName = resolveSegmentNameFromUri(payload.uri);
            }
        },
        [],
    );

    const noteSegmentedStartupAudible = useCallback(
        (trackId: string | null, currentTimeSec: number): void => {
            if (!trackId || currentTimeSec < SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC) {
                return;
            }

            const current = segmentedStartupTimelineRef.current;
            if (
                !current ||
                current.emitted ||
                current.trackId !== trackId ||
                !current.sessionId
            ) {
                return;
            }

            if (current.audibleAtMs === null) {
                current.audibleAtMs = Date.now();
            }
            emitSegmentedStartupTimeline("audible");
        },
        [emitSegmentedStartupTimeline],
    );

    const clearSegmentedPrewarmRetry = useCallback((sessionKey: string) => {
        const existingTimeout =
            segmentedPrewarmRetryTimeoutsRef.current.get(sessionKey);
        if (!existingTimeout) {
            return;
        }
        clearTimeout(existingTimeout);
        segmentedPrewarmRetryTimeoutsRef.current.delete(sessionKey);
    }, []);

    const clearPendingTrackErrorSkip = useCallback(() => {
        if (pendingTrackErrorSkipRef.current) {
            clearTimeout(pendingTrackErrorSkipRef.current);
            pendingTrackErrorSkipRef.current = null;
        }
        pendingTrackErrorTrackIdRef.current = null;
    }, []);

    const readTrustedTrackPositionSec = useCallback((trackId: string): number => {
        const enginePosition = Math.max(
            0,
            typeof howlerEngine.getActualCurrentTime === "function"
                ? howlerEngine.getActualCurrentTime()
                : howlerEngine.getCurrentTime(),
        );

        return resolveTrustedTrackPositionSec({
            fallbackPositionSec: currentTimeSnapshotRef.current,
            fallbackTrackId: currentTimeSnapshotTrackIdRef.current,
            playbackType: playbackTypeRef.current,
            currentTrackId: currentTrackRef.current?.id ?? null,
            targetTrackId: trackId,
            isLoading: isLoadingRef.current,
            activeEngineTrackId: activeEngineTrackIdRef.current,
            enginePositionSec: enginePosition,
        });
    }, []);

    const resolveStartupSafeTrackPositionSec = useCallback(
        (trackId: string): number => {
            const trustedPositionSec = readTrustedTrackPositionSec(trackId);
            const startupStability = segmentedStartupStabilityRef.current;
            return resolveStartupGuardedRecoveryPositionSec({
                targetTrackId: trackId,
                trustedPositionSec,
                startupStabilityTrackId: startupStability.trackId,
                startupFirstProgressAtMs: startupStability.firstProgressAtMs,
            });
        },
        [readTrustedTrackPositionSec],
    );

    const resolveHandoffLocalPositionSec = useCallback(
        (trackId: string, anchorPositionSec: number): number => {
            const livePositionSec = resolveStartupSafeTrackPositionSec(trackId);
            if (livePositionSec > 0.25) {
                return livePositionSec;
            }
            return Math.max(0, anchorPositionSec);
        },
        [resolveStartupSafeTrackPositionSec],
    );

    const clearUnexpectedPauseRecoveryCheck = useCallback(() => {
        if (unexpectedPauseRecoveryTimeoutRef.current) {
            clearTimeout(unexpectedPauseRecoveryTimeoutRef.current);
            unexpectedPauseRecoveryTimeoutRef.current = null;
        }
    }, []);

    const resetSegmentedHandoffCircuit = useCallback((trackId: string | null) => {
        segmentedHandoffCircuitRef.current = {
            trackId,
            windowStartedAtMs: trackId ? Date.now() : 0,
            attempts: 0,
        };
    }, []);

    const resolveBufferedAheadSec = useCallback((): number | null => {
        if (typeof document === "undefined") {
            return null;
        }

        const audioElement = document.querySelector(
            "audio.vjs-tech, audio",
        ) as HTMLAudioElement | null;
        if (!audioElement?.buffered) {
            return null;
        }

        const currentTimeSec = Number.isFinite(audioElement.currentTime)
            ? audioElement.currentTime
            : howlerEngine.getCurrentTime();
        const buffered = audioElement.buffered;
        if (buffered.length === 0) {
            return 0;
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
    }, []);

    const clearStartupPlaybackRecovery = useCallback(() => {
        if (startupRecoveryTimeoutRef.current) {
            clearTimeout(startupRecoveryTimeoutRef.current);
            startupRecoveryTimeoutRef.current = null;
        }
        if (startupRecoveryLoadListenerRef.current) {
            howlerEngine.off("load", startupRecoveryLoadListenerRef.current);
            startupRecoveryLoadListenerRef.current = null;
        }
    }, []);

    const clearTransientTrackRecovery = useCallback(
        (resetAttempts: boolean = false) => {
            if (transientTrackRecoveryTimeoutRef.current) {
                clearTimeout(transientTrackRecoveryTimeoutRef.current);
                transientTrackRecoveryTimeoutRef.current = null;
            }

            if (transientTrackRecoveryLoadListenerRef.current) {
                howlerEngine.off(
                    "load",
                    transientTrackRecoveryLoadListenerRef.current
                );
                transientTrackRecoveryLoadListenerRef.current = null;
            }

            if (resetAttempts) {
                transientTrackRecoveryTrackIdRef.current = null;
                transientTrackRecoveryAttemptRef.current = 0;
                transientTrackRecoveryWindowStartedAtRef.current = 0;
            }
        },
        []
    );

    const logProactiveSegmentedHandoffSkip = useCallback(
        (
            trackId: string,
            sourceType: "local" | "tidal" | "ytmusic",
            reason: ProactiveSegmentedHandoffSkipReason | string,
            fields: Record<string, unknown> = {},
        ): void => {
            const skipKey = `${trackId}:${reason}`;
            if (segmentedProactiveHandoffLastSkipKeyRef.current === skipKey) {
                return;
            }
            segmentedProactiveHandoffLastSkipKeyRef.current = skipKey;
            logSegmentedClientMetric("session.handoff_proactive_skip", {
                trackId,
                sourceType,
                reason,
                ...fields,
            });
        },
        [],
    );

    const prewarmSegmentedSession = useCallback(
        ({
            sessionKey,
            context,
            trackId,
            reason,
            retryCount = 0,
        }: SegmentedSessionPrewarmOptions): void => {
            if (!SEGMENTED_SESSION_PREWARM_ENABLED) {
                return;
            }
            const existingPrewarmedSession =
                prewarmedSegmentedSessionRef.current.get(sessionKey);
            if (
                existingPrewarmedSession &&
                isSegmentedSessionUsable(existingPrewarmedSession)
            ) {
                clearSegmentedPrewarmRetry(sessionKey);
                return;
            }

            if (segmentedPrewarmInFlightRef.current.has(sessionKey)) {
                return;
            }

            clearSegmentedPrewarmRetry(sessionKey);
            prewarmedSegmentedSessionRef.current.delete(sessionKey);
            segmentedPrewarmInFlightRef.current.add(sessionKey);
            void api
                .createSegmentedStreamingSession({
                    trackId: context.sessionTrackId,
                    sourceType: context.sourceType,
                })
                .then((session) => {
                    if (!isSegmentedSessionUsable(session)) {
                        return;
                    }
                    if (session.engineHints?.assetBuildInFlight === true) {
                        const maxRetries = resolveSegmentedPrewarmMaxRetries(reason);
                        if (retryCount < maxRetries) {
                            const nextAttempt = retryCount + 1;
                            const retryTimeout = setTimeout(() => {
                                segmentedPrewarmRetryTimeoutsRef.current.delete(
                                    sessionKey,
                                );
                                prewarmSegmentedSession({
                                    sessionKey,
                                    context,
                                    trackId,
                                    reason,
                                    retryCount: nextAttempt,
                                });
                            }, SEGMENTED_PREWARM_RETRY_DELAY_MS);
                            segmentedPrewarmRetryTimeoutsRef.current.set(
                                sessionKey,
                                retryTimeout,
                            );
                            logSegmentedClientMetric(
                                "session.prewarm_retry_scheduled",
                                {
                                    trackId,
                                    sourceType:
                                        session.playbackProfile?.sourceType ??
                                        session.engineHints?.sourceType ??
                                        context.sourceType,
                                    trigger: reason,
                                    attempt: nextAttempt,
                                },
                            );
                            return;
                        }
                        logSegmentedClientMetric("session.prewarm_skip", {
                            trackId,
                            sourceType:
                                session.playbackProfile?.sourceType ??
                                session.engineHints?.sourceType ??
                                context.sourceType,
                            reason: "backend_asset_build_inflight",
                            trigger: reason,
                            attempt: retryCount,
                        });
                        return;
                    }
                    if (
                        isLosslessSegmentedSession(session) &&
                        !supportsLosslessSegmentedPlayback()
                    ) {
                        logSegmentedClientMetric("session.prewarm_skip", {
                            trackId,
                            sourceType:
                                session.playbackProfile?.sourceType ??
                                session.engineHints?.sourceType ??
                                context.sourceType,
                            reason: "lossless_segmented_unsupported",
                            trigger: reason,
                        });
                        return;
                    }

                    prewarmedSegmentedSessionRef.current.set(sessionKey, session);
                    clearSegmentedPrewarmRetry(sessionKey);
                    logSegmentedClientMetric("session.prewarm_success", {
                        trackId,
                        sourceType:
                            session.playbackProfile?.sourceType ??
                            session.engineHints?.sourceType ??
                            context.sourceType,
                        sessionId: session.sessionId,
                        trigger: reason,
                        attempt: retryCount,
                    });
                })
                .catch((error) => {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Segmented prewarm failed:",
                        error,
                    );
                    logSegmentedClientMetric("session.prewarm_failure", {
                        trackId,
                        sourceType: context.sourceType,
                        trigger: reason,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error ?? "unknown"),
                    });
                })
                .finally(() => {
                    segmentedPrewarmInFlightRef.current.delete(sessionKey);
                });
        },
        [clearSegmentedPrewarmRetry],
    );

    const ensureStartupSegmentedSession = useCallback(
        (
            trackId: string,
            context: SegmentedTrackContext,
            trigger:
                | "load_direct_startup"
                | "proactive_missing"
                | "prewarm_asset_build_inflight",
        ): Promise<SegmentedStreamingSessionResponse | null> => {
            const existingStartupSession = startupSegmentedSessionRef.current;
            if (
                existingStartupSession &&
                existingStartupSession.trackId === trackId &&
                existingStartupSession.sourceType === context.sourceType &&
                isSegmentedSessionUsable(existingStartupSession.session)
            ) {
                return Promise.resolve(existingStartupSession.session);
            }

            const startupSessionKey = buildSegmentedSessionKey(context);
            const existingStartupPromise =
                startupSegmentedSessionPromisesRef.current.get(startupSessionKey);
            if (existingStartupPromise) {
                return existingStartupPromise;
            }

            startupSegmentedSessionInFlightRef.current.add(startupSessionKey);
            const startupPromise = api
                .createSegmentedStreamingSession({
                    trackId: context.sessionTrackId,
                    sourceType: context.sourceType,
                })
                .then((session) => {
                    if (!isSegmentedSessionUsable(session)) {
                        return null;
                    }
                    if (currentTrackRef.current?.id !== trackId) {
                        return null;
                    }
                    startupSegmentedSessionRef.current = {
                        trackId,
                        sourceType: context.sourceType,
                        session,
                    };
                    logSegmentedClientMetric("session.startup_ready", {
                        trackId,
                        sourceType:
                            session.playbackProfile?.sourceType ??
                            session.engineHints?.sourceType ??
                            context.sourceType,
                        sessionId: session.sessionId,
                        assetBuildInFlight:
                            session.engineHints?.assetBuildInFlight === true,
                        trigger,
                    });
                    return session;
                })
                .catch((error) => {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Startup segmented session request failed:",
                        error,
                    );
                    logSegmentedClientMetric("session.startup_failure", {
                        trackId,
                        sourceType: context.sourceType,
                        trigger,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error ?? "unknown"),
                    });
                    return null;
                })
                .finally(() => {
                    startupSegmentedSessionInFlightRef.current.delete(
                        startupSessionKey,
                    );
                    startupSegmentedSessionPromisesRef.current.delete(
                        startupSessionKey,
                    );
                });
            startupSegmentedSessionPromisesRef.current.set(
                startupSessionKey,
                startupPromise,
            );
            return startupPromise;
        },
        [],
    );

    const scheduleStartupPlaybackRecovery = useCallback(
        (trackId: string | null, recheckCount: number = 0) => {
            if (!trackId) return;
            if (!isListenTogetherSegmentedPlaybackAllowed()) return;
            if (
                startupRecoveryAttemptedTrackIdRef.current === trackId &&
                recheckCount === 0
            ) {
                return;
            }

            const delayMs =
                recheckCount === 0
                    ? STARTUP_PLAYBACK_RECOVERY_DELAY_MS
                    : STARTUP_PLAYBACK_RECOVERY_RECHECK_DELAY_MS;

            clearStartupPlaybackRecovery();
            startupRecoveryTimeoutRef.current = setTimeout(() => {
                startupRecoveryTimeoutRef.current = null;

                if (playbackTypeRef.current !== "track") return;
                if (!lastPlayingStateRef.current) return;
                if (currentTrackRef.current?.id !== trackId) return;

                const startupStability = segmentedStartupStabilityRef.current;
                const hasStartupProgress =
                    startupStability.trackId === trackId &&
                    startupStability.firstProgressAtMs !== null;
                const startupPlayingWithoutProgress =
                    howlerEngine.isPlaying() && !hasStartupProgress;

                if (howlerEngine.isPlaying() && hasStartupProgress) {
                    return;
                }

                if (isLoadingRef.current) {
                    if (recheckCount < STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS) {
                        scheduleStartupPlaybackRecovery(trackId, recheckCount + 1);
                    }
                    return;
                }

                if (
                    startupPlayingWithoutProgress &&
                    recheckCount < STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS
                ) {
                    scheduleStartupPlaybackRecovery(trackId, recheckCount + 1);
                    return;
                }

                if (startupRecoveryAttemptedTrackIdRef.current === trackId) return;
                startupRecoveryAttemptedTrackIdRef.current = trackId;

                sharedFrontendLogger.warn(
                    "[AudioPlaybackOrchestrator] Startup playback watchdog triggered reload+retry",
                    {
                        startupPlayingWithoutProgress,
                        recheckCount,
                    },
                );

                const onReloaded = () => {
                    howlerEngine.off("load", onReloaded);
                    startupRecoveryLoadListenerRef.current = null;

                    if (playbackTypeRef.current !== "track") return;
                    if (!lastPlayingStateRef.current) return;
                    if (currentTrackRef.current?.id !== trackId) return;
                    if (howlerEngine.isPlaying()) return;

                    howlerEngine.play();
                };

                startupRecoveryLoadListenerRef.current = onReloaded;
                howlerEngine.on("load", onReloaded);
                howlerEngine.reload();
            }, delayMs);
        },
        [clearStartupPlaybackRecovery, isListenTogetherSegmentedPlaybackAllowed]
    );

    const scheduleTrackErrorSkip = useCallback(
        (failedTrackId: string | null) => {
            // In Listen Together, only explicit host controls should advance tracks.
            // Hidden local auto-skips can cause server/client queue divergence.
            if (getListenTogetherSessionSnapshot()?.groupId) {
                return;
            }

            if (
                pendingTrackErrorSkipRef.current &&
                pendingTrackErrorTrackIdRef.current === failedTrackId
            ) {
                return;
            }

            clearPendingTrackErrorSkip();
            pendingTrackErrorTrackIdRef.current = failedTrackId;
            pendingTrackErrorSkipRef.current = setTimeout(() => {
                pendingTrackErrorSkipRef.current = null;
                pendingTrackErrorTrackIdRef.current = null;

                if (playbackTypeRef.current !== "track") return;
                if (queueLengthRef.current <= 1) return;
                if (failedTrackId && currentTrackRef.current?.id !== failedTrackId) return;

                lastTrackIdRef.current = null;
                isLoadingRef.current = false;
                next();
            }, TRACK_ERROR_SKIP_DELAY_MS);
        },
        [clearPendingTrackErrorSkip, next]
    );

    const attemptTransientTrackRecovery = useCallback(
        (failedTrackId: string | null, error: unknown): boolean => {
            if (playbackTypeRef.current !== "track") return false;
            if (!failedTrackId) return false;
            if (!lastPlayingStateRef.current) return false;
            if (!isListenTogetherSegmentedPlaybackAllowed()) return false;
            if (!isLikelyTransientStreamError(error)) return false;

            const now = Date.now();
            const isNewTrack =
                transientTrackRecoveryTrackIdRef.current !== failedTrackId;
            const isOutsideRecoveryWindow =
                now - transientTrackRecoveryWindowStartedAtRef.current >
                TRANSIENT_TRACK_ERROR_RECOVERY_WINDOW_MS;

            if (isNewTrack || isOutsideRecoveryWindow) {
                transientTrackRecoveryTrackIdRef.current = failedTrackId;
                transientTrackRecoveryAttemptRef.current = 0;
                transientTrackRecoveryWindowStartedAtRef.current = now;
            }

            if (
                transientTrackRecoveryAttemptRef.current >=
                TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS
            ) {
                return false;
            }

            transientTrackRecoveryAttemptRef.current += 1;
            const attemptNumber = transientTrackRecoveryAttemptRef.current;
            clearPendingTrackErrorSkip();
            clearTransientTrackRecovery(false);
            const resumeAtSec = resolveStartupSafeTrackPositionSec(failedTrackId);

            const onRecoveredLoad = () => {
                clearTransientTrackRecovery(false);
                if (playbackTypeRef.current !== "track") return;
                if (currentTrackRef.current?.id !== failedTrackId) return;
                if (!lastPlayingStateRef.current) return;
                if (resumeAtSec > 0) {
                    howlerEngine.seek(resumeAtSec);
                    setCurrentTime(resumeAtSec);
                }
                if (!howlerEngine.isPlaying()) {
                    howlerEngine.play();
                }
            };

            transientTrackRecoveryLoadListenerRef.current = onRecoveredLoad;
            howlerEngine.on("load", onRecoveredLoad);

            transientTrackRecoveryTimeoutRef.current = setTimeout(() => {
                transientTrackRecoveryTimeoutRef.current = null;

                if (playbackTypeRef.current !== "track") return;
                if (currentTrackRef.current?.id !== failedTrackId) return;
                if (!lastPlayingStateRef.current) return;

                sharedFrontendLogger.warn(
                    `[AudioPlaybackOrchestrator] Transient stream error recovery ${attemptNumber}/${TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS}: reload and retry current track`
                );
                howlerEngine.reload();
            }, TRANSIENT_TRACK_ERROR_RECOVERY_DELAY_MS);

            return true;
        },
        [
            clearPendingTrackErrorSkip,
            clearTransientTrackRecovery,
            isListenTogetherSegmentedPlaybackAllowed,
            resolveStartupSafeTrackPositionSec,
            setCurrentTime,
        ]
    );

    const attemptSegmentedSessionCreateRecovery = useCallback(
        async ({
            trackId,
            segmentedTrackContext,
            currentPositionSec,
            shouldPlayIntent,
            recoveryStartedAtMs,
            previousSessionId,
            triggerReason,
        }: {
            trackId: string;
            segmentedTrackContext: SegmentedTrackContext;
            currentPositionSec: number;
            shouldPlayIntent: boolean;
            recoveryStartedAtMs: number;
            previousSessionId: string;
            triggerReason: string;
        }): Promise<boolean> => {
            logSegmentedClientMetric("session.handoff_circuit_recovery_attempt", {
                trackId,
                sourceType: segmentedTrackContext.sourceType,
                previousSessionId,
                triggerReason,
            });

            try {
                const refreshedSession = await api.createSegmentedStreamingSession({
                    trackId: segmentedTrackContext.sessionTrackId,
                    sourceType: segmentedTrackContext.sourceType,
                });

                if (
                    playbackTypeRef.current !== "track" ||
                    currentTrackRef.current?.id !== trackId
                ) {
                    return false;
                }

                const requestHeaders: Record<string, string> = {
                    "x-streaming-session-token": refreshedSession.sessionToken,
                };
                const authToken = api.getStreamingAuthToken();
                if (authToken) {
                    requestHeaders.Authorization = `Bearer ${authToken}`;
                }

                activeSegmentedSessionRef.current = {
                    sessionId: refreshedSession.sessionId,
                    sessionToken: refreshedSession.sessionToken,
                    trackId,
                    sourceType:
                        refreshedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    manifestUrl: refreshedSession.manifestUrl,
                    expiresAt: refreshedSession.expiresAt,
                    assetBuildInFlight:
                        refreshedSession.engineHints?.assetBuildInFlight === true,
                };
                segmentedColdStartRebufferDeferralRef.current = {
                    trackId,
                    count: 0,
                };
                setStreamProfile({
                    mode: "dash",
                    sourceType:
                        refreshedSession.playbackProfile?.sourceType ??
                        refreshedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    codec:
                        refreshedSession.playbackProfile?.codec?.toUpperCase() ?? "AAC",
                    bitrateKbps:
                        refreshedSession.playbackProfile?.bitrateKbps ?? null,
                });

                logSegmentedClientMetric("session.handoff_circuit_recovery_api_success", {
                    trackId,
                    sourceType:
                        refreshedSession.playbackProfile?.sourceType ??
                        refreshedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    previousSessionId,
                    sessionId: refreshedSession.sessionId,
                    requestedPositionSec: currentPositionSec,
                    latencyMs: Math.max(0, Date.now() - recoveryStartedAtMs),
                });

                const clearRecoveryListeners = () => {
                    howlerEngine.off("load", onRecoveryLoad);
                    howlerEngine.off("loaderror", onRecoveryLoadError);
                };

                const onRecoveryLoad = () => {
                    clearRecoveryListeners();
                    if (
                        playbackTypeRef.current !== "track" ||
                        currentTrackRef.current?.id !== trackId
                    ) {
                        return;
                    }

                    const localPositionBeforeRecovery = resolveHandoffLocalPositionSec(
                        trackId,
                        currentPositionSec,
                    );
                    const recoveryDecision = resolveLocalAuthoritativeRecovery(
                        {
                            positionSec: localPositionBeforeRecovery,
                            shouldPlay: shouldPlayIntent,
                        },
                        {
                            resumeAtSec: currentPositionSec,
                            shouldPlay: shouldPlayIntent,
                        },
                    );
                    const resumeAt = recoveryDecision.resumeAtSec;
                    const shouldResumePlayback = recoveryDecision.shouldPlay;
                    howlerEngine.seek(resumeAt);
                    setCurrentTime(resumeAt);

                    if (shouldResumePlayback) {
                        const playResult = howlerEngine.play();
                        if (
                            playResult &&
                            typeof (playResult as Promise<void>).catch === "function"
                        ) {
                            void (playResult as Promise<void>).catch((playError) => {
                                logSegmentedClientMetric(
                                    "session.handoff_circuit_recovery_resume_play_failure",
                                    {
                                        trackId,
                                        sourceType: segmentedTrackContext.sourceType,
                                        sessionId: refreshedSession.sessionId,
                                        error:
                                            playError instanceof Error
                                                ? playError.message
                                                : String(playError ?? "unknown"),
                                    },
                                );
                            });
                        }
                        setIsPlaying(true);
                    } else {
                        setIsPlaying(false);
                    }

                    setIsBuffering(false);
                    const resetHandoffBudget =
                        shouldResetHandoffBudgetAfterRecovery(trackId, resumeAt);
                    if (resetHandoffBudget) {
                        segmentedHandoffAttemptRef.current = 0;
                        segmentedHandoffLastAttemptAtRef.current = 0;
                        resetSegmentedHandoffCircuit(trackId);
                    }
                    logSegmentedClientMetric("session.handoff_circuit_recovered", {
                        trackId,
                        sourceType:
                            refreshedSession.playbackProfile?.sourceType ??
                            refreshedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        previousSessionId,
                        sessionId: refreshedSession.sessionId,
                        resumeAtSec: resumeAt,
                        shouldResumePlayback,
                        authority: recoveryDecision.authority,
                        latencyMs: Math.max(0, Date.now() - recoveryStartedAtMs),
                    });
                };

                const onRecoveryLoadError = () => {
                    clearRecoveryListeners();
                    setIsBuffering(false);
                    logSegmentedClientMetric("session.handoff_circuit_recovery_load_error", {
                        trackId,
                        sourceType:
                            refreshedSession.playbackProfile?.sourceType ??
                            refreshedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        previousSessionId,
                        sessionId: refreshedSession.sessionId,
                        latencyMs: Math.max(0, Date.now() - recoveryStartedAtMs),
                    });
                };

                howlerEngine.on("load", onRecoveryLoad);
                howlerEngine.on("loaderror", onRecoveryLoadError);
                markSegmentedStartupRampWindow(trackId, "handoff_circuit_recovery_load");
                activeSegmentedPlaybackTrackIdRef.current = trackId;
                howlerEngine.load(
                    {
                        url: refreshedSession.manifestUrl,
                        trackId,
                        sessionId: refreshedSession.sessionId,
                        sourceType:
                            refreshedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        protocol: "dash",
                        mimeType: "application/dash+xml",
                    },
                    {
                        autoplay: false,
                        format: "mp4",
                        startTimeSec: Math.max(0, currentPositionSec),
                        withCredentials: true,
                        requestHeaders,
                    },
                );

                return true;
            } catch (sessionCreateError) {
                logSegmentedClientMetric("session.handoff_circuit_recovery_failure", {
                    trackId,
                    sourceType: segmentedTrackContext.sourceType,
                    previousSessionId,
                    error:
                        sessionCreateError instanceof Error
                            ? sessionCreateError.message
                            : String(sessionCreateError ?? "unknown"),
                    latencyMs: Math.max(0, Date.now() - recoveryStartedAtMs),
                });
                setIsBuffering(false);
                return false;
            }
        },
        [
            resolveHandoffLocalPositionSec,
            setCurrentTime,
            setIsBuffering,
            setIsPlaying,
            setStreamProfile,
            markSegmentedStartupRampWindow,
            shouldResetHandoffBudgetAfterRecovery,
            resetSegmentedHandoffCircuit,
        ],
    );

    const attemptSegmentedHandoffRecovery = useCallback(
        async (error: unknown): Promise<boolean> => {
            if (playbackTypeRef.current !== "track") return false;
            if (!isListenTogetherSegmentedPlaybackAllowed()) return false;

            const currentTrackSnapshot = currentTrackRef.current;
            const segmentedTrackContext =
                resolveSegmentedTrackContext(currentTrackSnapshot);
            if (!currentTrackSnapshot || !segmentedTrackContext) {
                return false;
            }

            const activeSession = activeSegmentedSessionRef.current;
            if (
                !activeSession ||
                activeSession.trackId !== currentTrackSnapshot.id
            ) {
                return false;
            }

            if (segmentedHandoffInProgressRef.current) return false;
            if (segmentedHandoffAttemptRef.current >= SEGMENTED_HANDOFF_MAX_ATTEMPTS) {
                return false;
            }
            const now = Date.now();
            if (
                segmentedHandoffLastAttemptAtRef.current > 0 &&
                now - segmentedHandoffLastAttemptAtRef.current <
                    SEGMENTED_HANDOFF_COOLDOWN_MS
            ) {
                logSegmentedClientMetric("session.handoff_skipped", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    reason: "cooldown_active",
                    cooldownMs: SEGMENTED_HANDOFF_COOLDOWN_MS,
                    elapsedMs: now - segmentedHandoffLastAttemptAtRef.current,
                });
                return false;
            }

            const currentPositionSec = resolveStartupSafeTrackPositionSec(
                currentTrackSnapshot.id
            );
            const shouldPlayIntent =
                lastPlayingStateRef.current || howlerEngine.isPlaying() || isPlaying;
            segmentedHandoffInProgressRef.current = true;
            const handoffStartedAtMs = Date.now();

            const existingCircuitState = segmentedHandoffCircuitRef.current;
            const shouldStartNewCircuitWindow =
                existingCircuitState.trackId !== currentTrackSnapshot.id ||
                existingCircuitState.windowStartedAtMs <= 0 ||
                now - existingCircuitState.windowStartedAtMs >
                    SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS;
            if (shouldStartNewCircuitWindow) {
                segmentedHandoffCircuitRef.current = {
                    trackId: currentTrackSnapshot.id,
                    windowStartedAtMs: now,
                    attempts: 0,
                };
            }
            segmentedHandoffCircuitRef.current.attempts += 1;
            const circuitAttempt = segmentedHandoffCircuitRef.current.attempts;
            setIsBuffering(true);
            playbackStateMachine.forceTransition("LOADING");

            if (circuitAttempt > SEGMENTED_HANDOFF_CIRCUIT_MAX_ATTEMPTS) {
                logSegmentedClientMetric("session.handoff_circuit_open", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    sessionId: activeSession.sessionId,
                    attemptsInWindow: circuitAttempt,
                    maxAttempts: SEGMENTED_HANDOFF_CIRCUIT_MAX_ATTEMPTS,
                    windowMs: SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS,
                    triggerReason:
                        error instanceof Error
                            ? error.message
                            : String(error ?? "unknown"),
                });
                try {
                    return await attemptSegmentedSessionCreateRecovery({
                        trackId: currentTrackSnapshot.id,
                        segmentedTrackContext,
                        currentPositionSec,
                        shouldPlayIntent,
                        recoveryStartedAtMs: handoffStartedAtMs,
                        previousSessionId: activeSession.sessionId,
                        triggerReason: "handoff_circuit_open",
                    });
                } finally {
                    segmentedHandoffInProgressRef.current = false;
                }
            }

            segmentedHandoffAttemptRef.current += 1;
            segmentedHandoffLastAttemptAtRef.current = now;
            logSegmentedClientMetric("session.handoff_attempt", {
                trackId: currentTrackSnapshot.id,
                sourceType: segmentedTrackContext.sourceType,
                sessionId: activeSession.sessionId,
                attempt: segmentedHandoffAttemptRef.current,
                circuitAttempt,
                reason: error instanceof Error ? error.message : String(error ?? "unknown"),
            });

            try {
                const handoff = await api.handoffSegmentedStreamingSession(
                    activeSession.sessionId,
                    activeSession.sessionToken,
                    {
                        positionSec: currentPositionSec,
                        isPlaying: shouldPlayIntent,
                    }
                );

                if (
                    playbackTypeRef.current !== "track" ||
                    currentTrackRef.current?.id !== currentTrackSnapshot.id
                ) {
                    return false;
                }

                const requestHeaders: Record<string, string> = {
                    "x-streaming-session-token": handoff.sessionToken,
                };
                const authToken = api.getStreamingAuthToken();
                if (authToken) {
                    requestHeaders.Authorization = `Bearer ${authToken}`;
                }

                activeSegmentedSessionRef.current = {
                    sessionId: handoff.sessionId,
                    sessionToken: handoff.sessionToken,
                    trackId: currentTrackSnapshot.id,
                    sourceType:
                        handoff.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    manifestUrl: handoff.manifestUrl,
                    expiresAt: handoff.expiresAt,
                    assetBuildInFlight:
                        handoff.engineHints?.assetBuildInFlight === true,
                };
                segmentedColdStartRebufferDeferralRef.current = {
                    trackId: currentTrackSnapshot.id,
                    count: 0,
                };
                setStreamProfile({
                    mode: "dash",
                    sourceType:
                        handoff.playbackProfile?.sourceType ??
                        handoff.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    codec:
                        handoff.playbackProfile?.codec?.toUpperCase() ?? "AAC",
                    bitrateKbps: handoff.playbackProfile?.bitrateKbps ?? null,
                });
                logSegmentedClientMetric("session.handoff_api_success", {
                    trackId: currentTrackSnapshot.id,
                    sourceType:
                        handoff.playbackProfile?.sourceType ??
                        handoff.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    previousSessionId: activeSession.sessionId,
                    sessionId: handoff.sessionId,
                    requestedPositionSec: currentPositionSec,
                    serverResumeAtSec: handoff.resumeAtSec,
                    resumeDeltaSec: Math.abs(
                        currentPositionSec - handoff.resumeAtSec
                    ),
                    latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                });

                const clearHandoffListeners = () => {
                    howlerEngine.off("load", onHandoffLoad);
                    howlerEngine.off("loaderror", onHandoffLoadError);
                };

                const onHandoffLoad = () => {
                    clearHandoffListeners();

                    if (
                        playbackTypeRef.current !== "track" ||
                        currentTrackRef.current?.id !== currentTrackSnapshot.id
                    ) {
                        return;
                    }

                    const localPositionBeforeRecovery =
                        resolveHandoffLocalPositionSec(
                            currentTrackSnapshot.id,
                            currentPositionSec,
                        );
                    const recoveryDecision = resolveLocalAuthoritativeRecovery(
                        {
                            positionSec: localPositionBeforeRecovery,
                            shouldPlay: shouldPlayIntent,
                        },
                        {
                            resumeAtSec: handoff.resumeAtSec,
                            shouldPlay: handoff.shouldPlay,
                        },
                    );
                    const resumeAt = recoveryDecision.resumeAtSec;
                    const shouldResumePlayback = recoveryDecision.shouldPlay;
                    howlerEngine.seek(resumeAt);
                    setCurrentTime(resumeAt);

                    if (shouldResumePlayback) {
                        const playResult = howlerEngine.play();
                        if (
                            playResult &&
                            typeof (playResult as Promise<void>).catch === "function"
                        ) {
                            void (playResult as Promise<void>).catch((playError) => {
                                logSegmentedClientMetric("session.handoff_resume_play_failure", {
                                    trackId: currentTrackSnapshot.id,
                                    sourceType: segmentedTrackContext.sourceType,
                                    sessionId: handoff.sessionId,
                                    error:
                                        playError instanceof Error
                                            ? playError.message
                                            : String(playError ?? "unknown"),
                                });
                            });
                        }
                        setIsPlaying(true);
                    } else {
                        setIsPlaying(false);
                    }

                    setIsBuffering(false);
                    const resetHandoffBudget = shouldResetHandoffBudgetAfterRecovery(
                        currentTrackSnapshot.id,
                        resumeAt,
                    );
                    if (resetHandoffBudget) {
                        segmentedHandoffAttemptRef.current = 0;
                        segmentedHandoffLastAttemptAtRef.current = 0;
                        resetSegmentedHandoffCircuit(currentTrackSnapshot.id);
                    }
                    logSegmentedClientMetric("session.handoff_recovered", {
                        trackId: currentTrackSnapshot.id,
                        sourceType:
                            handoff.playbackProfile?.sourceType ??
                            handoff.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: handoff.sessionId,
                        resumeAtSec: resumeAt,
                        shouldResumePlayback,
                        authority: recoveryDecision.authority,
                        localPositionSec: localPositionBeforeRecovery,
                        serverResumeAtSec: handoff.resumeAtSec,
                        resumeDeltaSec: Math.abs(
                            localPositionBeforeRecovery - handoff.resumeAtSec
                        ),
                        latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                    });
                };

                const onHandoffLoadError = () => {
                    clearHandoffListeners();
                    setIsBuffering(false);
                    logSegmentedClientMetric("session.handoff_load_error", {
                        trackId: currentTrackSnapshot.id,
                        sourceType:
                            handoff.playbackProfile?.sourceType ??
                            handoff.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: handoff.sessionId,
                        latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                    });
                };

                howlerEngine.on("load", onHandoffLoad);
                howlerEngine.on("loaderror", onHandoffLoadError);
                markSegmentedStartupRampWindow(
                    currentTrackSnapshot.id,
                    "handoff_recovery_load",
                );
                activeSegmentedPlaybackTrackIdRef.current = currentTrackSnapshot.id;
                howlerEngine.load(
                    {
                        url: handoff.manifestUrl,
                        trackId: currentTrackSnapshot.id,
                        sessionId: handoff.sessionId,
                        sourceType:
                            handoff.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        protocol: "dash",
                        mimeType: "application/dash+xml",
                    },
                    {
                        autoplay: false,
                        format: "mp4",
                        startTimeSec: Math.max(0, currentPositionSec),
                        withCredentials: true,
                        requestHeaders,
                    }
                );

                sharedFrontendLogger.warn(
                    "[AudioPlaybackOrchestrator] Segmented handoff recovery succeeded after playback error:",
                    error
                );
                return true;
            } catch (handoffError) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Segmented handoff recovery failed:",
                    handoffError
                );
                logSegmentedClientMetric("session.handoff_failure", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    sessionId: activeSession.sessionId,
                    error:
                        handoffError instanceof Error
                            ? handoffError.message
                            : String(handoffError ?? "unknown"),
                    latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                });
                setIsBuffering(false);
                return false;
            } finally {
                segmentedHandoffInProgressRef.current = false;
            }
        },
        [
            isPlaying,
            resolveStartupSafeTrackPositionSec,
            resolveHandoffLocalPositionSec,
            setCurrentTime,
            setIsBuffering,
            setIsPlaying,
            setStreamProfile,
            markSegmentedStartupRampWindow,
            isListenTogetherSegmentedPlaybackAllowed,
            shouldResetHandoffBudgetAfterRecovery,
            attemptSegmentedSessionCreateRecovery,
            resetSegmentedHandoffCircuit,
        ]
    );

    useEffect(() => {
        currentTimeSnapshotRef.current = currentTime;
        currentTimeSnapshotTrackIdRef.current =
            playbackType === "track" ? currentTrackRef.current?.id ?? null : null;
    }, [currentTime, playbackType]);

    useEffect(() => {
        if (!SEGMENTED_PROACTIVE_HANDOFF_ENABLED) {
            return;
        }
        if (playbackType !== "track") {
            return;
        }
        if (resolveStreamingEngineMode() === "howler-rollback") {
            return;
        }

        const runProactiveSegmentedCheck = () => {
            const track = currentTrackRef.current;
            if (!track) {
                return;
            }

            const segmentedTrackContext = resolveSegmentedTrackContext(track);
            if (!segmentedTrackContext) {
                return;
            }

            const sourceType =
                segmentedTrackContext.sourceType;
            if (!isListenTogetherSegmentedPlaybackAllowed()) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "listen_together_active",
                );
                return;
            }

            if (
                segmentedProactiveHandoffCompletedTrackIdRef.current === track.id
            ) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "already_promoted",
                );
                return;
            }

            if (isLoadingRef.current) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "load_in_progress",
                );
                return;
            }

            if (activeEngineTrackIdRef.current !== track.id) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "engine_track_not_ready",
                );
                return;
            }

            const sessionKey = buildSegmentedSessionKey(segmentedTrackContext);
            const startupSessionSnapshot = startupSegmentedSessionRef.current;
            const startupSession =
                startupSessionSnapshot &&
                startupSessionSnapshot.trackId === track.id &&
                startupSessionSnapshot.sourceType === segmentedTrackContext.sourceType &&
                isSegmentedSessionUsable(startupSessionSnapshot.session)
                    ? startupSessionSnapshot.session
                    : null;
            if (
                startupSessionSnapshot &&
                startupSessionSnapshot.trackId === track.id &&
                !startupSession
            ) {
                logSegmentedClientMetric("session.startup_discarded", {
                    trackId: track.id,
                    sourceType,
                    reason: "insufficient_ttl",
                    remainingMs: getSegmentedSessionRemainingMs(
                        startupSessionSnapshot.session,
                    ),
                });
                startupSegmentedSessionRef.current = null;
            }

            const prewarmedSessionCandidate =
                prewarmedSegmentedSessionRef.current.get(sessionKey);
            const prewarmedSession =
                prewarmedSessionCandidate &&
                isSegmentedSessionUsable(prewarmedSessionCandidate)
                    ? prewarmedSessionCandidate
                    : null;
            if (prewarmedSessionCandidate && !prewarmedSession) {
                logSegmentedClientMetric("session.prewarm_discarded", {
                    trackId: track.id,
                    sourceType,
                    reason: "insufficient_ttl",
                    remainingMs: getSegmentedSessionRemainingMs(
                        prewarmedSessionCandidate,
                    ),
                });
                prewarmedSegmentedSessionRef.current.delete(sessionKey);
            }

            const proactiveSession = startupSession ?? prewarmedSession;
            if (!proactiveSession) {
                prewarmSegmentedSession({
                    sessionKey,
                    context: segmentedTrackContext,
                    trackId: track.id,
                    reason: "startup_background",
                });
                void ensureStartupSegmentedSession(
                    track.id,
                    segmentedTrackContext,
                    "proactive_missing",
                );
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "prewarm_not_ready",
                );
                return;
            }

            const activeSegmentedTrackId =
                activeSegmentedSessionRef.current?.trackId ?? null;
            const activeSegmentedPlaybackTrackId =
                activeSegmentedPlaybackTrackIdRef.current;
            const attemptedTrackId =
                segmentedProactiveHandoffAttemptedTrackIdRef.current;
            const eligibility = resolveProactiveSegmentedHandoffEligibility({
                playbackType: playbackTypeRef.current,
                isListenTogether: false,
                currentTrackId: currentTrackRef.current?.id ?? null,
                targetTrackId: track.id,
                activeSegmentedTrackId,
                attemptedTrackId,
            });
            if (!eligibility.eligible) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    eligibility.reason,
                );
                return;
            }
            if (activeSegmentedPlaybackTrackId === track.id) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "already_segmented_source_loaded",
                );
                return;
            }

            const now = Date.now();
            const startupStability = segmentedStartupStabilityRef.current;
            const startupProgressAtMs =
                startupStability.trackId === track.id
                    ? startupStability.firstProgressAtMs
                    : null;
            if (startupProgressAtMs === null) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "startup_stabilizing_no_progress",
                );
                return;
            }
            const startupStableForMs = Math.max(0, now - startupProgressAtMs);
            if (
                startupStableForMs <
                SEGMENTED_PROACTIVE_HANDOFF_MIN_STABLE_PLAYBACK_MS
            ) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "startup_stabilizing",
                    {
                        stableForMs: startupStableForMs,
                        minimumStableMs:
                            SEGMENTED_PROACTIVE_HANDOFF_MIN_STABLE_PLAYBACK_MS,
                    },
                );
                return;
            }

            if (segmentedHandoffInProgressRef.current) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "handoff_in_progress",
                );
                return;
            }
            if (
                segmentedProactiveHandoffAttemptCountRef.current >=
                SEGMENTED_PROACTIVE_HANDOFF_MAX_ATTEMPTS
            ) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "attempt_budget_exhausted",
                    {
                        maxAttempts: SEGMENTED_PROACTIVE_HANDOFF_MAX_ATTEMPTS,
                    },
                );
                return;
            }

            if (
                segmentedProactiveHandoffLastAttemptAtRef.current > 0 &&
                now - segmentedProactiveHandoffLastAttemptAtRef.current <
                    SEGMENTED_PROACTIVE_HANDOFF_COOLDOWN_MS
            ) {
                logProactiveSegmentedHandoffSkip(
                    track.id,
                    sourceType,
                    "cooldown_active",
                    {
                        cooldownMs: SEGMENTED_PROACTIVE_HANDOFF_COOLDOWN_MS,
                        elapsedMs:
                            now - segmentedProactiveHandoffLastAttemptAtRef.current,
                    },
                );
                return;
            }

            segmentedHandoffInProgressRef.current = true;
            segmentedProactiveHandoffAttemptedTrackIdRef.current = track.id;
            segmentedProactiveHandoffAttemptCountRef.current += 1;
            segmentedProactiveHandoffLastAttemptAtRef.current = now;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
            const proactiveAttempt = segmentedProactiveHandoffAttemptCountRef.current;
            const handoffStartedAtMs = Date.now();
            const currentPositionSec = resolveStartupSafeTrackPositionSec(track.id);
            const shouldPlayIntent =
                lastPlayingStateRef.current || howlerEngine.isPlaying() || isPlaying;

            if (shouldPlayIntent) {
                setIsBuffering(true);
                playbackStateMachine.forceTransition("LOADING");
            }

            logSegmentedClientMetric("session.handoff_proactive_attempt", {
                trackId: track.id,
                sourceType:
                    proactiveSession.playbackProfile?.sourceType ??
                    proactiveSession.engineHints?.sourceType ??
                    sourceType,
                sessionId: proactiveSession.sessionId,
                sourceSessionKind: startupSession ? "startup" : "prewarm",
                assetBuildInFlight:
                    proactiveSession.engineHints?.assetBuildInFlight === true,
                attempt: proactiveAttempt,
                shouldPlay: shouldPlayIntent,
            });

            void api
                .handoffSegmentedStreamingSession(
                    proactiveSession.sessionId,
                    proactiveSession.sessionToken,
                    {
                        positionSec: currentPositionSec,
                        isPlaying: shouldPlayIntent,
                    },
                )
                .then((handoff) => {
                    if (
                        playbackTypeRef.current !== "track" ||
                        currentTrackRef.current?.id !== track.id
                    ) {
                        return;
                    }

                    const requestHeaders: Record<string, string> = {
                        "x-streaming-session-token": handoff.sessionToken,
                    };
                    const authToken = api.getStreamingAuthToken();
                    if (authToken) {
                        requestHeaders.Authorization = `Bearer ${authToken}`;
                    }

                    activeSegmentedSessionRef.current = {
                        sessionId: handoff.sessionId,
                        sessionToken: handoff.sessionToken,
                        trackId: track.id,
                        sourceType:
                            handoff.engineHints?.sourceType ?? sourceType,
                        manifestUrl: handoff.manifestUrl,
                        expiresAt: handoff.expiresAt,
                        assetBuildInFlight:
                            handoff.engineHints?.assetBuildInFlight === true,
                    };
                    segmentedColdStartRebufferDeferralRef.current = {
                        trackId: track.id,
                        count: 0,
                    };
                    setStreamProfile({
                        mode: "dash",
                        sourceType:
                            handoff.playbackProfile?.sourceType ??
                            handoff.engineHints?.sourceType ??
                            sourceType,
                        codec: handoff.playbackProfile?.codec?.toUpperCase() ?? "AAC",
                        bitrateKbps: handoff.playbackProfile?.bitrateKbps ?? null,
                    });
                    logSegmentedClientMetric("session.handoff_proactive_api_success", {
                        trackId: track.id,
                        sourceType:
                            handoff.playbackProfile?.sourceType ??
                            handoff.engineHints?.sourceType ??
                            sourceType,
                        previousSessionId: proactiveSession.sessionId,
                        sessionId: handoff.sessionId,
                        attempt: proactiveAttempt,
                        requestedPositionSec: currentPositionSec,
                        serverResumeAtSec: handoff.resumeAtSec,
                        resumeDeltaSec: Math.abs(
                            currentPositionSec - handoff.resumeAtSec
                        ),
                        latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                    });

                    const clearHandoffListeners = () => {
                        howlerEngine.off("load", onHandoffLoad);
                        howlerEngine.off("loaderror", onHandoffLoadError);
                    };

                    const onHandoffLoad = () => {
                        clearHandoffListeners();
                        if (
                            playbackTypeRef.current !== "track" ||
                            currentTrackRef.current?.id !== track.id
                        ) {
                            return;
                        }

                        const localPositionBeforeRecovery =
                            resolveHandoffLocalPositionSec(
                                track.id,
                                currentPositionSec,
                            );
                        const recoveryDecision = resolveLocalAuthoritativeRecovery(
                            {
                                positionSec: localPositionBeforeRecovery,
                                shouldPlay: shouldPlayIntent,
                            },
                            {
                                resumeAtSec: handoff.resumeAtSec,
                                shouldPlay: handoff.shouldPlay,
                            },
                        );

                        const resumeAt = recoveryDecision.resumeAtSec;
                        const shouldResumePlayback = recoveryDecision.shouldPlay;
                        howlerEngine.seek(resumeAt);
                        setCurrentTime(resumeAt);
                        if (shouldResumePlayback) {
                            const playResult = howlerEngine.play();
                            if (
                                playResult &&
                                typeof (playResult as Promise<void>).catch === "function"
                            ) {
                                void (playResult as Promise<void>).catch((playError) => {
                                    logSegmentedClientMetric(
                                        "session.handoff_proactive_resume_play_failure",
                                        {
                                            trackId: track.id,
                                            sourceType,
                                            sessionId: handoff.sessionId,
                                            error:
                                                playError instanceof Error
                                                    ? playError.message
                                                    : String(playError ?? "unknown"),
                                        },
                                    );
                                });
                            }
                            setIsPlaying(true);
                        } else {
                            setIsPlaying(false);
                        }

                        setIsBuffering(false);
                        const resetHandoffBudget = shouldResetHandoffBudgetAfterRecovery(
                            track.id,
                            resumeAt,
                        );
                        if (resetHandoffBudget) {
                            segmentedHandoffAttemptRef.current = 0;
                            segmentedHandoffLastAttemptAtRef.current = 0;
                            resetSegmentedHandoffCircuit(track.id);
                        }
                        segmentedProactiveHandoffCompletedTrackIdRef.current = track.id;
                        segmentedProactiveHandoffAttemptCountRef.current = 0;
                        segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
                        segmentedProactiveHandoffLastSkipKeyRef.current = null;
                        logSegmentedClientMetric("session.handoff_proactive_recovered", {
                            trackId: track.id,
                            sourceType:
                                handoff.playbackProfile?.sourceType ??
                                handoff.engineHints?.sourceType ??
                                sourceType,
                            sessionId: handoff.sessionId,
                            attempt: proactiveAttempt,
                            resumeAtSec: resumeAt,
                            shouldResumePlayback,
                            authority: recoveryDecision.authority,
                            localPositionSec: localPositionBeforeRecovery,
                            serverResumeAtSec: handoff.resumeAtSec,
                            resumeDeltaSec: Math.abs(
                                localPositionBeforeRecovery - handoff.resumeAtSec,
                            ),
                            latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                        });
                    };

                    const onHandoffLoadError = () => {
                        clearHandoffListeners();
                        setIsBuffering(false);
                        segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
                        segmentedProactiveHandoffLastSkipKeyRef.current = null;
                        logSegmentedClientMetric("session.handoff_proactive_load_error", {
                            trackId: track.id,
                            sourceType:
                                handoff.playbackProfile?.sourceType ??
                                handoff.engineHints?.sourceType ??
                                sourceType,
                            sessionId: handoff.sessionId,
                            attempt: proactiveAttempt,
                            latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                        });
                    };

                    howlerEngine.on("load", onHandoffLoad);
                    howlerEngine.on("loaderror", onHandoffLoadError);
                    markSegmentedStartupRampWindow(
                        track.id,
                        "handoff_proactive_load",
                    );
                    activeSegmentedPlaybackTrackIdRef.current = track.id;
                    howlerEngine.load(
                        {
                            url: handoff.manifestUrl,
                            trackId: track.id,
                            sessionId: handoff.sessionId,
                            sourceType:
                                handoff.engineHints?.sourceType ?? sourceType,
                            protocol: "dash",
                            mimeType: "application/dash+xml",
                        },
                        {
                            autoplay: false,
                            format: "mp4",
                            startTimeSec: Math.max(0, currentPositionSec),
                            withCredentials: true,
                            requestHeaders,
                        },
                    );
                })
                .catch((handoffError) => {
                    if (currentTrackRef.current?.id === track.id) {
                        segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
                    }
                    segmentedProactiveHandoffLastSkipKeyRef.current = null;
                    logSegmentedClientMetric("session.handoff_proactive_failure", {
                        trackId: track.id,
                        sourceType:
                            proactiveSession.playbackProfile?.sourceType ??
                            proactiveSession.engineHints?.sourceType ??
                            sourceType,
                        sessionId: proactiveSession.sessionId,
                        attempt: proactiveAttempt,
                        error:
                            handoffError instanceof Error
                                ? handoffError.message
                                : String(handoffError ?? "unknown"),
                        latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                    });
                    setIsBuffering(false);
                })
                .finally(() => {
                    segmentedHandoffInProgressRef.current = false;
                });
        };

        runProactiveSegmentedCheck();
        const proactiveCheckInterval = setInterval(
            runProactiveSegmentedCheck,
            SEGMENTED_PROACTIVE_HANDOFF_RECHECK_MS,
        );

        return () => {
            clearInterval(proactiveCheckInterval);
        };
    }, [
        isPlaying,
        logProactiveSegmentedHandoffSkip,
        playbackType,
        resolveStartupSafeTrackPositionSec,
        resolveHandoffLocalPositionSec,
        ensureStartupSegmentedSession,
        prewarmSegmentedSession,
        setCurrentTime,
        setIsBuffering,
        setIsPlaying,
        setStreamProfile,
        markSegmentedStartupRampWindow,
        isListenTogetherSegmentedPlaybackAllowed,
        shouldResetHandoffBudgetAfterRecovery,
        resetSegmentedHandoffCircuit,
    ]);

    const requestAutoMatchVibe = useCallback(
        (
            seedTrackId: string | null,
            options?: { force?: boolean }
        ): Promise<boolean> => {
            if (!seedTrackId) return Promise.resolve(false);
            if (getListenTogetherSessionSnapshot()?.groupId) {
                return Promise.resolve(false);
            }

            if (autoMatchVibePromiseRef.current) {
                if (autoMatchVibeTrackIdRef.current === seedTrackId) {
                    return autoMatchVibePromiseRef.current;
                }
                return Promise.resolve(false);
            }

            const now = Date.now();
            if (
                !options?.force &&
                autoMatchVibeTrackIdRef.current === seedTrackId &&
                now - autoMatchVibeLastAttemptAtRef.current <
                    AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS
            ) {
                return Promise.resolve(false);
            }

            autoMatchVibeTrackIdRef.current = seedTrackId;
            autoMatchVibeLastAttemptAtRef.current = now;

            const request = startVibeMode()
                .then((result) => result.success && result.trackCount > 0)
                .catch((error) => {
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Auto Match Vibe request failed:",
                        error
                    );
                    return false;
                })
                .finally(() => {
                    autoMatchVibePromiseRef.current = null;
                });

            autoMatchVibePromiseRef.current = request;
            return request;
        },
        [startVibeMode]
    );

    useEffect(() => {
        currentTrackRef.current = currentTrack;
        if (startupSegmentedSessionRef.current?.trackId !== currentTrack?.id) {
            startupSegmentedSessionRef.current = null;
        }
        if (currentTrack?.id !== segmentedProactiveHandoffAttemptedTrackIdRef.current) {
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
        }
        if (currentTrack?.id !== startupRecoveryAttemptedTrackIdRef.current) {
            startupRecoveryAttemptedTrackIdRef.current = null;
        }
        if (currentTrack?.id !== transientTrackRecoveryTrackIdRef.current) {
            clearTransientTrackRecovery(true);
        }
        if (
            activeSegmentedPlaybackTrackIdRef.current &&
            activeSegmentedPlaybackTrackIdRef.current !== currentTrack?.id
        ) {
            activeSegmentedPlaybackTrackIdRef.current = null;
        }
        if (!resolveSegmentedTrackContext(currentTrack)) {
            activeSegmentedSessionRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
            segmentedColdStartRebufferDeferralRef.current = {
                trackId: null,
                count: 0,
            };
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            resetSegmentedHandoffCircuit(null);
            segmentedHandoffInProgressRef.current = false;
            segmentedHandoffLastRecoveryRef.current = {
                trackId: null,
                resumeAtSec: 0,
                recoveredAtMs: 0,
            };
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
            startupSegmentedSessionRef.current = null;
            if (currentTrack) {
                setStreamProfile({
                    mode: "direct",
                    sourceType: resolveDirectTrackSourceType(currentTrack),
                    codec: null,
                    bitrateKbps: null,
                });
            } else {
                setStreamProfile(null);
            }
            return;
        }

        if (
            activeSegmentedSessionRef.current &&
            activeSegmentedSessionRef.current.trackId !== currentTrack.id
        ) {
            activeSegmentedSessionRef.current = null;
            segmentedColdStartRebufferDeferralRef.current = {
                trackId: null,
                count: 0,
            };
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            resetSegmentedHandoffCircuit(null);
            segmentedHandoffInProgressRef.current = false;
            segmentedHandoffLastRecoveryRef.current = {
                trackId: null,
                resumeAtSec: 0,
                recoveredAtMs: 0,
            };
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
            startupSegmentedSessionRef.current = null;
        }
    }, [
        currentTrack,
        clearTransientTrackRecovery,
        setStreamProfile,
        resetSegmentedHandoffCircuit,
    ]);

    useEffect(() => {
        queueLengthRef.current = queue.length;
    }, [queue.length]);

    useEffect(() => {
        playbackTypeRef.current = playbackType;
        if (playbackType !== "track") {
            segmentedStartupRetryCountRef.current = 0;
            segmentedStartupStageAttemptsRef.current =
                createEmptySegmentedStartupRecoveryStageAttempts();
            segmentedStartupRecoveryWindowStartedAtMsRef.current = null;
            segmentedStartupSessionResetCountRef.current = 0;
            markSegmentedStartupRampWindow(null, "playback_type_not_track");
            activeSegmentedSessionRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
            segmentedColdStartRebufferDeferralRef.current = {
                trackId: null,
                count: 0,
            };
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            resetSegmentedHandoffCircuit(null);
            segmentedHandoffInProgressRef.current = false;
            segmentedHandoffLastRecoveryRef.current = {
                trackId: null,
                resumeAtSec: 0,
                recoveredAtMs: 0,
            };
            segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
            segmentedProactiveHandoffAttemptCountRef.current = 0;
            segmentedProactiveHandoffLastAttemptAtRef.current = 0;
            segmentedProactiveHandoffCompletedTrackIdRef.current = null;
            segmentedProactiveHandoffLastSkipKeyRef.current = null;
            startupSegmentedSessionRef.current = null;
            setStreamProfile(null);
        }
    }, [
        playbackType,
        setStreamProfile,
        markSegmentedStartupRampWindow,
        resetSegmentedHandoffCircuit,
    ]);

    useEffect(() => {
        if (playbackType !== "track") {
            return;
        }

        const heartbeatInterval = setInterval(() => {
            const activeSession = activeSegmentedSessionRef.current;
            if (!activeSession) return;
            if (segmentedHandoffInProgressRef.current) return;
            if (currentTrackRef.current?.id !== activeSession.trackId) return;

            const positionSec = Math.max(
                0,
                typeof howlerEngine.getActualCurrentTime === "function"
                    ? howlerEngine.getActualCurrentTime()
                    : howlerEngine.getCurrentTime()
            );
            const currentlyPlaying =
                howlerEngine.isPlaying() || lastPlayingStateRef.current;

            void api
                .heartbeatSegmentedStreamingSession(
                    activeSession.sessionId,
                    activeSession.sessionToken,
                    {
                        positionSec,
                        isPlaying: currentlyPlaying,
                    }
                )
                .then((heartbeat) => {
                    const sessionSnapshot = activeSegmentedSessionRef.current;
                    if (
                        !sessionSnapshot ||
                        sessionSnapshot.sessionId !== activeSession.sessionId
                    ) {
                        return;
                    }

                    activeSegmentedSessionRef.current = {
                        ...sessionSnapshot,
                        sessionToken: heartbeat.sessionToken,
                        expiresAt: heartbeat.expiresAt,
                    };
                })
                .catch((error) => {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Segmented heartbeat failed:",
                        error
                    );
                    const errorMessage =
                        error instanceof Error
                            ? error.message
                            : String(error ?? "unknown");
                    const sessionMissing =
                        /session not found/i.test(errorMessage) ||
                        /session_not_found/i.test(errorMessage) ||
                        /404/.test(errorMessage);
                    if (!sessionMissing) {
                        return;
                    }

                    const latestSession = activeSegmentedSessionRef.current;
                    if (
                        latestSession &&
                        latestSession.sessionId === activeSession.sessionId
                    ) {
                        activeSegmentedSessionRef.current = null;
                    }
                    segmentedHandoffInProgressRef.current = false;
                    logSegmentedClientMetric("session.heartbeat_missing", {
                        trackId: activeSession.trackId,
                        sourceType: activeSession.sourceType,
                        sessionId: activeSession.sessionId,
                        error: errorMessage,
                    });

                    const trackSnapshot = currentTrackRef.current;
                    const segmentedTrackContext =
                        resolveSegmentedTrackContext(trackSnapshot);
                    if (
                        trackSnapshot &&
                        trackSnapshot.id === activeSession.trackId &&
                        segmentedTrackContext
                    ) {
                        void ensureStartupSegmentedSession(
                            trackSnapshot.id,
                            segmentedTrackContext,
                            "prewarm_asset_build_inflight",
                        );
                    }
                });
        }, SEGMENTED_HEARTBEAT_INTERVAL_MS);

        return () => {
            clearInterval(heartbeatInterval);
        };
    }, [playbackType, currentTrack?.id, ensureStartupSegmentedSession]);

    useEffect(() => {
        const shouldAutoMatchVibe = shouldAutoMatchVibeAtQueueEnd({
            playbackType,
            queueLength: queue.length,
            currentIndex,
            repeatMode,
            isListenTogether: Boolean(
                getListenTogetherSessionSnapshot()?.groupId
            ),
        });

        if (!shouldAutoMatchVibe || !currentTrack?.id) {
            return;
        }

        void requestAutoMatchVibe(currentTrack.id);
    }, [
        playbackType,
        queue.length,
        currentIndex,
        repeatMode,
        currentTrack?.id,
        requestAutoMatchVibe,
    ]);

    useEffect(() => {
        if (playbackType !== "track") {
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            return;
        }

        if (
            pendingTrackErrorTrackIdRef.current &&
            pendingTrackErrorTrackIdRef.current !== currentTrack?.id
        ) {
            clearPendingTrackErrorSkip();
        }
    }, [
        playbackType,
        currentTrack?.id,
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
    ]);

    // Initialize heartbeat monitor
    useEffect(() => {
        heartbeatRef.current = new HeartbeatMonitor({
            onStall: () => {
                // Playback stalled - time not moving but Howler says playing
                sharedFrontendLogger.warn("[AudioPlaybackOrchestrator] Heartbeat detected stall");
                logSegmentedClientMetric("player.rebuffer", {
                    reason: "heartbeat_stall",
                    trackId: currentTrackRef.current?.id ?? null,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType: activeSegmentedSessionRef.current?.sourceType ?? "direct",
                });
                const transitionedToBuffering =
                    playbackStateMachine.transition("BUFFERING");
                if (
                    !transitionedToBuffering &&
                    !playbackStateMachine.isBuffering
                ) {
                    // Keep machine + React state aligned even after event-race transitions.
                    playbackStateMachine.forceTransition("BUFFERING");
                }
                setIsBuffering(true);
                heartbeatRef.current?.startBufferTimeout();
            },
            onUnexpectedStop: () => {
                // Howler stopped without us knowing
                const trackId = currentTrackRef.current?.id ?? null;
                const startupStability = segmentedStartupStabilityRef.current;
                const startupNoProgress =
                    playbackTypeRef.current === "track" &&
                    Boolean(trackId) &&
                    startupStability.trackId === trackId &&
                    startupStability.firstProgressAtMs === null;
                const suppressionReason = segmentedHandoffInProgressRef.current
                    ? "handoff_in_progress"
                    : seekReloadInProgressRef.current
                      ? "seek_reload_in_progress"
                      : isLoadingRef.current
                        ? "load_in_progress"
                        : startupNoProgress
                          ? "startup_no_progress"
                          : null;
                if (suppressionReason) {
                    if (trackId && startupNoProgress) {
                        segmentedUnexpectedStopStartupGuardRef.current = {
                            trackId,
                            suppressUntilMs:
                                Date.now() +
                                resolveSegmentedUnexpectedStopStartupGuardMs(),
                            reason: "startup_no_progress",
                        };
                        scheduleStartupPlaybackRecovery(trackId);
                    }
                    logSegmentedClientMetric("player.unexpected_stop_suppressed", {
                        reason: suppressionReason,
                        trackId,
                        sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ?? "direct",
                    });
                    return;
                }

                const startupGuard = segmentedUnexpectedStopStartupGuardRef.current;
                const startupGuardActive =
                    playbackTypeRef.current === "track" &&
                    Boolean(trackId) &&
                    startupGuard.trackId === trackId &&
                    Date.now() < startupGuard.suppressUntilMs;
                if (startupGuardActive) {
                    logSegmentedClientMetric("player.unexpected_stop_suppressed", {
                        reason: "startup_guard_active",
                        trackId,
                        sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ?? "direct",
                        guardReason: startupGuard.reason,
                        guardRemainingMs: Math.max(
                            0,
                            startupGuard.suppressUntilMs - Date.now(),
                        ),
                    });
                    return;
                }

                sharedFrontendLogger.warn("[AudioPlaybackOrchestrator] Heartbeat detected unexpected stop");
                logSegmentedClientMetric("player.unexpected_stop", {
                    reason: "heartbeat_unexpected_stop",
                    trackId,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType: activeSegmentedSessionRef.current?.sourceType ?? "direct",
                });

                if (!lastPlayingStateRef.current) {
                    if (playbackStateMachine.isPlaying) {
                        // User intent is paused; align machine state only.
                        playbackStateMachine.forceTransition("READY");
                    }
                    return;
                }

                if (playbackTypeRef.current !== "track") {
                    setIsPlaying(false);
                    setIsBuffering(false);
                    playbackStateMachine.forceTransition("READY");
                    return;
                }

                const stopError = new Error(
                    "Playback stopped unexpectedly during heartbeat monitoring"
                );
                const failedTrackId = currentTrackRef.current?.id ?? null;
                setIsBuffering(true);
                playbackStateMachine.forceTransition("LOADING");

                void attemptSegmentedHandoffRecovery(stopError).then(
                    (didRecoverWithHandoff) => {
                        if (didRecoverWithHandoff) {
                            return;
                        }

                        const didScheduleTransientRecovery =
                            attemptTransientTrackRecovery(
                                failedTrackId,
                                stopError
                            );
                        if (didScheduleTransientRecovery) {
                            playbackStateMachine.forceTransition("LOADING");
                            setIsBuffering(true);
                            return;
                        }

                        setIsPlaying(false);
                        setIsBuffering(false);
                        playbackStateMachine.forceTransition("READY");
                    }
                );
            },
            onBufferTimeout: () => {
                const activeSession = activeSegmentedSessionRef.current;
                const activeTrackId = currentTrackRef.current?.id ?? null;
                if (
                    playbackTypeRef.current === "track" &&
                    activeSession?.assetBuildInFlight &&
                    activeTrackId &&
                    activeSession.trackId === activeTrackId
                ) {
                    const currentPositionSec = Math.max(
                        0,
                        typeof howlerEngine.getActualCurrentTime === "function"
                            ? howlerEngine.getActualCurrentTime()
                            : howlerEngine.getCurrentTime(),
                    );
                    if (
                        currentPositionSec <=
                        SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC
                    ) {
                        const deferralState =
                            segmentedColdStartRebufferDeferralRef.current;
                        if (deferralState.trackId !== activeTrackId) {
                            deferralState.trackId = activeTrackId;
                            deferralState.count = 0;
                        }

                        if (
                            deferralState.count <
                            SEGMENTED_COLD_START_REBUFFER_MAX_DEFERRALS
                        ) {
                            deferralState.count += 1;
                            heartbeatRef.current?.updateConfig({
                                bufferTimeout:
                                    SEGMENTED_COLD_START_REBUFFER_TIMEOUT_MS,
                            });
                            heartbeatRef.current?.startBufferTimeout();
                            logSegmentedClientMetric(
                                "player.rebuffer_timeout_deferred",
                                {
                                    reason: "asset_build_inflight_cold_start",
                                    trackId: activeTrackId,
                                    sessionId: activeSession.sessionId,
                                    sourceType: activeSession.sourceType,
                                    deferCount: deferralState.count,
                                    maxDeferrals:
                                        SEGMENTED_COLD_START_REBUFFER_MAX_DEFERRALS,
                                    currentPositionSec,
                                    nextTimeoutMs:
                                        SEGMENTED_COLD_START_REBUFFER_TIMEOUT_MS,
                                },
                            );
                            return;
                        }
                    }
                }

                // Been buffering too long - likely connection lost
                heartbeatRef.current?.updateConfig({
                    bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
                });
                sharedFrontendLogger.error("[AudioPlaybackOrchestrator] Buffer timeout - connection may be lost");
                logSegmentedClientMetric("player.rebuffer_timeout", {
                    reason: "heartbeat_buffer_timeout",
                    trackId: currentTrackRef.current?.id ?? null,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType: activeSegmentedSessionRef.current?.sourceType ?? "direct",
                });
                const timeoutError = new Error(
                    "Connection lost - audio stream timed out"
                );
                const failPlayback = () => {
                    if (howlerEngine.isPlaying()) {
                        howlerEngine.pause();
                    }
                    playbackStateMachine.transition("ERROR", {
                        error: timeoutError.message,
                        errorCode: 408,
                    });
                    setIsPlaying(false);
                    setIsBuffering(false);
                    heartbeatRef.current?.stop();
                };

                if (playbackTypeRef.current !== "track") {
                    failPlayback();
                    return;
                }

                const failedTrackId = currentTrackRef.current?.id ?? null;
                void attemptSegmentedHandoffRecovery(timeoutError).then(
                    (didRecoverWithHandoff) => {
                        if (didRecoverWithHandoff) {
                            return;
                        }

                        const didScheduleTransientRecovery =
                            attemptTransientTrackRecovery(
                                failedTrackId,
                                timeoutError
                            );
                        if (didScheduleTransientRecovery) {
                            playbackStateMachine.forceTransition("LOADING");
                            setIsBuffering(true);
                            return;
                        }

                        failPlayback();
                    }
                );
            },
            onRecovery: () => {
                // Recovered from stall
                heartbeatRef.current?.updateConfig({
                    bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
                });
                sharedFrontendLogger.info("[AudioPlaybackOrchestrator] Recovered from stall");
                logSegmentedClientMetric("player.rebuffer_recovered", {
                    reason: "heartbeat_recovery",
                    trackId: currentTrackRef.current?.id ?? null,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType: activeSegmentedSessionRef.current?.sourceType ?? "direct",
                });
                const enginePlaying = howlerEngine.isPlaying();
                const recoveryAction = resolveBufferingRecoveryAction({
                    machineIsBuffering: playbackStateMachine.isBuffering,
                    machineIsPlaying: playbackStateMachine.isPlaying,
                    engineIsPlaying: enginePlaying,
                });
                if (recoveryAction === "transition_playing") {
                    playbackStateMachine.transition("PLAYING");
                } else if (recoveryAction === "force_playing") {
                    playbackStateMachine.forceTransition("PLAYING");
                }
                setIsBuffering(false);
                setIsPlaying(enginePlaying);
            },
            getCurrentTime: () => howlerEngine.getCurrentTime(),
            isActuallyPlaying: () => howlerEngine.isPlaying(),
        }, {
            bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
        });

        return () => {
            heartbeatRef.current?.destroy();
            heartbeatRef.current = null;
        };
    }, [
        attemptSegmentedHandoffRecovery,
        attemptTransientTrackRecovery,
        scheduleStartupPlaybackRecovery,
        setIsBuffering,
        setIsPlaying,
    ]);

    // Keep heartbeat active while buffering so stall timeouts can still fire.
    useEffect(() => {
        if (isPlaying || isBuffering) {
            heartbeatRef.current?.start();
        } else {
            heartbeatRef.current?.stop();
        }
    }, [isPlaying, isBuffering]);

    // Prefetch lyrics in the background as soon as a track is loaded.
    useEffect(() => {
        if (playbackType !== "track" || !currentTrack?.id) return;

        const metadata: LyricsLookupMetadata = {
            artist: currentTrack.artist?.name,
            title: currentTrack.displayTitle || currentTrack.title,
            album: currentTrack.album?.title,
            duration: currentTrack.duration,
        };

        queryClient.prefetchQuery({
            queryKey: lyricsQueryKeys.lyrics(currentTrack.id, metadata),
            queryFn: () => fetchLyrics(currentTrack.id, metadata),
            staleTime: LYRICS_QUERY_STALE_TIME,
        });
    }, [
        queryClient,
        playbackType,
        currentTrack?.id,
        currentTrack?.artist?.name,
        currentTrack?.displayTitle,
        currentTrack?.title,
        currentTrack?.album?.title,
        currentTrack?.duration,
    ]);

    // Reset duration when nothing is playing
    useEffect(() => {
        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            setDuration(0);
        }
    }, [currentTrack, currentAudiobook, currentPodcast, setDuration]);

    // Save audiobook progress
    const saveAudiobookProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentAudiobook) return;

            const currentTime = howlerEngine.getCurrentTime();
            const duration =
                howlerEngine.getDuration() || currentAudiobook.duration;

            if (currentTime === lastProgressSaveRef.current && !isFinished)
                return;
            lastProgressSaveRef.current = currentTime;

            try {
                await api.updateAudiobookProgress(
                    currentAudiobook.id,
                    isFinished ? duration : currentTime,
                    duration,
                    isFinished
                );

                setCurrentAudiobook({
                    ...currentAudiobook,
                    progress: {
                        currentTime: isFinished ? duration : currentTime,
                        progress:
                            duration > 0
                                ? ((isFinished ? duration : currentTime) /
                                      duration) *
                                  100
                                : 0,
                        isFinished,
                        lastPlayedAt: new Date(),
                    },
                });

                dispatchQueryEvent("audiobook-progress-updated");
            } catch (err) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Failed to save audiobook progress:",
                    err
                );
            }
        },
        [currentAudiobook, setCurrentAudiobook]
    );

    // Save podcast progress
    const savePodcastProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentPodcast) return;

            if (isBuffering && !isFinished) return;

            const currentTime = howlerEngine.getCurrentTime();
            const duration =
                howlerEngine.getDuration() || currentPodcast.duration;

            if (currentTime <= 0 && !isFinished) return;

            try {
                const [podcastId, episodeId] = currentPodcast.id.split(":");
                await api.updatePodcastProgress(
                    podcastId,
                    episodeId,
                    isFinished ? duration : currentTime,
                    duration,
                    isFinished
                );

                dispatchQueryEvent("podcast-progress-updated");
            } catch (err) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Failed to save podcast progress:",
                    err
                );
            }
        },
        [currentPodcast, isBuffering]
    );

    // Subscribe to Howler events
    useEffect(() => {
        const handleTimeUpdate = (data: {
            timeSec: number;
            time?: number;
        }) => {
            const currentTimeValue =
                typeof data.timeSec === "number" ? data.timeSec : data.time ?? 0;
            // Use setCurrentTimeFromEngine to respect seek lock
            // This prevents stale timeupdate events from overwriting optimistic seek updates
            setCurrentTimeFromEngine(currentTimeValue);
            if (playbackTypeRef.current === "track") {
                lastTrackTimeUpdateAtMsRef.current = Date.now();
                if (howlerEngine.isPlaying()) {
                    clearUnexpectedPauseRecoveryCheck();
                }
                noteSegmentedStartupProgress(
                    currentTrackRef.current?.id ?? null,
                    currentTimeValue,
                );
                noteSegmentedStartupAudible(
                    currentTrackRef.current?.id ?? null,
                    currentTimeValue,
                );
            }

            // Notify heartbeat of progress to detect stalls
            heartbeatRef.current?.notifyProgress(currentTimeValue);

            const activeSession = activeSegmentedSessionRef.current;
            if (
                activeSession?.assetBuildInFlight &&
                currentTrackRef.current?.id === activeSession.trackId &&
                currentTimeValue > SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC
            ) {
                activeSegmentedSessionRef.current = {
                    ...activeSession,
                    assetBuildInFlight: false,
                };
                segmentedColdStartRebufferDeferralRef.current = {
                    trackId: activeSession.trackId,
                    count: 0,
                };
                heartbeatRef.current?.updateConfig({
                    bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
                });
            }
        };

        const handleLoad = (data: {
            durationSec: number;
            duration?: number;
        }) => {
            const loadedDuration =
                typeof data.durationSec === "number"
                    ? data.durationSec
                    : data.duration ?? 0;
            const fallbackDuration =
                currentTrack?.duration ||
                currentAudiobook?.duration ||
                currentPodcast?.duration ||
                0;
            setDuration(loadedDuration || fallbackDuration);
            clearTransientTrackRecovery(true);

            // Transition state machine - load complete
            if (playbackStateMachine.getState() === "LOADING") {
                playbackStateMachine.transition("READY");
            }

            if (
                playbackType === "track" &&
                currentTrack?.id &&
                (lastPlayingStateRef.current || isPlaying)
            ) {
                scheduleStartupPlaybackRecovery(currentTrack.id);
            }

        };

        const handleEnd = () => {
            const isListenTogether = Boolean(
                getListenTogetherSessionSnapshot()?.groupId
            );
            if (playbackType === "track") {
                if (isLoadingRef.current) {
                    return;
                }
                const currentTrackId = currentTrackRef.current?.id ?? null;
                const activeEngineTrackId = activeEngineTrackIdRef.current;
                if (
                    currentTrackId &&
                    activeEngineTrackId &&
                    currentTrackId !== activeEngineTrackId
                ) {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Ignoring stale Listen Together track end event",
                        {
                            currentTrackId,
                            activeEngineTrackId,
                        }
                    );
                    return;
                }

                const activeLoadId = loadIdRef.current;
                const now = Date.now();
                const lastHandled = lastHandledTrackEndRef.current;
                if (repeatMode !== "one") {
                    if (
                        currentTrackId &&
                        lastHandled.trackId === currentTrackId &&
                        lastHandled.loadId === activeLoadId &&
                        now - lastHandled.handledAtMs < 1500
                    ) {
                        sharedFrontendLogger.warn(
                            "[AudioPlaybackOrchestrator] Ignoring duplicate track end event",
                            {
                                currentTrackId,
                                activeLoadId,
                                sinceLastHandledMs: now - lastHandled.handledAtMs,
                            }
                        );
                        return;
                    }
                    lastHandledTrackEndRef.current = {
                        trackId: currentTrackId,
                        loadId: activeLoadId,
                        handledAtMs: now,
                    };
                }
            }

            // Save final progress for audiobooks/podcasts
            if (playbackType === "audiobook" && currentAudiobook) {
                saveAudiobookProgress(true);
            } else if (playbackType === "podcast" && currentPodcast) {
                savePodcastProgress(true);
            }

            // Handle track advancement based on playback type
            if (playbackType === "podcast") {
                nextPodcastEpisode(); // Auto-advance to next episode
            } else if (playbackType === "audiobook") {
                pause();
            } else if (playbackType === "track") {
                if (repeatMode === "one") {
                    howlerEngine.seek(0);
                    howlerEngine.play();
                } else {
                    const shouldAutoMatchVibe = shouldAutoMatchVibeAtQueueEnd({
                        playbackType,
                        queueLength: queue.length,
                        currentIndex,
                        repeatMode,
                        isListenTogether,
                    });

                    if (!shouldAutoMatchVibe || !currentTrack?.id) {
                        next();
                        return;
                    }

                    const endedTrackId = currentTrack.id;
                    void requestAutoMatchVibe(endedTrackId, {
                        force: true,
                    }).finally(() => {
                        if (currentTrackRef.current?.id !== endedTrackId) return;
                        next();
                    });
                }
            } else {
                pause();
            }
        };

        const handleError = async (data: { error: unknown }) => {
            sharedFrontendLogger.error("[AudioPlaybackOrchestrator] Playback error:", data.error);

            const errorMessage = data.error instanceof Error
                ? data.error.message
                : String(data.error);

            if (playbackType === "track") {
                const didRecoverWithHandoff = await attemptSegmentedHandoffRecovery(
                    data.error
                );
                if (didRecoverWithHandoff) {
                    return;
                }

                const failedTrackId = currentTrack?.id ?? null;
                const isTransientRecoveryScheduled = attemptTransientTrackRecovery(
                    failedTrackId,
                    data.error
                );

                if (isTransientRecoveryScheduled) {
                    logSegmentedClientMetric("player.rebuffer", {
                        reason: "transient_track_recovery",
                        trackId: failedTrackId,
                        sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            resolveDirectTrackSourceType(currentTrack),
                    });
                    playbackStateMachine.forceTransition("LOADING");
                    setIsBuffering(true);
                    return;
                }
            }

            // Transition state machine to ERROR
            playbackStateMachine.forceTransition("ERROR", {
                error: errorMessage,
            });

            // Show a descriptive toast for YouTube-sourced tracks that fail
            if (playbackType === "track" && currentTrack?.streamSource === "youtube") {
                toast.error(
                    `Couldn't stream "${currentTrack.title}" from YouTube Music — it may be age-restricted or unavailable.`,
                    { duration: 5000 }
                );
            }

            setIsPlaying(false);
            setIsBuffering(false);
            logSegmentedClientMetric("player.playback_error", {
                trackId: currentTrack?.id ?? null,
                sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                sourceType:
                    activeSegmentedSessionRef.current?.sourceType ??
                    (currentTrack ? resolveDirectTrackSourceType(currentTrack) : "unknown"),
                error: errorMessage,
            });
            emitSegmentedStartupTimeline("playback_error", {
                error: errorMessage,
            });
            isUserInitiatedRef.current = false;
            heartbeatRef.current?.stop();
            clearTransientTrackRecovery(true);

            if (playbackType === "track") {
                const failedTrackId = currentTrack?.id ?? null;
                if (queue.length > 1) {
                    scheduleTrackErrorSkip(failedTrackId);
                } else {
                    clearPendingTrackErrorSkip();
                    lastTrackIdRef.current = null;
                    isLoadingRef.current = false;
                    setCurrentTrack(null);
                    setPlaybackType(null);
                }
            } else if (playbackType === "audiobook") {
                clearPendingTrackErrorSkip();
                setCurrentAudiobook(null);
                setPlaybackType(null);
            } else if (playbackType === "podcast") {
                clearPendingTrackErrorSkip();
                setCurrentPodcast(null);
                setPlaybackType(null);
            }
        };

        const handleVhsResponse = (data: AudioEngineVhsResponsePayload) => {
            noteSegmentedStartupVhsResponse(data);
        };

        const handlePlay = () => {
            // Transition state machine to PLAYING
            playbackStateMachine.transition("PLAYING");
            clearUnexpectedPauseRecoveryCheck();
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            if (playbackTypeRef.current === "track") {
                lastTrackTimeUpdateAtMsRef.current = Date.now();
            }

            if (!isUserInitiatedRef.current) {
                setIsPlaying(true);
            }
            isUserInitiatedRef.current = false;
        };

        const handlePause = () => {
            if (isLoadingRef.current) return;
            if (seekReloadInProgressRef.current) return;
            if (segmentedHandoffInProgressRef.current) {
                // Pause can occur transiently while reloading source during handoff.
                isUserInitiatedRef.current = false;
                return;
            }
            clearUnexpectedPauseRecoveryCheck();

            const currentPositionSec = Math.max(
                0,
                typeof howlerEngine.getActualCurrentTime === "function"
                    ? howlerEngine.getActualCurrentTime()
                    : howlerEngine.getCurrentTime()
            );
            const durationSec = howlerEngine.getDuration();
            const nearTrackEnd =
                Number.isFinite(durationSec) &&
                durationSec > 0 &&
                durationSec - currentPositionSec <= 0.75;
            const hasPlayIntent =
                playbackStateMachine.isPlaying ||
                isPlaying ||
                lastPlayingStateRef.current;
            const isNonUserPause = !isUserInitiatedRef.current;

            const shouldAttemptUnexpectedPauseRecovery =
                playbackType === "track" &&
                isNonUserPause &&
                hasPlayIntent &&
                !nearTrackEnd;

            if (shouldAttemptUnexpectedPauseRecovery) {
                const pauseObservedAtMs = Date.now();
                const pausedTrackId = currentTrack?.id ?? null;

                const finalizeAsRegularPause = () => {
                    if (playbackStateMachine.isPlaying) {
                        playbackStateMachine.transition("READY");
                    }
                    if (!isUserInitiatedRef.current) {
                        setIsPlaying(false);
                    }
                };

                const runUnexpectedPauseRecoveryCheck = () => {
                    unexpectedPauseRecoveryTimeoutRef.current = null;

                    if (
                        playbackTypeRef.current !== "track" ||
                        segmentedHandoffInProgressRef.current ||
                        seekReloadInProgressRef.current ||
                        isLoadingRef.current
                    ) {
                        return;
                    }

                    const liveTrackId = currentTrackRef.current?.id ?? null;
                    if (!liveTrackId || liveTrackId !== pausedTrackId) {
                        return;
                    }

                    const stillPaused = !howlerEngine.isPlaying();
                    if (!stillPaused) {
                        return;
                    }

                    const silenceSinceTimeUpdateMs = Math.max(
                        0,
                        Date.now() - lastTrackTimeUpdateAtMsRef.current,
                    );
                    if (
                        silenceSinceTimeUpdateMs <
                        SEGMENTED_PAUSE_RECOVERY_MIN_SILENCE_MS
                    ) {
                        const remainingSilenceMs =
                            SEGMENTED_PAUSE_RECOVERY_MIN_SILENCE_MS -
                            silenceSinceTimeUpdateMs;
                        unexpectedPauseRecoveryTimeoutRef.current = setTimeout(
                            runUnexpectedPauseRecoveryCheck,
                            Math.min(
                                SEGMENTED_PAUSE_RECOVERY_DEBOUNCE_MS,
                                Math.max(remainingSilenceMs, 50),
                            ),
                        );
                        return;
                    }

                    const bufferedAheadSec = resolveBufferedAheadSec();
                    const hasBufferedAheadMeasurement = Number.isFinite(bufferedAheadSec);
                    const hasLowBufferedAhead =
                        shouldAttemptSegmentedRecoveryOnUnexpectedPause(
                            bufferedAheadSec,
                            SEGMENTED_PAUSE_RECOVERY_MAX_BUFFERED_AHEAD_SEC,
                        );

                    if (!hasBufferedAheadMeasurement) {
                        logSegmentedClientMetric("player.unexpected_pause", {
                            reason: "pause_without_buffered_ahead_measurement",
                            trackId: liveTrackId,
                            sessionId:
                                activeSegmentedSessionRef.current?.sessionId ?? null,
                            sourceType:
                                activeSegmentedSessionRef.current?.sourceType ??
                                (currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown"),
                            hasPlayIntent,
                            nearTrackEnd,
                            bufferedAheadSec,
                            silenceSinceTimeUpdateMs,
                        });
                        finalizeAsRegularPause();
                        return;
                    }

                    if (!hasLowBufferedAhead) {
                        logSegmentedClientMetric("player.unexpected_pause", {
                            reason: "pause_with_buffered_ahead",
                            trackId: liveTrackId,
                            sessionId:
                                activeSegmentedSessionRef.current?.sessionId ?? null,
                            sourceType:
                                activeSegmentedSessionRef.current?.sourceType ??
                                (currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown"),
                            hasPlayIntent,
                            nearTrackEnd,
                            bufferedAheadSec,
                            silenceSinceTimeUpdateMs,
                        });
                        finalizeAsRegularPause();
                        return;
                    }

                    const pauseError = new Error(
                        "Playback paused unexpectedly while track intent is playing"
                    );
                    logSegmentedClientMetric("player.unexpected_pause", {
                        reason: "engine_pause_while_play_intent_stall_confirmed",
                        trackId: liveTrackId,
                        sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            (currentTrackRef.current
                                ? resolveDirectTrackSourceType(currentTrackRef.current)
                                : "unknown"),
                        hasPlayIntent,
                        nearTrackEnd,
                        bufferedAheadSec,
                        silenceSinceTimeUpdateMs,
                        debounceElapsedMs: Math.max(
                            0,
                            Date.now() - pauseObservedAtMs,
                        ),
                        stateMachineState: playbackStateMachine.getState(),
                        uiIsPlaying: isPlaying,
                    });
                    setIsBuffering(true);
                    playbackStateMachine.forceTransition("LOADING");
                    void attemptSegmentedHandoffRecovery(pauseError).then(
                        (didRecoverWithHandoff) => {
                            if (didRecoverWithHandoff) {
                                return;
                            }

                            const didScheduleTransientRecovery =
                                attemptTransientTrackRecovery(
                                    liveTrackId,
                                    pauseError
                                );
                            if (didScheduleTransientRecovery) {
                                playbackStateMachine.forceTransition("LOADING");
                                setIsBuffering(true);
                                return;
                            }

                            setIsPlaying(false);
                            setIsBuffering(false);
                            playbackStateMachine.forceTransition("READY");
                        }
                    );
                };

                unexpectedPauseRecoveryTimeoutRef.current = setTimeout(
                    runUnexpectedPauseRecoveryCheck,
                    SEGMENTED_PAUSE_RECOVERY_DEBOUNCE_MS,
                );
                isUserInitiatedRef.current = false;
                return;
            }
            if (isNonUserPause && playbackType === "track") {
                logSegmentedClientMetric("player.unexpected_pause", {
                    reason: nearTrackEnd
                        ? "pause_near_track_end"
                        : "pause_without_play_intent",
                    trackId: currentTrack?.id ?? null,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType:
                        activeSegmentedSessionRef.current?.sourceType ??
                        (currentTrack
                            ? resolveDirectTrackSourceType(currentTrack)
                            : "unknown"),
                    hasPlayIntent,
                    nearTrackEnd,
                    stateMachineState: playbackStateMachine.getState(),
                    uiIsPlaying: isPlaying,
                });
            }

            // Transition state machine to READY (paused)
            if (playbackStateMachine.isPlaying) {
                playbackStateMachine.transition("READY");
            }

            if (!isUserInitiatedRef.current) {
                setIsPlaying(false);
            }
            isUserInitiatedRef.current = false;
        };

        howlerEngine.on("timeupdate", handleTimeUpdate);
        howlerEngine.on("load", handleLoad);
        howlerEngine.on("end", handleEnd);
        howlerEngine.on("loaderror", handleError);
        howlerEngine.on("playerror", handleError);
        howlerEngine.on("play", handlePlay);
        howlerEngine.on("pause", handlePause);
        howlerEngine.on("vhsresponse", handleVhsResponse);

        return () => {
            clearUnexpectedPauseRecoveryCheck();
            howlerEngine.off("timeupdate", handleTimeUpdate);
            howlerEngine.off("load", handleLoad);
            howlerEngine.off("end", handleEnd);
            howlerEngine.off("loaderror", handleError);
            howlerEngine.off("playerror", handleError);
            howlerEngine.off("play", handlePlay);
            howlerEngine.off("pause", handlePause);
            howlerEngine.off("vhsresponse", handleVhsResponse);
        };
    }, [
        playbackType,
        currentTrack,
        currentAudiobook,
        currentPodcast,
        repeatMode,
        next,
        nextPodcastEpisode,
        pause,
        setCurrentTimeFromEngine,
        setDuration,
        setIsPlaying,
        setIsBuffering,
        queue,
        currentIndex,
        requestAutoMatchVibe,
        setCurrentTrack,
        setCurrentAudiobook,
        setCurrentPodcast,
        setPlaybackType,
        saveAudiobookProgress,
        savePodcastProgress,
        scheduleTrackErrorSkip,
        clearPendingTrackErrorSkip,
        clearUnexpectedPauseRecoveryCheck,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
        attemptSegmentedHandoffRecovery,
        attemptTransientTrackRecovery,
        isPlaying,
        resolveBufferedAheadSec,
        scheduleStartupPlaybackRecovery,
        emitSegmentedStartupTimeline,
        noteSegmentedStartupAudible,
        noteSegmentedStartupProgress,
        noteSegmentedStartupVhsResponse,
    ]);

    // Load and play audio when track changes
    useEffect(() => {
        // Keep queue-triggered loads aligned with the latest UI output state,
        // even when track and volume updates are committed in the same render.
        outputStateRef.current = { volume, isMuted };

        const currentMediaId =
            currentTrack?.id ||
            currentAudiobook?.id ||
            currentPodcast?.id ||
            null;

        if (!currentMediaId) {
            markSegmentedStartupRampWindow(null, "media_cleared");
            setStreamProfile(null);
            segmentedStartupTimelineRef.current = null;
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            clearSegmentedStartupFallback();
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            loadTimeoutRetryCountRef.current = 0;
            activeEngineTrackIdRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
            howlerEngine.stop();
            lastTrackIdRef.current = null;
            isLoadingRef.current = false;
            playbackStateMachine.forceTransition("IDLE");
            heartbeatRef.current?.stop();
            return;
        }

        const previousMediaId = lastTrackIdRef.current;
        if (currentMediaId !== previousMediaId) {
            segmentedStartupTimelineRef.current = null;
        }

        if (currentMediaId === previousMediaId) {
            // Skip if a seek operation is in progress - the seek handler will manage playback
            if (isSeekingRef.current) {
                return;
            }

            // Skip if the track is still loading — the load-complete handler
            // will start playback.  Without this guard, a second play click
            // during loading can race with the load callback and produce
            // overlapping audio streams.
            if (isLoadingRef.current) {
                return;
            }

            const shouldPlay = lastPlayingStateRef.current || isPlaying;
            const isCurrentlyPlaying = howlerEngine.isPlaying();

            if (shouldPlay && !isCurrentlyPlaying) {
                applyCurrentOutputState();
                howlerEngine.play();
            }
            return;
        }

        if (isLoadingRef.current) return;

        isLoadingRef.current = true;
        activeEngineTrackIdRef.current = null;
        lastTrackIdRef.current = currentMediaId;
        loadIdRef.current += 1;
        const thisLoadId = loadIdRef.current;
        loadTimeoutRetryCountRef.current = 0;
        segmentedStartupRetryCountRef.current = 0;
        segmentedStartupStageAttemptsRef.current =
            createEmptySegmentedStartupRecoveryStageAttempts();
        segmentedStartupRecoveryWindowStartedAtMsRef.current = Date.now();
        segmentedStartupSessionResetCountRef.current = 0;
        if (playbackType === "track" && currentTrack) {
            markSegmentedStartupRampWindow(currentTrack.id, "track_load_started");
        } else {
            markSegmentedStartupRampWindow(null, "non_track_load_started");
        }

        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
        }

        // Transition state machine to LOADING
        playbackStateMachine.forceTransition("LOADING");

        let streamUrl: string | null = null;
        let startTime = 0;

        if (playbackType === "track" && currentTrack) {
            // TIDAL streaming takes priority
            if (currentTrack.streamSource === "tidal" && currentTrack.tidalTrackId) {
                streamUrl = api.getTidalStreamUrl(currentTrack.tidalTrackId);
            } else if (currentTrack.streamSource === "youtube" && currentTrack.youtubeVideoId) {
                streamUrl = api.getYtMusicStreamUrl(currentTrack.youtubeVideoId);
            } else {
                streamUrl = api.getStreamUrl(currentTrack.id);
            }
            const segmentedStartupEligible =
                resolveStreamingEngineMode() !== "howler-rollback" &&
                isListenTogetherSegmentedPlaybackAllowed() &&
                Boolean(resolveSegmentedTrackContext(currentTrack));
            // Only restore persisted position on initial player boot when not
            // using segmented startup. Segmented startup must begin at 0 unless
            // a handoff recovery path provides an explicit resume target.
            const allowPersistedResume =
                previousMediaId === null && !segmentedStartupEligible;
            if (allowPersistedResume && typeof window !== "undefined") {
                let resumeTrackId: string | null = null;
                let persistedCurrentTime = 0;
                try {
                    resumeTrackId = readMigratingStorageItem(CURRENT_TIME_TRACK_ID_KEY);
                    const persistedRaw = readMigratingStorageItem(CURRENT_TIME_KEY);
                    const parsed = Number.parseFloat(String(persistedRaw ?? "0"));
                    persistedCurrentTime = Number.isFinite(parsed)
                        ? Math.max(0, parsed)
                        : 0;
                } catch {
                    resumeTrackId = null;
                    persistedCurrentTime = 0;
                }

                if (
                    resumeTrackId === currentTrack.id &&
                    persistedCurrentTime > 0
                ) {
                    startTime = persistedCurrentTime;
                }
            }
        } else if (playbackType === "audiobook" && currentAudiobook) {
            streamUrl = api.getAudiobookStreamUrl(currentAudiobook.id);
            startTime = currentAudiobook.progress?.currentTime || 0;
        } else if (playbackType === "podcast" && currentPodcast) {
            const [podcastId, episodeId] = currentPodcast.id.split(":");
            streamUrl = api.getPodcastEpisodeStreamUrl(podcastId, episodeId);
            startTime = currentPodcast.progress?.currentTime || 0;
            podcastDebugLog("load podcast", {
                currentPodcastId: currentPodcast.id,
                podcastId,
                episodeId,
                title: currentPodcast.title,
                podcastTitle: currentPodcast.podcastTitle,
                startTime,
                loadId: thisLoadId,
            });
        }

        if (streamUrl) {
            setCurrentTime(Math.max(0, startTime));
            const wasHowlerPlayingBeforeLoad = howlerEngine.isPlaying();
            if (playbackType === "track" && currentTrack) {
                setStreamProfile({
                    mode: "direct",
                    sourceType: resolveDirectTrackSourceType(currentTrack),
                    codec: null,
                    bitrateKbps: null,
                });
            } else {
                setStreamProfile(null);
            }

            const fallbackDuration =
                currentTrack?.duration ||
                currentAudiobook?.duration ||
                currentPodcast?.duration ||
                0;
            setDuration(fallbackDuration);

            let format = "mp3";
            if (currentTrack?.streamSource === "tidal" || currentTrack?.streamSource === "youtube") {
                // TIDAL and YouTube Music streams are AAC in MP4 container
                format = "mp4";
            } else {
                const filePath = currentTrack?.filePath || "";
                if (filePath) {
                    const ext = filePath.split(".").pop()?.toLowerCase();
                    if (ext === "flac") format = "flac";
                    else if (ext === "m4a" || ext === "aac") format = "mp4";
                    else if (ext === "ogg" || ext === "opus") format = "webm";
                    else if (ext === "wav") format = "wav";
                }
            }

            let sourceForLoad: string | AudioEngineSource = streamUrl;
            let sourceRequestHeaders: Record<string, string> | undefined;
            let sourceResolved = false;
            let usingSegmentedSource = false;
            let segmentedAssetBuildInFlight = false;
            let segmentedInitSource: "prewarm" | "startup" | "on_demand" | null =
                null;

            const resolveSourceForLoad = async (): Promise<void> => {
                if (sourceResolved) {
                    return;
                }
                sourceResolved = true;

                const segmentedTrackContext =
                    playbackType === "track"
                        ? resolveSegmentedTrackContext(currentTrack)
                        : null;

                const shouldAttemptSegmentedSession =
                    playbackType === "track" &&
                    Boolean(currentTrack) &&
                    Boolean(segmentedTrackContext) &&
                    isListenTogetherSegmentedPlaybackAllowed() &&
                    resolveStreamingEngineMode() !== "howler-rollback";

                if (
                    !shouldAttemptSegmentedSession ||
                    !currentTrack ||
                    !segmentedTrackContext
                ) {
                    segmentedStartupTimelineRef.current = null;
                    activeSegmentedSessionRef.current = null;
                    segmentedHandoffAttemptRef.current = 0;
                    segmentedHandoffLastAttemptAtRef.current = 0;
                    resetSegmentedHandoffCircuit(null);
                    segmentedHandoffLastRecoveryRef.current = {
                        trackId: null,
                        resumeAtSec: 0,
                        recoveredAtMs: 0,
                    };
                    segmentedProactiveHandoffAttemptedTrackIdRef.current = null;
                    segmentedProactiveHandoffAttemptCountRef.current = 0;
                    segmentedProactiveHandoffLastAttemptAtRef.current = 0;
                    segmentedProactiveHandoffCompletedTrackIdRef.current = null;
                    segmentedProactiveHandoffLastSkipKeyRef.current = null;
                    startupSegmentedSessionRef.current = null;
                    return;
                }

                const segmentedInitStartedAtMs = Date.now();
                const startupTimeline = ensureSegmentedStartupTimeline(
                    currentTrack.id,
                    thisLoadId,
                    segmentedInitStartedAtMs,
                );
                const segmentedSessionKey = buildSegmentedSessionKey(
                    segmentedTrackContext,
                );
                const prewarmedSessionCandidate =
                    prewarmedSegmentedSessionRef.current.get(segmentedSessionKey);
                const prewarmedSession =
                    prewarmedSessionCandidate &&
                    isSegmentedSessionUsable(prewarmedSessionCandidate)
                        ? prewarmedSessionCandidate
                        : null;
                if (prewarmedSessionCandidate && !prewarmedSession) {
                    logSegmentedClientMetric("session.prewarm_discarded", {
                        trackId: currentTrack.id,
                        sourceType: segmentedTrackContext.sourceType,
                        reason: "insufficient_ttl",
                        remainingMs: getSegmentedSessionRemainingMs(
                            prewarmedSessionCandidate,
                        ),
                    });
                    prewarmedSegmentedSessionRef.current.delete(segmentedSessionKey);
                }

                const startupSessionSnapshot = startupSegmentedSessionRef.current;
                const startupSession =
                    startupSessionSnapshot &&
                    startupSessionSnapshot.trackId === currentTrack.id &&
                    startupSessionSnapshot.sourceType ===
                        segmentedTrackContext.sourceType &&
                    isSegmentedSessionUsable(startupSessionSnapshot.session)
                        ? startupSessionSnapshot.session
                        : null;
                if (
                    startupSessionSnapshot &&
                    startupSessionSnapshot.trackId === currentTrack.id &&
                    !startupSession
                ) {
                    logSegmentedClientMetric("session.startup_discarded", {
                        trackId: currentTrack.id,
                        sourceType: segmentedTrackContext.sourceType,
                        reason: "insufficient_ttl",
                        remainingMs: getSegmentedSessionRemainingMs(
                            startupSessionSnapshot.session,
                        ),
                    });
                    startupSegmentedSessionRef.current = null;
                }

                let initSource: "prewarm" | "startup" | "on_demand" = "on_demand";
                let segmentedSession: SegmentedStreamingSessionResponse | null =
                    prewarmedSession;
                if (segmentedSession) {
                    initSource = "prewarm";
                    prewarmedSegmentedSessionRef.current.delete(segmentedSessionKey);
                } else if (startupSession) {
                    segmentedSession = startupSession;
                    initSource = "startup";
                } else {
                    const startupSessionFromRequest =
                        await ensureStartupSegmentedSession(
                            currentTrack.id,
                            segmentedTrackContext,
                            "load_direct_startup",
                        );
                    if (
                        startupSessionFromRequest &&
                        isSegmentedSessionUsable(startupSessionFromRequest)
                    ) {
                        segmentedSession = startupSessionFromRequest;
                        initSource = "startup";
                    } else {
                        startupTimeline.createRequestedAtMs ??= Date.now();
                        logSegmentedClientMetric("session.create_request", {
                            trackId: currentTrack.id,
                            sourceType: segmentedTrackContext.sourceType,
                            initSource: "on_demand",
                        });

                        const createdSession =
                            await api.createSegmentedStreamingSession({
                                trackId: segmentedTrackContext.sessionTrackId,
                                sourceType: segmentedTrackContext.sourceType,
                            });
                        startupTimeline.createResolvedAtMs = Date.now();
                        if (!isSegmentedSessionUsable(createdSession)) {
                            logSegmentedClientMetric("session.create_failure", {
                                trackId: currentTrack.id,
                                sourceType: segmentedTrackContext.sourceType,
                                reason: "created_session_not_usable",
                            });
                            throw new Error(
                                "Segmented startup session is not usable for playback",
                            );
                        }
                        segmentedSession = createdSession;
                    }
                    startupSegmentedSessionRef.current = {
                        trackId: currentTrack.id,
                        sourceType: segmentedTrackContext.sourceType,
                        session: segmentedSession,
                    };
                }

                if (!segmentedSession) {
                    throw new Error("Segmented startup session unavailable");
                }

                segmentedAssetBuildInFlight =
                    segmentedSession.engineHints?.assetBuildInFlight === true;

                if (segmentedAssetBuildInFlight) {
                    logSegmentedClientMetric(
                        "session.create_asset_build_inflight_hint",
                        {
                        trackId: currentTrack.id,
                        sourceType:
                            segmentedSession.playbackProfile?.sourceType ??
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: segmentedSession.sessionId,
                        },
                    );
                }

                if (
                    isLosslessSegmentedSession(segmentedSession) &&
                    !supportsLosslessSegmentedPlayback()
                ) {
                    logSegmentedClientMetric("session.create_failure", {
                        trackId: currentTrack.id,
                        sourceType:
                            segmentedSession.playbackProfile?.sourceType ??
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        reason: "lossless_segmented_unsupported",
                    });
                    throw new Error(
                        "Segmented lossless session is unsupported for this client",
                    );
                }

                if (loadIdRef.current !== thisLoadId || !isLoadingRef.current) {
                    return;
                }

                sourceForLoad = {
                    url: segmentedSession.manifestUrl,
                    trackId: currentTrack.id,
                    sessionId: segmentedSession.sessionId,
                    sourceType:
                        segmentedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    protocol: "dash",
                    mimeType: "application/dash+xml",
                };
                usingSegmentedSource = true;
                segmentedInitSource = initSource;
                format = "mp4";
                startupTimeline.sessionId = segmentedSession.sessionId;
                startupTimeline.sourceType =
                    segmentedSession.engineHints?.sourceType ??
                    segmentedSession.playbackProfile?.sourceType ??
                    segmentedTrackContext.sourceType;
                startupTimeline.initSource = initSource;

                sourceRequestHeaders = {
                    "x-streaming-session-token": segmentedSession.sessionToken,
                };
                const authToken = api.getStreamingAuthToken();
                if (authToken) {
                    sourceRequestHeaders.Authorization = `Bearer ${authToken}`;
                }

                activeSegmentedSessionRef.current = {
                    sessionId: segmentedSession.sessionId,
                    sessionToken: segmentedSession.sessionToken,
                    trackId: currentTrack.id,
                    sourceType:
                        segmentedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    manifestUrl: segmentedSession.manifestUrl,
                    expiresAt: segmentedSession.expiresAt,
                    assetBuildInFlight:
                        segmentedSession.engineHints?.assetBuildInFlight === true,
                };
                segmentedColdStartRebufferDeferralRef.current = {
                    trackId: currentTrack.id,
                    count: 0,
                };
                startupSegmentedSessionRef.current = {
                    trackId: currentTrack.id,
                    sourceType:
                        segmentedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    session: segmentedSession,
                };
                setStreamProfile({
                    mode: "dash",
                    sourceType:
                        segmentedSession.playbackProfile?.sourceType ??
                        segmentedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    codec:
                        segmentedSession.playbackProfile?.codec?.toUpperCase() ??
                        "AAC",
                    bitrateKbps:
                        segmentedSession.playbackProfile?.bitrateKbps ?? null,
                });
                logSegmentedClientMetric("session.create_success", {
                    trackId: currentTrack.id,
                    sourceType:
                        segmentedSession.playbackProfile?.sourceType ??
                        segmentedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    sessionId: segmentedSession.sessionId,
                    initSource,
                    latencyMs: Math.max(0, Date.now() - segmentedInitStartedAtMs),
                });
                segmentedHandoffAttemptRef.current = 0;
                segmentedHandoffLastAttemptAtRef.current = 0;
                resetSegmentedHandoffCircuit(currentTrack.id);
                segmentedHandoffLastRecoveryRef.current = {
                    trackId: currentTrack.id,
                    resumeAtSec: 0,
                    recoveredAtMs: Date.now(),
                };
                segmentedProactiveHandoffAttemptCountRef.current = 0;
                segmentedProactiveHandoffCompletedTrackIdRef.current = currentTrack.id;
                segmentedProactiveHandoffLastSkipKeyRef.current = null;
            };

            const clearLoadListeners = () => {
                if (loadListenerRef.current) {
                    howlerEngine.off("load", loadListenerRef.current);
                    loadListenerRef.current = null;
                }
                if (loadErrorListenerRef.current) {
                    howlerEngine.off("loaderror", loadErrorListenerRef.current);
                    loadErrorListenerRef.current = null;
                }
            };
            const startLoadAttempt = async (
                options: {
                    retryReason?:
                        | "segmented_session_create_error"
                        | "segmented_load_error"
                        | "segmented_startup_timeout";
                } = {},
            ) => {
                clearLoadListeners();
                clearSegmentedStartupFallback();
                clearSegmentedManifestNudges();
                const startupAttemptStartedAtMs = Date.now();

                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }

                const scheduleSegmentedStartupRetry = (
                    stage: SegmentedStartupRecoveryStage,
                    reason:
                        | "segmented_session_create_error"
                        | "segmented_load_error"
                        | "segmented_startup_timeout",
                    retryDetails: {
                        isTransient: boolean;
                        errorMessage: string;
                    },
                ): boolean => {
                    if (
                        playbackType !== "track" ||
                        !currentTrack ||
                        !isListenTogetherSegmentedPlaybackAllowed()
                    ) {
                        return false;
                    }

                    if (
                        stage !== "session_create" &&
                        !usingSegmentedSource
                    ) {
                        return false;
                    }

                    if (!retryDetails.isTransient) {
                        return false;
                    }

                    const nowMs = Date.now();
                    if (segmentedStartupRecoveryWindowStartedAtMsRef.current === null) {
                        segmentedStartupRecoveryWindowStartedAtMsRef.current = nowMs;
                    }
                    const windowStartedAtMs =
                        segmentedStartupRecoveryWindowStartedAtMsRef.current;
                    const windowElapsedMs =
                        windowStartedAtMs === null
                            ? 0
                            : Math.max(0, nowMs - windowStartedAtMs);

                    const decision = resolveSegmentedStartupRecoveryDecision({
                        stage,
                        stageAttempts: segmentedStartupStageAttemptsRef.current,
                        stageLimits: SEGMENTED_STARTUP_STAGE_MAX_ATTEMPTS,
                        recoveryWindowStartedAtMs:
                            segmentedStartupRecoveryWindowStartedAtMsRef.current,
                        recoveryWindowMaxMs: SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                        sessionResetsUsed: segmentedStartupSessionResetCountRef.current,
                        maxSessionResets: SEGMENTED_STARTUP_MAX_SESSION_RESETS,
                        baseDelayMs: SEGMENTED_STARTUP_RETRY_DELAY_MS,
                        maxDelayMs: SEGMENTED_STARTUP_RETRY_BACKOFF_MAX_MS,
                        jitterRatio: SEGMENTED_STARTUP_RETRY_JITTER_RATIO,
                        nowMs,
                    });

                    segmentedStartupStageAttemptsRef.current =
                        decision.nextStageAttempts;
                    segmentedStartupSessionResetCountRef.current =
                        decision.nextSessionResetsUsed;

                    if (
                        decision.action === "exhausted_stage" ||
                        decision.action === "exhausted_window"
                    ) {
                        logSegmentedClientMetric("session.startup_retry_exhausted", {
                            trackId: currentTrack.id,
                            sourceType: resolveDirectTrackSourceType(currentTrack),
                            stage,
                            reason,
                            action: decision.action,
                            errorMessage: retryDetails.errorMessage,
                            attempts: segmentedStartupRetryCountRef.current,
                            stageAttempts:
                                segmentedStartupStageAttemptsRef.current[stage],
                            windowElapsedMs,
                            windowMaxMs: SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                            sessionResetsUsed:
                                segmentedStartupSessionResetCountRef.current,
                            maxSessionResets: SEGMENTED_STARTUP_MAX_SESSION_RESETS,
                        });
                        return false;
                    }

                    if (decision.action === "reset_session_and_retry") {
                        startupSegmentedSessionRef.current = null;
                        activeSegmentedSessionRef.current = null;
                        logSegmentedClientMetric("session.startup_stage_reset", {
                            trackId: currentTrack.id,
                            sourceType: resolveDirectTrackSourceType(currentTrack),
                            stage,
                            reason,
                            errorMessage: retryDetails.errorMessage,
                            sessionResetsUsed:
                                segmentedStartupSessionResetCountRef.current,
                        });
                    }

                    segmentedStartupRetryCountRef.current += 1;
                    const attempt = segmentedStartupRetryCountRef.current;
                    const startupTimeline = segmentedStartupTimelineRef.current;
                    if (
                        startupTimeline &&
                        startupTimeline.trackId === currentTrack.id &&
                        startupTimeline.loadId === thisLoadId
                    ) {
                        startupTimeline.startupRetryCount = attempt;
                    }

                    const retryDelayMs =
                        typeof decision.delayMs === "number"
                            ? decision.delayMs
                            : SEGMENTED_STARTUP_RETRY_DELAY_MS;
                    logSegmentedClientMetric("session.startup_retry", {
                        trackId: currentTrack.id,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            resolveDirectTrackSourceType(currentTrack),
                        reason,
                        stage,
                        action: decision.action,
                        attempt,
                        stageAttempts: segmentedStartupStageAttemptsRef.current[stage],
                        delayMs: retryDelayMs,
                        windowElapsedMs,
                        windowMaxMs: SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                        sessionResetsUsed: segmentedStartupSessionResetCountRef.current,
                        maxSessionResets: SEGMENTED_STARTUP_MAX_SESSION_RESETS,
                    });

                    clearLoadListeners();
                    clearSegmentedStartupFallback();
                    clearSegmentedManifestNudges();
                    if (loadTimeoutRef.current) {
                        clearTimeout(loadTimeoutRef.current);
                        loadTimeoutRef.current = null;
                    }

                    isLoadingRef.current = true;
                    activeEngineTrackIdRef.current = null;
                    sourceResolved = false;
                    sourceForLoad = streamUrl;
                    sourceRequestHeaders = undefined;
                    usingSegmentedSource = false;
                    segmentedAssetBuildInFlight = false;
                    segmentedInitSource = null;
                    activeSegmentedSessionRef.current = null;
                    markSegmentedStartupRampWindow(currentTrack.id, reason);
                    howlerEngine.stop();
                    playbackStateMachine.forceTransition("RECOVERING");
                    setIsBuffering(true);

                    setTimeout(() => {
                        if (
                            loadIdRef.current !== thisLoadId ||
                            !isLoadingRef.current
                        ) {
                            return;
                        }
                        playbackStateMachine.forceTransition("LOADING");
                        void startLoadAttempt({
                            retryReason: reason,
                        });
                    }, retryDelayMs);

                    return true;
                };

                try {
                    await resolveSourceForLoad();
                } catch (segmentedStartupError) {
                    const startupErrorMessage =
                        segmentedStartupError instanceof Error
                            ? segmentedStartupError.message
                            : String(segmentedStartupError ?? "unknown");
                    const isTransientCreateFailure =
                        isLikelyTransientStreamError(startupErrorMessage);
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Segmented startup session failed:",
                        segmentedStartupError
                    );
                    logSegmentedClientMetric("session.create_failure", {
                        trackId: currentTrack?.id ?? null,
                        sourceType: currentTrack
                            ? resolveDirectTrackSourceType(currentTrack)
                            : "unknown",
                        reason: startupErrorMessage,
                        stage: "session_create",
                        isTransient: isTransientCreateFailure,
                    });
                    if (
                        scheduleSegmentedStartupRetry(
                            "session_create",
                            "segmented_session_create_error",
                            {
                                isTransient: isTransientCreateFailure,
                                errorMessage: startupErrorMessage,
                            },
                        )
                    ) {
                        return;
                    }
                    emitSegmentedStartupTimeline("playback_error", {
                        error: startupErrorMessage,
                    });
                    isLoadingRef.current = false;
                    activeEngineTrackIdRef.current = null;
                    lastTrackIdRef.current = null;
                    playbackStateMachine.forceTransition("ERROR", {
                        error: startupErrorMessage || "Segmented startup failed",
                        errorCode: 500,
                    });
                    setIsPlaying(false);
                    setIsBuffering(false);
                    return;
                }

                if (loadIdRef.current !== thisLoadId || !isLoadingRef.current) {
                    return;
                }

                const shouldAutoPlayOnLoad =
                    lastPlayingStateRef.current || wasHowlerPlayingBeforeLoad;

                if (typeof sourceForLoad === "string") {
                    activeSegmentedPlaybackTrackIdRef.current = null;
                    howlerEngine.load(sourceForLoad, shouldAutoPlayOnLoad, format);
                } else {
                    activeSegmentedPlaybackTrackIdRef.current =
                        sourceForLoad.protocol === "dash"
                            ? sourceForLoad.trackId ?? null
                            : null;
                    howlerEngine.load(sourceForLoad, {
                        autoplay: shouldAutoPlayOnLoad,
                        format,
                        withCredentials: true,
                        requestHeaders: sourceRequestHeaders,
                    });
                }
                applyCurrentOutputState();
                if (
                    usingSegmentedSource &&
                    playbackType === "track" &&
                    currentTrack &&
                    isListenTogetherSegmentedPlaybackAllowed()
                ) {
                    const scheduledTrackId = currentTrack.id;
                    for (const delayMs of SEGMENTED_STARTUP_MANIFEST_NUDGE_DELAYS_MS) {
                        const nudgeTimeout = setTimeout(() => {
                            const activeEngineTrackId = activeEngineTrackIdRef.current;
                            if (
                                loadIdRef.current !== thisLoadId ||
                                currentTrackRef.current?.id !== scheduledTrackId ||
                                (!isLoadingRef.current &&
                                    activeEngineTrackId !== scheduledTrackId)
                            ) {
                                return;
                            }

                            const activeSession = activeSegmentedSessionRef.current;
                            if (!activeSession || activeSession.trackId !== scheduledTrackId) {
                                return;
                            }

                            const startupPositionSec =
                                resolveStartupSafeTrackPositionSec(scheduledTrackId);
                            if (
                                startupPositionSec >
                                SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC
                            ) {
                                return;
                            }

                            howlerEngine.refreshManifest();
                            logSegmentedClientMetric("player.startup_manifest_nudge", {
                                trackId: scheduledTrackId,
                                sourceType: activeSession.sourceType,
                                sessionId: activeSession.sessionId,
                                delayMs,
                                startupPositionSec,
                            });
                        }, delayMs);
                        segmentedManifestNudgeTimeoutsRef.current.push(nudgeTimeout);
                    }
                }
                if (options.retryReason && playbackType === "track" && currentTrack) {
                    logSegmentedClientMetric("session.startup_retry_attempt", {
                        trackId: currentTrack.id,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            resolveDirectTrackSourceType(currentTrack),
                        reason: options.retryReason,
                        attempt: segmentedStartupRetryCountRef.current,
                    });
                }

                if (playbackType === "podcast" && currentPodcast) {
                    podcastDebugLog("howlerEngine.load()", {
                        url:
                            typeof sourceForLoad === "string"
                                ? sourceForLoad
                                : sourceForLoad.url,
                        format,
                        loadId: thisLoadId,
                        attempt: loadTimeoutRetryCountRef.current + 1,
                    });
                }

                const handleLoaded = () => {
                    if (loadIdRef.current !== thisLoadId) return;

                    clearSegmentedStartupFallback();
                    clearSegmentedManifestNudges();
                    if (loadTimeoutRef.current) {
                        clearTimeout(loadTimeoutRef.current);
                        loadTimeoutRef.current = null;
                    }
                    loadTimeoutRetryCountRef.current = 0;
                    segmentedStartupRetryCountRef.current = 0;
                    segmentedStartupStageAttemptsRef.current =
                        createEmptySegmentedStartupRecoveryStageAttempts();
                    segmentedStartupRecoveryWindowStartedAtMsRef.current = null;
                    segmentedStartupSessionResetCountRef.current = 0;
                    isLoadingRef.current = false;
                    activeEngineTrackIdRef.current =
                        playbackType === "track" && currentTrack
                            ? currentTrack.id
                            : null;

                    if (startTime > 0) {
                        howlerEngine.seek(startTime);
                        setCurrentTime(startTime);
                    }

                    applyCurrentOutputState();
                    if (playbackType === "podcast" && currentPodcast) {
                        podcastDebugLog("loaded", {
                            loadId: thisLoadId,
                            durationHowler: howlerEngine.getDuration(),
                            howlerTime: howlerEngine.getCurrentTime(),
                            actualTime: howlerEngine.getActualCurrentTime(),
                            startTime,
                            canSeek,
                        });
                    }

                    const shouldAutoPlay =
                        lastPlayingStateRef.current || wasHowlerPlayingBeforeLoad;

                    if (shouldAutoPlay && !howlerEngine.isPlaying()) {
                        applyCurrentOutputState();
                        howlerEngine.play();
                        if (!lastPlayingStateRef.current) {
                            setIsPlaying(true);
                        }
                    }

                    clearLoadListeners();
                };

                const handleLoadError = (loadError?: unknown) => {
                    clearSegmentedStartupFallback();
                    clearSegmentedManifestNudges();
                    if (loadTimeoutRef.current) {
                        clearTimeout(loadTimeoutRef.current);
                        loadTimeoutRef.current = null;
                    }
                    const loadErrorMessage =
                        loadError instanceof Error
                            ? loadError.message
                            : String(loadError ?? "segmented engine load error");
                    const isTransientLoadError =
                        loadError == null ||
                        isLikelyTransientStreamError(loadErrorMessage);
                    if (
                        scheduleSegmentedStartupRetry(
                            "engine_load",
                            "segmented_load_error",
                            {
                                isTransient: isTransientLoadError,
                                errorMessage: loadErrorMessage,
                            },
                        )
                    ) {
                        return;
                    }
                    loadTimeoutRetryCountRef.current = 0;
                    isLoadingRef.current = false;
                    activeEngineTrackIdRef.current = null;
                    lastTrackIdRef.current = null;
                    playbackStateMachine.forceTransition("ERROR", {
                        error:
                            loadErrorMessage ||
                            "Segmented audio failed while loading",
                        errorCode: 502,
                    });
                    setIsPlaying(false);
                    setIsBuffering(false);

                    // Show a descriptive toast for YouTube-sourced tracks that fail to load
                    if (
                        playbackType === "track" &&
                        currentTrack?.streamSource === "youtube"
                    ) {
                        toast.error(
                            `Couldn't stream "${currentTrack.title}" from YouTube Music — it may be age-restricted or unavailable.`,
                            { duration: 5000 }
                        );
                    }

                    clearLoadListeners();
                };

                loadListenerRef.current = handleLoaded;
                loadErrorListenerRef.current = handleLoadError;

                howlerEngine.on("load", handleLoaded);
                howlerEngine.on("loaderror", handleLoadError);

                if (
                    usingSegmentedSource &&
                    playbackType === "track" &&
                    currentTrack &&
                    isListenTogetherSegmentedPlaybackAllowed()
                ) {
                    const configuredFallbackTimeoutMs =
                        resolveSegmentedStartupFallbackTimeoutMs();
                    const startupRetryTimeoutMs =
                        segmentedInitSource === "on_demand"
                            ? clampSegmentedStartupFallbackTimeoutMs(
                                  configuredFallbackTimeoutMs +
                                      SEGMENTED_STARTUP_ON_DEMAND_TIMEOUT_BONUS_MS,
                              )
                            : configuredFallbackTimeoutMs;
                    if (segmentedAssetBuildInFlight) {
                        logSegmentedClientMetric("session.startup_timeout_skip", {
                            trackId: currentTrack.id,
                            sourceType:
                                activeSegmentedSessionRef.current?.sourceType ??
                                resolveDirectTrackSourceType(currentTrack),
                            reason: "asset_build_inflight",
                            startupRetryTimeoutMs,
                        });
                    } else {
                        const retryDelayMs = resolveSegmentedStartupRetryDelayMs({
                                isLoading: isLoadingRef.current,
                                sourceKind: usingSegmentedSource
                                    ? "segmented"
                                    : "direct",
                                requestLoadId: thisLoadId,
                                activeLoadId: loadIdRef.current,
                                startupAttemptStartedAtMs,
                                retryTimeoutMs: startupRetryTimeoutMs,
                            });
                        const retrySegmentedStartup = () => {
                            if (
                                !shouldRetrySegmentedStartupTimeout({
                                    isLoading: isLoadingRef.current,
                                    sourceKind: usingSegmentedSource
                                        ? "segmented"
                                        : "direct",
                                    requestLoadId: thisLoadId,
                                    activeLoadId: loadIdRef.current,
                                })
                            ) {
                                return;
                            }

                            const didScheduleRetry = scheduleSegmentedStartupRetry(
                                "manifest_readiness",
                                "segmented_startup_timeout",
                                {
                                    isTransient: true,
                                    errorMessage:
                                        "Segmented startup readiness timeout",
                                },
                            );
                            if (!didScheduleRetry) {
                                emitSegmentedStartupTimeline("startup_timeout", {
                                    startupRetryTimeoutMs,
                                });
                                sharedFrontendLogger.warn(
                                    `[AudioPlaybackOrchestrator] Segmented startup exceeded ${startupRetryTimeoutMs}ms and retry budget is exhausted.`
                                );
                                playbackStateMachine.forceTransition("ERROR", {
                                    error:
                                        "Segmented startup timed out after retry budget",
                                    errorCode: 408,
                                });
                                setIsPlaying(false);
                                setIsBuffering(false);
                            }
                        };

                        if (typeof retryDelayMs === "number") {
                            if (retryDelayMs === 0) {
                                retrySegmentedStartup();
                                return;
                            }
                            segmentedStartupFallbackTimeoutRef.current = setTimeout(
                                retrySegmentedStartup,
                                retryDelayMs,
                            );
                        }
                    }
                }

                const loadTimeoutMs =
                    usingSegmentedSource && segmentedAssetBuildInFlight
                        ? AUDIO_LOAD_TIMEOUT_ASSET_BUILD_INFLIGHT_MS
                        : AUDIO_LOAD_TIMEOUT_MS;
                loadTimeoutRef.current = setTimeout(() => {
                    if (loadIdRef.current !== thisLoadId || !isLoadingRef.current) {
                        return;
                    }

                    const retryAttempt = loadTimeoutRetryCountRef.current + 1;
                    if (retryAttempt <= AUDIO_LOAD_TIMEOUT_RETRIES) {
                        loadTimeoutRetryCountRef.current = retryAttempt;
                        sharedFrontendLogger.warn(
                            `[AudioPlaybackOrchestrator] Audio load timed out after ${loadTimeoutMs}ms; retrying (${retryAttempt}/${AUDIO_LOAD_TIMEOUT_RETRIES})`
                        );
                        clearLoadListeners();
                        if (loadTimeoutRef.current) {
                            clearTimeout(loadTimeoutRef.current);
                            loadTimeoutRef.current = null;
                        }
                        howlerEngine.stop();
                        playbackStateMachine.forceTransition("LOADING");
                        setTimeout(() => {
                            if (
                                loadIdRef.current !== thisLoadId ||
                                !isLoadingRef.current
                            ) {
                                return;
                            }
                            void startLoadAttempt();
                        }, AUDIO_LOAD_RETRY_DELAY_MS);
                        return;
                    }

                    sharedFrontendLogger.error(
                        `[AudioPlaybackOrchestrator] Audio load timed out after ${AUDIO_LOAD_TIMEOUT_MS}ms`
                    );
                    emitSegmentedStartupTimeline("startup_timeout", {
                        loadTimeoutMs,
                        reason: "audio_load_timeout",
                    });
                    loadTimeoutRetryCountRef.current = 0;
                    isLoadingRef.current = false;
                    activeEngineTrackIdRef.current = null;
                    lastTrackIdRef.current = null;
                    playbackStateMachine.forceTransition("ERROR", {
                        error: "Audio stream timed out while loading",
                        errorCode: 408,
                    });
                    setIsPlaying(false);
                    setIsBuffering(false);
                    clearLoadListeners();
                    loadTimeoutRef.current = null;
                }, loadTimeoutMs);
            };

            void startLoadAttempt();
        } else {
            markSegmentedStartupRampWindow(null, "no_stream_url");
            clearSegmentedStartupFallback();
            clearSegmentedManifestNudges();
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            loadTimeoutRetryCountRef.current = 0;
            segmentedStartupRetryCountRef.current = 0;
            segmentedStartupStageAttemptsRef.current =
                createEmptySegmentedStartupRecoveryStageAttempts();
            segmentedStartupRecoveryWindowStartedAtMsRef.current = null;
            segmentedStartupSessionResetCountRef.current = 0;
            segmentedStartupTimelineRef.current = null;
            isLoadingRef.current = false;
            activeEngineTrackIdRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canSeek/isPlaying/setIsPlaying intentionally excluded: adding them would re-trigger audio loading on play/pause or seek state changes, breaking playback
    }, [
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        setDuration,
        setStreamProfile,
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearSegmentedStartupFallback,
        clearSegmentedManifestNudges,
        clearTransientTrackRecovery,
        prewarmSegmentedSession,
        ensureStartupSegmentedSession,
        ensureSegmentedStartupTimeline,
        emitSegmentedStartupTimeline,
        markSegmentedStartupRampWindow,
        isListenTogetherSegmentedPlaybackAllowed,
        resetSegmentedHandoffCircuit,
    ]);

    // Preload next track for gapless playback (music only)
    useEffect(() => {
        // Only preload for music tracks, not podcasts/audiobooks
        if (playbackType !== "track" || !currentTrack || !isPlaying) {
            return;
        }

        for (const [sessionKey, session] of prewarmedSegmentedSessionRef.current) {
            if (!isSegmentedSessionUsable(session)) {
                prewarmedSegmentedSessionRef.current.delete(sessionKey);
            }
        }

        const nextTrack = getNextTrackInfo(
            queue,
            currentIndex,
            isShuffle,
            shuffleIndices,
            repeatMode
        );

        // Don't preload if no next track or already preloaded this one
        if (!nextTrack || nextTrack.id === lastPreloadedTrackIdRef.current) {
            return;
        }

        let streamUrl: string;
        let format = "mp3";

        if (nextTrack.streamSource === "tidal" && nextTrack.tidalTrackId) {
            streamUrl = api.getTidalStreamUrl(nextTrack.tidalTrackId);
            format = "mp4";
        } else if (
            nextTrack.streamSource === "youtube" &&
            nextTrack.youtubeVideoId
        ) {
            streamUrl = api.getYtMusicStreamUrl(nextTrack.youtubeVideoId);
            format = "mp4";
        } else {
            streamUrl = api.getStreamUrl(nextTrack.id);
            // Determine format from file path
            const filePath = nextTrack.filePath || "";
            if (filePath) {
                const ext = filePath.split(".").pop()?.toLowerCase();
                if (ext === "flac") format = "flac";
                else if (ext === "m4a" || ext === "aac") format = "mp4";
                else if (ext === "ogg" || ext === "opus") format = "webm";
                else if (ext === "wav") format = "wav";
            }
        }

        howlerEngine.preload(streamUrl, format);
        lastPreloadedTrackIdRef.current = nextTrack.id;

        const nextSegmentedTrackContext = resolveSegmentedTrackContext(nextTrack);
        const shouldPrewarmSegmentedSession =
            SEGMENTED_SESSION_PREWARM_ENABLED &&
            Boolean(nextSegmentedTrackContext) &&
            isListenTogetherSegmentedPlaybackAllowed() &&
            resolveStreamingEngineMode() !== "howler-rollback";

        if (!shouldPrewarmSegmentedSession || !nextSegmentedTrackContext) {
            return;
        }

        const nextSessionKey = buildSegmentedSessionKey(nextSegmentedTrackContext);
        const existingPrewarmedSession =
            prewarmedSegmentedSessionRef.current.get(nextSessionKey);
        if (
            existingPrewarmedSession &&
            isSegmentedSessionUsable(existingPrewarmedSession)
        ) {
            return;
        }
        prewarmSegmentedSession({
            sessionKey: nextSessionKey,
            context: nextSegmentedTrackContext,
            trackId: nextTrack.id,
            reason: "next_track",
        });
    }, [
        playbackType,
        currentTrack,
        isPlaying,
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
        repeatMode,
        prewarmSegmentedSession,
        isListenTogetherSegmentedPlaybackAllowed,
    ]);

    // Check podcast cache status and control canSeek
    useEffect(() => {
        if (playbackType !== "podcast") {
            setCanSeek(true);
            setDownloadProgress(null);
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
            return;
        }

        if (!currentPodcast) {
            setCanSeek(true);
            return;
        }

        const [podcastId, episodeId] = currentPodcast.id.split(":");

        const checkCacheStatus = async () => {
            try {
                const status = await api.getPodcastEpisodeCacheStatus(
                    podcastId,
                    episodeId
                );

                if (status.cached) {
                    setCanSeek(true);
                    setDownloadProgress(null);
                    if (cacheStatusPollingRef.current) {
                        clearInterval(cacheStatusPollingRef.current);
                        cacheStatusPollingRef.current = null;
                    }
                } else {
                    setCanSeek(false);
                    setDownloadProgress(
                        status.downloadProgress ??
                            (status.downloading ? 0 : null)
                    );
                }

                return status.cached;
            } catch (err) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Failed to check cache status:",
                    err
                );
                setCanSeek(true);
                return true;
            }
        };

        checkCacheStatus();

        cacheStatusPollingRef.current = setInterval(async () => {
            const isCached = await checkCacheStatus();
            if (isCached && cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        }, 5000);

        return () => {
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        };
    }, [currentPodcast, playbackType, setCanSeek, setDownloadProgress]);

    // Keep lastPlayingStateRef always in sync
    useLayoutEffect(() => {
        lastPlayingStateRef.current = isPlaying;
    }, [isPlaying]);

    // Handle play/pause changes from UI
    // Skip if a track change is in progress -- the track-change effect handles playback.
    // This prevents doubled audio when next() sets both currentTrack and isPlaying simultaneously.
    useEffect(() => {
        if (isLoadingRef.current) return;

        isUserInitiatedRef.current = true;

        if (isPlaying) {
            applyCurrentOutputState();
            howlerEngine.play();
            if (playbackType === "track" && currentTrack?.id) {
                scheduleStartupPlaybackRecovery(currentTrack.id);
            }
        } else {
            clearStartupPlaybackRecovery();
            howlerEngine.pause();
        }
    }, [
        isPlaying,
        playbackType,
        currentTrack?.id,
        applyCurrentOutputState,
        scheduleStartupPlaybackRecovery,
        clearStartupPlaybackRecovery,
    ]);

    // Keep audio engine output state aligned with UI controls.
    useEffect(() => {
        outputStateRef.current = { volume, isMuted };
        applyCurrentOutputState();
    }, [volume, isMuted, applyCurrentOutputState]);

    // Poll for podcast cache and reload when ready
    const startCachePolling = useCallback(
        (podcastId: string, episodeId: string, targetTime: number) => {
            // Capture the current seek operation ID
            const pollingSeekId = seekOperationIdRef.current;

            if (cachePollingRef.current) {
                clearInterval(cachePollingRef.current);
            }

            let pollCount = 0;
            const maxPolls = 60;

            cachePollingRef.current = setInterval(async () => {
                // Check if a newer seek operation has started
                if (seekOperationIdRef.current !== pollingSeekId) {
                    if (cachePollingRef.current) {
                        clearInterval(cachePollingRef.current);
                        cachePollingRef.current = null;
                    }
                    podcastDebugLog("cache polling aborted (stale)", {
                        pollingSeekId,
                        currentId: seekOperationIdRef.current,
                    });
                    return;
                }

                pollCount++;

                try {
                    const status = await api.getPodcastEpisodeCacheStatus(
                        podcastId,
                        episodeId
                    );

                    // Re-check after async operation
                    if (seekOperationIdRef.current !== pollingSeekId) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }
                        return;
                    }

                    podcastDebugLog("cache poll", {
                        podcastId,
                        episodeId,
                        pollCount,
                        cached: status.cached,
                        downloading: status.downloading,
                        downloadProgress: status.downloadProgress,
                        targetTime,
                    });

                    if (status.cached) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }

                        podcastDebugLog(
                            "cache ready -> howlerEngine.reload()",
                            {
                                podcastId,
                                episodeId,
                                targetTime,
                            }
                        );
                        // Clean up any previous cache polling load listener
                        if (cachePollingLoadListenerRef.current) {
                            howlerEngine.off(
                                "load",
                                cachePollingLoadListenerRef.current
                            );
                            cachePollingLoadListenerRef.current = null;
                        }

                        howlerEngine.reload();

                        const onLoad = () => {
                            howlerEngine.off("load", onLoad);
                            cachePollingLoadListenerRef.current = null;

                            // Check if still current before acting
                            if (seekOperationIdRef.current !== pollingSeekId) {
                                podcastDebugLog(
                                    "cache polling load callback aborted (stale)",
                                    { pollingSeekId }
                                );
                                return;
                            }

                            howlerEngine.seek(targetTime);
                            setCurrentTime(targetTime);
                            howlerEngine.play();
                            podcastDebugLog("post-reload seek+play", {
                                podcastId,
                                episodeId,
                                targetTime,
                                howlerTime: howlerEngine.getCurrentTime(),
                                actualTime: howlerEngine.getActualCurrentTime(),
                            });

                            setIsBuffering(false);
                            setTargetSeekPosition(null);
                            setIsPlaying(true);
                        };

                        cachePollingLoadListenerRef.current = onLoad;
                        howlerEngine.on("load", onLoad);
                    } else if (pollCount >= maxPolls) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }

                        sharedFrontendLogger.warn(
                            "[AudioPlaybackOrchestrator] Cache polling timeout"
                        );
                        setIsBuffering(false);
                        setTargetSeekPosition(null);
                    }
                } catch (error) {
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Cache polling error:",
                        error
                    );
                }
            }, 2000);
        },
        [setCurrentTime, setIsBuffering, setTargetSeekPosition, setIsPlaying]
    );

    // Handle seeking via event emitter
    useEffect(() => {
        // Store previous time to detect large skips vs fine scrubbing
        let previousTime = howlerEngine.getCurrentTime();

        const handleSeek = async (time: number) => {
            // Increment seek operation ID to track this specific seek
            seekOperationIdRef.current += 1;
            const thisSeekId = seekOperationIdRef.current;

            const wasPlayingAtSeekStart = howlerEngine.isPlaying();

            // Detect if this is a large skip (like 30s buttons) vs fine scrubbing
            const timeDelta = Math.abs(time - previousTime);
            const isLargeSkip = timeDelta >= 10; // 10+ seconds = large skip (30s, 15s buttons)
            previousTime = time;

            // DON'T set currentTime here for podcasts - the seek() in audio-controls-context
            // already did it optimistically. Setting it again causes a race condition.
            // We only update it after the seek actually completes.

            if (playbackType === "podcast" && currentPodcast) {
                // Cancel any previous seek-related operations
                if (seekCheckTimeoutRef.current) {
                    clearTimeout(seekCheckTimeoutRef.current);
                    seekCheckTimeoutRef.current = null;
                }

                // Cancel any pending cache polling from previous seek
                if (cachePollingRef.current) {
                    clearInterval(cachePollingRef.current);
                    cachePollingRef.current = null;
                }

                // Cancel previous reload listener
                if (seekReloadListenerRef.current) {
                    howlerEngine.off("load", seekReloadListenerRef.current);
                    seekReloadListenerRef.current = null;
                }

                // Cancel previous cache polling load listener
                if (cachePollingLoadListenerRef.current) {
                    howlerEngine.off(
                        "load",
                        cachePollingLoadListenerRef.current
                    );
                    cachePollingLoadListenerRef.current = null;
                }

                // Cancel any pending debounced seek
                if (seekDebounceRef.current) {
                    clearTimeout(seekDebounceRef.current);
                    seekDebounceRef.current = null;
                }

                // Store the pending seek time - debounce will use the latest value
                pendingSeekTimeRef.current = time;

                const [podcastId, episodeId] = currentPodcast.id.split(":");

                // Execute the seek logic - immediately for large skips, debounced for fine scrubbing
                const executeSeek = async () => {
                    const seekTime = pendingSeekTimeRef.current ?? time;
                    pendingSeekTimeRef.current = null;

                    // Check if this seek is still current
                    if (seekOperationIdRef.current !== thisSeekId) {
                        return;
                    }

                    try {
                        const status = await api.getPodcastEpisodeCacheStatus(
                            podcastId,
                            episodeId
                        );

                        // Check if this seek operation is still current
                        if (seekOperationIdRef.current !== thisSeekId) {
                            podcastDebugLog("seek: aborted (stale operation)", {
                                thisSeekId,
                                currentId: seekOperationIdRef.current,
                            });
                            return;
                        }

                        if (status.cached) {
                            // For cached podcasts, try direct seek first (faster than reload)
                            podcastDebugLog(
                                "seek: cached=true, trying direct seek first",
                                {
                                    time: seekTime,
                                    podcastId,
                                    episodeId,
                                }
                            );

                            // Direct seek - howlerEngine now handles seek locking internally
                            howlerEngine.seek(seekTime);

                            // Verify seek succeeded after a short delay
                            setTimeout(() => {
                                if (seekOperationIdRef.current !== thisSeekId) {
                                    return;
                                }

                                const actualPos =
                                    howlerEngine.getActualCurrentTime();
                                const seekSucceeded = isSeekWithinTolerance(
                                    actualPos,
                                    seekTime
                                );

                                podcastDebugLog("seek: direct seek result", {
                                    seekTime,
                                    actualPos,
                                    seekSucceeded,
                                });

                                if (!seekSucceeded) {
                                    // Direct seek failed, fall back to reload pattern
                                    podcastDebugLog(
                                        "seek: direct seek failed, falling back to reload"
                                    );
                                    seekReloadInProgressRef.current = true;

                                    howlerEngine.reload();

                                    const onLoad = () => {
                                        howlerEngine.off("load", onLoad);
                                        seekReloadListenerRef.current = null;
                                        seekReloadInProgressRef.current = false;

                                        if (
                                            seekOperationIdRef.current !==
                                            thisSeekId
                                        ) {
                                            return;
                                        }

                                        howlerEngine.seek(seekTime);

                                        if (wasPlayingAtSeekStart) {
                                            howlerEngine.play();
                                            setIsPlaying(true);
                                        }
                                    };

                                    seekReloadListenerRef.current = onLoad;
                                    howlerEngine.on("load", onLoad);
                                } else {
                                    // Seek succeeded - resume playback if needed
                                    if (
                                        wasPlayingAtSeekStart &&
                                        !howlerEngine.isPlaying()
                                    ) {
                                        howlerEngine.play();
                                    }
                                }
                            }, 150);

                            return;
                        }
                    } catch (e) {
                        sharedFrontendLogger.warn(
                            "[AudioPlaybackOrchestrator] Could not check cache status:",
                            e
                        );
                    }

                    // Check if still current after async operation
                    if (seekOperationIdRef.current !== thisSeekId) {
                        return;
                    }

                    // Not cached - try direct seek
                    howlerEngine.seek(seekTime);

                    // For non-cached streams, we rely on the browser's ability to seek via Range requests.
                    // If that fails, we shouldn't stop playback. We'll just let it try to buffer.
                    // We only check for success to log debug info, but we won't force a pause/poll loop
                    // which caused playback to stop completely in some cases.

                    seekCheckTimeoutRef.current = setTimeout(() => {
                        // Check if this seek is still current
                        if (seekOperationIdRef.current !== thisSeekId) {
                            return;
                        }

                        try {
                            const actualPos =
                                howlerEngine.getActualCurrentTime();
                            const seekFailed = !isSeekWithinTolerance(
                                actualPos,
                                seekTime
                            );

                            podcastDebugLog("seek check (streaming)", {
                                time: seekTime,
                                actualPos,
                                seekFailed,
                                podcastId,
                                episodeId,
                            });

                            // If seek failed during streaming, we don't pause.
                            // We assume the browser is buffering or the stream doesn't support seeking.
                            // Pausing here would break playback if the seek just takes a while.
                        } catch (e) {
                            sharedFrontendLogger.error(
                                "[AudioPlaybackOrchestrator] Seek check error:",
                                e
                            );
                        }
                    }, 2000);
                };

                // For large skips (30s buttons), execute immediately for responsive feel
                // For fine scrubbing (progress bar), debounce to prevent spamming
                if (isLargeSkip) {
                    podcastDebugLog("seek: large skip, executing immediately", {
                        timeDelta,
                        time,
                    });
                    executeSeek();
                } else {
                    podcastDebugLog("seek: fine scrub, debouncing", {
                        timeDelta,
                        time,
                    });
                    seekDebounceRef.current = setTimeout(executeSeek, 150);
                }

                return;
            }

            // For audiobooks and tracks, set seeking flag to prevent load effect interference
            isSeekingRef.current = true;
            howlerEngine.seek(time);

            // Reset seeking flag after a short delay to allow seek to complete
            setTimeout(() => {
                isSeekingRef.current = false;
            }, 100);
        };

        const unsubscribe = audioSeekEmitter.subscribe(handleSeek);
        return unsubscribe;
    }, [playbackType, currentPodcast, setIsBuffering, setTargetSeekPosition, setIsPlaying, startCachePolling]);

    // Cleanup cache polling, seek timeout, and seek-reload listener on unmount
    useEffect(() => {
        return () => {
            if (cachePollingRef.current) {
                clearInterval(cachePollingRef.current);
            }
            if (seekCheckTimeoutRef.current) {
                clearTimeout(seekCheckTimeoutRef.current);
            }
            clearSegmentedStartupFallback();
            clearSegmentedManifestNudges();
            if (seekReloadListenerRef.current) {
                howlerEngine.off("load", seekReloadListenerRef.current);
                seekReloadListenerRef.current = null;
            }
            if (seekDebounceRef.current) {
                clearTimeout(seekDebounceRef.current);
                seekDebounceRef.current = null;
            }
        };
    }, [clearSegmentedStartupFallback, clearSegmentedManifestNudges]);

    // Periodic progress saving for audiobooks and podcasts
    useEffect(() => {
        if (playbackType !== "audiobook" && playbackType !== "podcast") {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
            return;
        }

        if (!isPlaying) {
            if (playbackType === "audiobook") {
                saveAudiobookProgress();
            } else if (playbackType === "podcast") {
                savePodcastProgress();
            }
        }

        if (isPlaying) {
            // Clear any existing interval before creating a new one
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
            }
            progressSaveIntervalRef.current = setInterval(() => {
                if (playbackType === "audiobook") {
                    saveAudiobookProgress();
                } else if (playbackType === "podcast") {
                    savePodcastProgress();
                }
            }, 30000);
        }

        return () => {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
        };
    }, [playbackType, isPlaying, saveAudiobookProgress, savePodcastProgress]);

    // Cleanup on unmount
    useEffect(() => {
        const prewarmedSegmentedSessions = prewarmedSegmentedSessionRef.current;
        const segmentedPrewarmInFlight = segmentedPrewarmInFlightRef.current;
        const startupSegmentedSessionInFlight =
            startupSegmentedSessionInFlightRef.current;
        const startupSegmentedSessionPromises =
            startupSegmentedSessionPromisesRef.current;
        const segmentedPrewarmRetryTimeouts =
            segmentedPrewarmRetryTimeoutsRef.current;
        return () => {
            howlerEngine.stop();

            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
            }
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            clearSegmentedStartupFallback();
            clearSegmentedManifestNudges();
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            // Clean up all listener refs to prevent memory leaks
            if (loadListenerRef.current) {
                howlerEngine.off("load", loadListenerRef.current);
                loadListenerRef.current = null;
            }
            if (loadErrorListenerRef.current) {
                howlerEngine.off("loaderror", loadErrorListenerRef.current);
                loadErrorListenerRef.current = null;
            }
            if (cachePollingLoadListenerRef.current) {
                howlerEngine.off("load", cachePollingLoadListenerRef.current);
                cachePollingLoadListenerRef.current = null;
            }
            // Clean up preload refs
            lastPreloadedTrackIdRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
            prewarmedSegmentedSessions.clear();
            segmentedPrewarmInFlight.clear();
            startupSegmentedSessionRef.current = null;
            segmentedStartupTimelineRef.current = null;
            startupSegmentedSessionInFlight.clear();
            startupSegmentedSessionPromises.clear();
            for (const timeout of segmentedPrewarmRetryTimeouts.values()) {
                clearTimeout(timeout);
            }
            segmentedPrewarmRetryTimeouts.clear();
        };
    }, [
        clearSegmentedStartupFallback,
        clearSegmentedManifestNudges,
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
    ]);

    // This component doesn't render anything visible
    return null;
});
