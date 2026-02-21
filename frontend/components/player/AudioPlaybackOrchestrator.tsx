"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api, type SegmentedStreamingSessionResponse } from "@/lib/api";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";
import { resolveStreamingEngineMode } from "@/lib/audio-engine/howlerEngineAdapter";
import type { AudioEngineSource } from "@/lib/audio-engine/types";
import { resolveLocalAuthoritativeRecovery } from "@/lib/audio-engine/recoveryPolicy";
import { audioSeekEmitter } from "@/lib/audio-seek-emitter";
import { dispatchQueryEvent } from "@/lib/query-events";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import { shouldAutoMatchVibeAtQueueEnd } from "./autoMatchVibePlayback";
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

function getNextTrackInfo(
    queue: { id: string; filePath?: string; streamSource?: "local" | "tidal" | "youtube"; tidalTrackId?: number; youtubeVideoId?: string }[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: number[],
    repeatMode: "off" | "one" | "all"
): { id: string; filePath?: string; streamSource?: "local" | "tidal" | "youtube"; tidalTrackId?: number; youtubeVideoId?: string } | null {
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
    sourceType: "local" | "tidal" | "ytmusic";
    sessionTrackId: string;
}

function resolveSegmentedTrackContext(
    track:
        | {
            id: string;
            streamSource?: "local" | "tidal" | "youtube";
            tidalTrackId?: number;
            youtubeVideoId?: string;
        }
        | null
        | undefined,
): SegmentedTrackContext | null {
    if (!track) return null;

    if (track.streamSource === "youtube") {
        if (!track.youtubeVideoId?.trim()) {
            return null;
        }

        return {
            sourceType: "ytmusic",
            sessionTrackId: track.youtubeVideoId.trim(),
        };
    }

    if (track.streamSource === "tidal") {
        if (!Number.isInteger(track.tidalTrackId) || (track.tidalTrackId ?? 0) <= 0) {
            return null;
        }

        return {
            sourceType: "tidal",
            sessionTrackId: String(track.tidalTrackId),
        };
    }

    return {
        sourceType: "local",
        sessionTrackId: track.id,
    };
}

function resolveDirectTrackSourceType(track: {
    streamSource?: "local" | "tidal" | "youtube";
}): "local" | "tidal" | "ytmusic" {
    if (track.streamSource === "tidal") {
        return "tidal";
    }

    if (track.streamSource === "youtube") {
        return "ytmusic";
    }

    return "local";
}

function logSegmentedClientMetric(
    event: string,
    fields: Record<string, unknown>,
): void {
    if (typeof window === "undefined") {
        return;
    }

    console.info("[SegmentedStreaming][ClientMetric]", {
        event,
        timestamp: new Date().toISOString(),
        ...fields,
    });
}

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
    console.log(`[PodcastDebug] ${message}`, data || {});
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

const CURRENT_TIME_TRACK_ID_KEY = createMigratingStorageKey("current_time_track_id");
const AUDIO_LOAD_TIMEOUT_MS = 20_000;
const AUDIO_LOAD_TIMEOUT_RETRIES = 1;
const AUDIO_LOAD_RETRY_DELAY_MS = 350;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_DEFAULT_MS = 2_500;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS = 1_500;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS = 15_000;
const SOUNDSPAN_RUNTIME_CONFIG_KEY = "__SOUNDSPAN_RUNTIME_CONFIG__";
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_KEY =
    "SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS";
const TRACK_ERROR_SKIP_DELAY_MS = 1200;
const TRANSIENT_TRACK_ERROR_RECOVERY_DELAY_MS = 450;
const TRANSIENT_TRACK_ERROR_RECOVERY_WINDOW_MS = 15_000;
const TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS = 2;
const STARTUP_PLAYBACK_RECOVERY_DELAY_MS = 1400;
const STARTUP_PLAYBACK_RECOVERY_RECHECK_DELAY_MS = 900;
const STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS = 2;
const AUTO_MATCH_VIBE_RETRY_COOLDOWN_MS = 8000;
const SEGMENTED_HEARTBEAT_INTERVAL_MS = 15_000;
const SEGMENTED_HANDOFF_MAX_ATTEMPTS = 2;
const SEGMENTED_HANDOFF_COOLDOWN_MS = 45_000;
const SEGMENTED_PREWARM_EXPIRY_GUARD_MS = 8_000;
const howlerEngine = createRuntimeAudioEngine();

interface ActiveSegmentedSessionSnapshot {
    sessionId: string;
    sessionToken: string;
    trackId: string;
    sourceType: "local" | "tidal" | "ytmusic";
    manifestUrl: string;
    expiresAt: string;
}

interface SegmentedSessionPrewarmOptions {
    sessionKey: string;
    context: SegmentedTrackContext;
    trackId: string;
    reason: "startup_background" | "next_track";
}

const buildSegmentedSessionKey = (context: SegmentedTrackContext): string =>
    `${context.sourceType}:${context.sessionTrackId}`;

const isSegmentedSessionUsable = (
    session: Pick<SegmentedStreamingSessionResponse, "expiresAt">,
): boolean => {
    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
        return false;
    }

    return expiresAtMs - Date.now() > SEGMENTED_PREWARM_EXPIRY_GUARD_MS;
};

const clampSegmentedStartupFallbackTimeoutMs = (value: number): number =>
    Math.min(
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS,
        Math.max(SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS, value),
    );

const resolveSegmentedStartupFallbackTimeoutMs = (): number => {
    if (typeof window === "undefined") {
        return SEGMENTED_STARTUP_FALLBACK_TIMEOUT_DEFAULT_MS;
    }

    const runtimeConfig = (
        window as Window & {
            [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
        }
    )[SOUNDSPAN_RUNTIME_CONFIG_KEY];
    const runtimeValue = runtimeConfig?.[SEGMENTED_STARTUP_FALLBACK_TIMEOUT_KEY];
    const parsedRuntimeValue =
        typeof runtimeValue === "number"
            ? runtimeValue
            : Number.parseInt(String(runtimeValue ?? ""), 10);

    if (!Number.isFinite(parsedRuntimeValue)) {
        return SEGMENTED_STARTUP_FALLBACK_TIMEOUT_DEFAULT_MS;
    }

    return clampSegmentedStartupFallbackTimeoutMs(parsedRuntimeValue);
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
    const pendingTrackErrorSkipRef = useRef<NodeJS.Timeout | null>(null);
    const pendingTrackErrorTrackIdRef = useRef<string | null>(null);
    const currentTrackRef = useRef(currentTrack);
    const queueLengthRef = useRef(queue.length);
    const playbackTypeRef = useRef(playbackType);
    const startupRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const startupRecoveryLoadListenerRef = useRef<(() => void) | null>(null);
    const startupRecoveryAttemptedTrackIdRef = useRef<string | null>(null);
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
    const segmentedHandoffInProgressRef = useRef<boolean>(false);
    const segmentedHandoffAttemptRef = useRef<number>(0);
    const segmentedHandoffLastAttemptAtRef = useRef<number>(0);

    // Heartbeat monitor for detecting stalled playback
    const heartbeatRef = useRef<HeartbeatMonitor | null>(null);

    const clearSegmentedStartupFallback = useCallback(() => {
        if (segmentedStartupFallbackTimeoutRef.current) {
            clearTimeout(segmentedStartupFallbackTimeoutRef.current);
            segmentedStartupFallbackTimeoutRef.current = null;
        }
    }, []);

    const clearPendingTrackErrorSkip = useCallback(() => {
        if (pendingTrackErrorSkipRef.current) {
            clearTimeout(pendingTrackErrorSkipRef.current);
            pendingTrackErrorSkipRef.current = null;
        }
        pendingTrackErrorTrackIdRef.current = null;
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

    const prewarmSegmentedSession = useCallback(
        ({
            sessionKey,
            context,
            trackId,
            reason,
        }: SegmentedSessionPrewarmOptions): void => {
            const existingPrewarmedSession =
                prewarmedSegmentedSessionRef.current.get(sessionKey);
            if (
                existingPrewarmedSession &&
                isSegmentedSessionUsable(existingPrewarmedSession)
            ) {
                return;
            }

            if (segmentedPrewarmInFlightRef.current.has(sessionKey)) {
                return;
            }

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
                    if (session.engineHints?.preferDirectStartup === true) {
                        logSegmentedClientMetric("session.prewarm_skip", {
                            trackId,
                            sourceType:
                                session.playbackProfile?.sourceType ??
                                session.engineHints?.sourceType ??
                                context.sourceType,
                            reason: "backend_prefer_direct_startup",
                            trigger: reason,
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
                    logSegmentedClientMetric("session.prewarm_success", {
                        trackId,
                        sourceType:
                            session.playbackProfile?.sourceType ??
                            session.engineHints?.sourceType ??
                            context.sourceType,
                        sessionId: session.sessionId,
                        trigger: reason,
                    });
                })
                .catch((error) => {
                    console.warn(
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
        [],
    );

    const scheduleStartupPlaybackRecovery = useCallback(
        (trackId: string | null, recheckCount: number = 0) => {
            if (!trackId) return;
            if (getListenTogetherSessionSnapshot()?.groupId) return;
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
                if (howlerEngine.isPlaying()) return;

                if (isLoadingRef.current) {
                    if (recheckCount < STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS) {
                        scheduleStartupPlaybackRecovery(trackId, recheckCount + 1);
                    }
                    return;
                }

                if (startupRecoveryAttemptedTrackIdRef.current === trackId) return;
                startupRecoveryAttemptedTrackIdRef.current = trackId;

                console.warn(
                    "[AudioPlaybackOrchestrator] Startup playback watchdog triggered reload+retry"
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
        [clearStartupPlaybackRecovery]
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
            if (getListenTogetherSessionSnapshot()?.groupId) return false;
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

            const onRecoveredLoad = () => {
                clearTransientTrackRecovery(false);
                if (playbackTypeRef.current !== "track") return;
                if (currentTrackRef.current?.id !== failedTrackId) return;
                if (!lastPlayingStateRef.current) return;
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

                console.warn(
                    `[AudioPlaybackOrchestrator] Transient stream error recovery ${attemptNumber}/${TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS}: reload and retry current track`
                );
                howlerEngine.reload();
            }, TRANSIENT_TRACK_ERROR_RECOVERY_DELAY_MS);

            return true;
        },
        [clearPendingTrackErrorSkip, clearTransientTrackRecovery]
    );

    const attemptSegmentedHandoffRecovery = useCallback(
        async (error: unknown): Promise<boolean> => {
            if (playbackTypeRef.current !== "track") return false;
            if (getListenTogetherSessionSnapshot()?.groupId) return false;

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

            segmentedHandoffInProgressRef.current = true;
            segmentedHandoffAttemptRef.current += 1;
            segmentedHandoffLastAttemptAtRef.current = now;
            const handoffStartedAtMs = Date.now();

            const currentPositionSec = Math.max(
                0,
                typeof howlerEngine.getActualCurrentTime === "function"
                    ? howlerEngine.getActualCurrentTime()
                    : howlerEngine.getCurrentTime()
            );
            const shouldPlay =
                lastPlayingStateRef.current || howlerEngine.isPlaying() || isPlaying;

            setIsBuffering(true);
            playbackStateMachine.forceTransition("LOADING");
            logSegmentedClientMetric("session.handoff_attempt", {
                trackId: currentTrackSnapshot.id,
                sourceType: segmentedTrackContext.sourceType,
                sessionId: activeSession.sessionId,
                attempt: segmentedHandoffAttemptRef.current,
                reason: error instanceof Error ? error.message : String(error ?? "unknown"),
            });

            try {
                const handoff = await api.handoffSegmentedStreamingSession(
                    activeSession.sessionId,
                    activeSession.sessionToken,
                    {
                        positionSec: currentPositionSec,
                        isPlaying: shouldPlay,
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

                    const recoveryDecision = resolveLocalAuthoritativeRecovery(
                        {
                            positionSec: currentPositionSec,
                            shouldPlay: lastPlayingStateRef.current,
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
                        void howlerEngine.play();
                        setIsPlaying(true);
                    } else {
                        setIsPlaying(false);
                    }

                    setIsBuffering(false);
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
                        withCredentials: true,
                        requestHeaders,
                    }
                );

                console.warn(
                    "[AudioPlaybackOrchestrator] Segmented handoff recovery succeeded after playback error:",
                    error
                );
                return true;
            } catch (handoffError) {
                console.error(
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
        [isPlaying, setCurrentTime, setIsBuffering, setIsPlaying, setStreamProfile]
    );

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
                    console.error(
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
        if (currentTrack?.id !== startupRecoveryAttemptedTrackIdRef.current) {
            startupRecoveryAttemptedTrackIdRef.current = null;
        }
        if (currentTrack?.id !== transientTrackRecoveryTrackIdRef.current) {
            clearTransientTrackRecovery(true);
        }
        if (!resolveSegmentedTrackContext(currentTrack)) {
            activeSegmentedSessionRef.current = null;
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            segmentedHandoffInProgressRef.current = false;
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
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            segmentedHandoffInProgressRef.current = false;
        }
    }, [currentTrack, clearTransientTrackRecovery, setStreamProfile]);

    useEffect(() => {
        queueLengthRef.current = queue.length;
    }, [queue.length]);

    useEffect(() => {
        playbackTypeRef.current = playbackType;
        if (playbackType !== "track") {
            activeSegmentedSessionRef.current = null;
            segmentedHandoffAttemptRef.current = 0;
            segmentedHandoffLastAttemptAtRef.current = 0;
            segmentedHandoffInProgressRef.current = false;
            setStreamProfile(null);
        }
    }, [playbackType, setStreamProfile]);

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
                    console.warn(
                        "[AudioPlaybackOrchestrator] Segmented heartbeat failed:",
                        error
                    );
                });
        }, SEGMENTED_HEARTBEAT_INTERVAL_MS);

        return () => {
            clearInterval(heartbeatInterval);
        };
    }, [playbackType, currentTrack?.id]);

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
                console.warn("[AudioPlaybackOrchestrator] Heartbeat detected stall");
                logSegmentedClientMetric("player.rebuffer", {
                    reason: "heartbeat_stall",
                    trackId: currentTrackRef.current?.id ?? null,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType: activeSegmentedSessionRef.current?.sourceType ?? "direct",
                });
                playbackStateMachine.transition("BUFFERING");
                setIsBuffering(true);
                heartbeatRef.current?.startBufferTimeout();
            },
            onUnexpectedStop: () => {
                // Howler stopped without us knowing
                console.warn("[AudioPlaybackOrchestrator] Heartbeat detected unexpected stop");
                if (playbackStateMachine.isPlaying) {
                    // Sync React state to actual state
                    setIsPlaying(false);
                    playbackStateMachine.forceTransition("READY");
                }
            },
            onBufferTimeout: () => {
                // Been buffering too long - likely connection lost
                console.error("[AudioPlaybackOrchestrator] Buffer timeout - connection may be lost");
                logSegmentedClientMetric("player.rebuffer_timeout", {
                    reason: "heartbeat_buffer_timeout",
                    trackId: currentTrackRef.current?.id ?? null,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType: activeSegmentedSessionRef.current?.sourceType ?? "direct",
                });
                if (howlerEngine.isPlaying()) {
                    howlerEngine.pause();
                }
                playbackStateMachine.transition("ERROR", {
                    error: "Connection lost - audio stream timed out",
                    errorCode: 408,
                });
                setIsPlaying(false);
                setIsBuffering(false);
                heartbeatRef.current?.stop();
            },
            onRecovery: () => {
                // Recovered from stall
                console.log("[AudioPlaybackOrchestrator] Recovered from stall");
                logSegmentedClientMetric("player.rebuffer_recovered", {
                    reason: "heartbeat_recovery",
                    trackId: currentTrackRef.current?.id ?? null,
                    sessionId: activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType: activeSegmentedSessionRef.current?.sourceType ?? "direct",
                });
                if (playbackStateMachine.isBuffering) {
                    playbackStateMachine.transition("PLAYING");
                    setIsBuffering(false);
                }
            },
            getCurrentTime: () => howlerEngine.getCurrentTime(),
            isActuallyPlaying: () => howlerEngine.isPlaying(),
        });

        return () => {
            heartbeatRef.current?.destroy();
            heartbeatRef.current = null;
        };
    }, [setIsBuffering, setIsPlaying]);

    // Start/stop heartbeat based on playback state
    useEffect(() => {
        if (isPlaying && !isBuffering) {
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
                console.error(
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
                console.error(
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

            // Notify heartbeat of progress to detect stalls
            heartbeatRef.current?.notifyProgress(currentTimeValue);
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

            if (
                playbackType === "track" &&
                currentTrack?.id &&
                activeSegmentedSessionRef.current?.trackId === currentTrack.id
            ) {
                segmentedHandoffAttemptRef.current = 0;
            }
        };

        const handleEnd = () => {
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
                    const isListenTogether = Boolean(
                        getListenTogetherSessionSnapshot()?.groupId
                    );
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
            console.error("[AudioPlaybackOrchestrator] Playback error:", data.error);

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

        const handlePlay = () => {
            // Transition state machine to PLAYING
            playbackStateMachine.transition("PLAYING");
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);

            if (!isUserInitiatedRef.current) {
                setIsPlaying(true);
            }
            isUserInitiatedRef.current = false;
        };

        const handlePause = () => {
            if (isLoadingRef.current) return;
            if (seekReloadInProgressRef.current) return;

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

        return () => {
            howlerEngine.off("timeupdate", handleTimeUpdate);
            howlerEngine.off("load", handleLoad);
            howlerEngine.off("end", handleEnd);
            howlerEngine.off("loaderror", handleError);
            howlerEngine.off("playerror", handleError);
            howlerEngine.off("play", handlePlay);
            howlerEngine.off("pause", handlePause);
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
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
        attemptSegmentedHandoffRecovery,
        attemptTransientTrackRecovery,
        isPlaying,
        scheduleStartupPlaybackRecovery,
    ]);

    // Load and play audio when track changes
    useEffect(() => {
        const currentMediaId =
            currentTrack?.id ||
            currentAudiobook?.id ||
            currentPodcast?.id ||
            null;

        if (!currentMediaId) {
            setStreamProfile(null);
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            clearSegmentedStartupFallback();
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            loadTimeoutRetryCountRef.current = 0;
            howlerEngine.stop();
            lastTrackIdRef.current = null;
            isLoadingRef.current = false;
            playbackStateMachine.forceTransition("IDLE");
            heartbeatRef.current?.stop();
            return;
        }

        if (currentMediaId === lastTrackIdRef.current) {
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
                howlerEngine.seek(0);
                howlerEngine.play();
            }
            return;
        }

        if (isLoadingRef.current) return;

        isLoadingRef.current = true;
        lastTrackIdRef.current = currentMediaId;
        loadIdRef.current += 1;
        const thisLoadId = loadIdRef.current;
        loadTimeoutRetryCountRef.current = 0;

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
            // Always start at 0 unless we're resuming the same track in-session.
            let resumeTrackId: string | null = null;
            if (typeof window !== "undefined") {
                try {
                    resumeTrackId = readMigratingStorageItem(CURRENT_TIME_TRACK_ID_KEY);
                } catch {
                    resumeTrackId = null;
                }
            }
            if (resumeTrackId === currentTrack.id && currentTime > 0) {
                startTime = Math.max(0, currentTime);
            } else {
                startTime = 0;
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
            const directSourceForLoad = streamUrl;
            const directFormatForLoad = format;
            let usingSegmentedSource = false;

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
                    !getListenTogetherSessionSnapshot()?.groupId &&
                    resolveStreamingEngineMode() !== "howler-rollback";

                if (
                    !shouldAttemptSegmentedSession ||
                    !currentTrack ||
                    !segmentedTrackContext
                ) {
                    activeSegmentedSessionRef.current = null;
                    segmentedHandoffAttemptRef.current = 0;
                    segmentedHandoffLastAttemptAtRef.current = 0;
                    return;
                }

                const segmentedInitStartedAtMs = Date.now();
                const segmentedSessionKey = buildSegmentedSessionKey(
                    segmentedTrackContext,
                );
                const prewarmedSession = prewarmedSegmentedSessionRef.current.get(
                    segmentedSessionKey,
                );

                if (!prewarmedSession || !isSegmentedSessionUsable(prewarmedSession)) {
                    prewarmedSegmentedSessionRef.current.delete(segmentedSessionKey);
                    prewarmSegmentedSession({
                        sessionKey: segmentedSessionKey,
                        context: segmentedTrackContext,
                        trackId: currentTrack.id,
                        reason: "startup_background",
                    });
                    logSegmentedClientMetric("session.create_skipped_direct", {
                        trackId: currentTrack.id,
                        sourceType: segmentedTrackContext.sourceType,
                        reason: "session_not_prewarmed",
                    });
                    return;
                }

                prewarmedSegmentedSessionRef.current.delete(segmentedSessionKey);
                const segmentedSession = prewarmedSession;

                if (segmentedSession.engineHints?.preferDirectStartup === true) {
                    prewarmSegmentedSession({
                        sessionKey: segmentedSessionKey,
                        context: segmentedTrackContext,
                        trackId: currentTrack.id,
                        reason: "startup_background",
                    });
                    logSegmentedClientMetric("session.create_fallback_direct", {
                        trackId: currentTrack.id,
                        sourceType:
                            segmentedSession.playbackProfile?.sourceType ??
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        reason: "backend_prefer_direct_startup",
                    });
                    return;
                }

                if (
                    isLosslessSegmentedSession(segmentedSession) &&
                    !supportsLosslessSegmentedPlayback()
                ) {
                    logSegmentedClientMetric("session.create_fallback_direct", {
                        trackId: currentTrack.id,
                        sourceType:
                            segmentedSession.playbackProfile?.sourceType ??
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        reason: "lossless_segmented_unsupported",
                    });
                    return;
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
                format = "mp4";

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
                    initSource: "prewarm",
                    latencyMs: Math.max(0, Date.now() - segmentedInitStartedAtMs),
                });
                segmentedHandoffAttemptRef.current = 0;
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
                    forceDirect?: boolean;
                    fallbackReason?: string;
                } = {},
            ) => {
                clearLoadListeners();
                clearSegmentedStartupFallback();

                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }

                await resolveSourceForLoad();

                if (loadIdRef.current !== thisLoadId || !isLoadingRef.current) {
                    return;
                }

                if (options.forceDirect) {
                    sourceForLoad = directSourceForLoad;
                    sourceRequestHeaders = undefined;
                    usingSegmentedSource = false;
                    format = directFormatForLoad;
                    activeSegmentedSessionRef.current = null;
                    segmentedHandoffAttemptRef.current = 0;
                    segmentedHandoffLastAttemptAtRef.current = 0;
                    if (playbackType === "track" && currentTrack) {
                        setStreamProfile({
                            mode: "direct",
                            sourceType: resolveDirectTrackSourceType(currentTrack),
                            codec: null,
                            bitrateKbps: null,
                        });
                        logSegmentedClientMetric("session.create_fallback_direct", {
                            trackId: currentTrack.id,
                            sourceType: resolveDirectTrackSourceType(currentTrack),
                            reason:
                                options.fallbackReason ??
                                "segmented_startup_timeout",
                        });
                    }
                }

                if (typeof sourceForLoad === "string") {
                    howlerEngine.load(sourceForLoad, false, format);
                } else {
                    howlerEngine.load(sourceForLoad, {
                        autoplay: false,
                        format,
                        withCredentials: true,
                        requestHeaders: sourceRequestHeaders,
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
                    if (loadTimeoutRef.current) {
                        clearTimeout(loadTimeoutRef.current);
                        loadTimeoutRef.current = null;
                    }
                    loadTimeoutRetryCountRef.current = 0;
                    isLoadingRef.current = false;

                    if (startTime > 0) {
                        howlerEngine.seek(startTime);
                        setCurrentTime(startTime);
                    }
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

                    if (shouldAutoPlay) {
                        howlerEngine.play();
                        if (!lastPlayingStateRef.current) {
                            setIsPlaying(true);
                        }
                    }

                    clearLoadListeners();
                };

                const handleLoadError = () => {
                    clearSegmentedStartupFallback();
                    if (loadTimeoutRef.current) {
                        clearTimeout(loadTimeoutRef.current);
                        loadTimeoutRef.current = null;
                    }
                    loadTimeoutRetryCountRef.current = 0;
                    isLoadingRef.current = false;

                    if (
                        usingSegmentedSource &&
                        playbackType === "track" &&
                        currentTrack &&
                        !getListenTogetherSessionSnapshot()?.groupId
                    ) {
                        console.warn(
                            "[AudioPlaybackOrchestrator] Segmented loaderror detected; falling back to direct stream.",
                        );
                        isLoadingRef.current = true;
                        playbackStateMachine.forceTransition("LOADING");
                        void startLoadAttempt({
                            forceDirect: true,
                            fallbackReason: "segmented_load_error",
                        });
                        return;
                    }

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
                    !getListenTogetherSessionSnapshot()?.groupId
                ) {
                    const fallbackTimeoutMs =
                        resolveSegmentedStartupFallbackTimeoutMs();
                    segmentedStartupFallbackTimeoutRef.current = setTimeout(() => {
                        if (loadIdRef.current !== thisLoadId || !isLoadingRef.current) {
                            return;
                        }
                        if (!usingSegmentedSource) {
                            return;
                        }

                        console.warn(
                            `[AudioPlaybackOrchestrator] Segmented startup exceeded ${fallbackTimeoutMs}ms; falling back to direct stream.`
                        );
                        howlerEngine.stop();
                        playbackStateMachine.forceTransition("LOADING");
                        void startLoadAttempt({
                            forceDirect: true,
                            fallbackReason: "segmented_startup_timeout",
                        });
                    }, fallbackTimeoutMs);
                }

                loadTimeoutRef.current = setTimeout(() => {
                    if (loadIdRef.current !== thisLoadId || !isLoadingRef.current) {
                        return;
                    }

                    const retryAttempt = loadTimeoutRetryCountRef.current + 1;
                    if (retryAttempt <= AUDIO_LOAD_TIMEOUT_RETRIES) {
                        loadTimeoutRetryCountRef.current = retryAttempt;
                        console.warn(
                            `[AudioPlaybackOrchestrator] Audio load timed out after ${AUDIO_LOAD_TIMEOUT_MS}ms; retrying (${retryAttempt}/${AUDIO_LOAD_TIMEOUT_RETRIES})`
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

                    console.error(
                        `[AudioPlaybackOrchestrator] Audio load timed out after ${AUDIO_LOAD_TIMEOUT_MS}ms`
                    );
                    loadTimeoutRetryCountRef.current = 0;
                    isLoadingRef.current = false;
                    lastTrackIdRef.current = null;
                    playbackStateMachine.forceTransition("ERROR", {
                        error: "Audio stream timed out while loading",
                        errorCode: 408,
                    });
                    setIsPlaying(false);
                    setIsBuffering(false);
                    clearLoadListeners();
                    loadTimeoutRef.current = null;
                }, AUDIO_LOAD_TIMEOUT_MS);
            };

            void startLoadAttempt();
        } else {
            clearSegmentedStartupFallback();
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            loadTimeoutRetryCountRef.current = 0;
            isLoadingRef.current = false;
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
        clearTransientTrackRecovery,
        prewarmSegmentedSession,
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
            Boolean(nextSegmentedTrackContext) &&
            !getListenTogetherSessionSnapshot()?.groupId &&
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
                console.error(
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
        scheduleStartupPlaybackRecovery,
        clearStartupPlaybackRecovery,
    ]);

    // Handle volume changes
    useEffect(() => {
        howlerEngine.setVolume(volume);
    }, [volume]);

    // Handle mute changes
    useEffect(() => {
        howlerEngine.setMuted(isMuted);
    }, [isMuted]);

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

                        console.warn(
                            "[AudioPlaybackOrchestrator] Cache polling timeout"
                        );
                        setIsBuffering(false);
                        setTargetSeekPosition(null);
                    }
                } catch (error) {
                    console.error(
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
                                const seekSucceeded =
                                    Math.abs(actualPos - seekTime) < 5; // Within 5 seconds

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
                        console.warn(
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
                            // Improved check: if we are more than 5 seconds away from target
                            const seekFailed =
                                Math.abs(actualPos - seekTime) > 5;

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
                            console.error(
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
            if (seekReloadListenerRef.current) {
                howlerEngine.off("load", seekReloadListenerRef.current);
                seekReloadListenerRef.current = null;
            }
            if (seekDebounceRef.current) {
                clearTimeout(seekDebounceRef.current);
                seekDebounceRef.current = null;
            }
        };
    }, [clearSegmentedStartupFallback]);

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
            prewarmedSegmentedSessions.clear();
            segmentedPrewarmInFlight.clear();
        };
    }, [
        clearSegmentedStartupFallback,
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
    ]);

    // This component doesn't render anything visible
    return null;
});
