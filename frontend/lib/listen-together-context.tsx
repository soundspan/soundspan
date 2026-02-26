"use client";

import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
/**
 * Listen Together context — the bridge between server-authoritative group
 * state (via Socket.IO) and the local audio player.
 *
 * Key principles:
 *  1. NEVER modifies the audio context source files.
 *  2. Drives the local player exclusively via the public API of the
 *     audio-state, audio-playback, and audio-controls contexts.
 *  3. The group has its own server-authoritative queue — completely
 *     independent from the user's normal local queue.
 *  4. Joins mid-playback are seamless: new member gets a snapshot and
 *     catches up; existing members are unaffected.
 *  5. Uses a monotonic stateVersion to prevent echo loops (instead of
 *     the fragile isApplyingRemoteState flag from pass-2).
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useAudioState, type Track } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";
import {
    listenTogetherSocket,
    type GroupSnapshot,
    type PlaybackDelta,
    type QueueDelta,
    type WaitingEvent,
    type PlayAtEvent,
    type SyncQueueItem,
    type SocketRouteProbeResult,
} from "@/lib/listen-together-socket";
import {
    enqueueLatestListenTogetherHostTrackOperation,
    getListenTogetherOptimisticTrackSelectionPolicy,
    getListenTogetherSessionSnapshot,
    requestListenTogetherGroupResync,
    setListenTogetherMembershipPending,
    setListenTogetherSessionSnapshot,
    type ListenTogetherSessionSnapshot,
} from "@/lib/listen-together-session";
import { resolveListenTogetherNavigationIndex } from "@/lib/listen-together-navigation";
import {
    normalizeCanonicalMediaProviderIdentity,
    toLegacyStreamFields,
} from "@soundspan/media-metadata-contract";

const playbackEngine = createRuntimeAudioEngine();
const LT_READY_REPORT_POLL_INTERVAL_MS = 100;
const LT_READY_REPORT_DELAY_MS = 150;
const LT_READY_REPORT_RETRY_DELAY_MS = 180;
const LT_READY_REPORT_MAX_WAIT_MS = 7_500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateGroupOptions {
    name?: string;
    visibility?: "public" | "private";
    useCurrentQueue?: boolean;
}

type SocketRouteStatus = "checking" | "ok" | "failed";

interface ListenTogetherContextType {
    /** Current group state (null when not in a group). */
    activeGroup: GroupSnapshot | null;
    /** Is the user currently in a group? */
    isInGroup: boolean;
    /** Is the user the host? */
    isHost: boolean;
    /** Can the current user control playback? (host only) */
    canControl: boolean;
    /** Can the current user edit the Listen Together queue? */
    canEditQueue: boolean;
    /** Is the initial group fetch still loading? */
    isLoading: boolean;
    /** Is Socket.IO connected? */
    isConnected: boolean;
    /** Has the socket connected at least once? (Used to avoid premature "Reconnecting" flash.) */
    hasConnectedOnce: boolean;
    /** Current reconnect attempt count while disconnected (0 when connected). */
    reconnectAttempt: number;
    /** Last error message. */
    error: string | null;
    /** Socket route preflight status for Listen Together websocket path. */
    socketRouteStatus: SocketRouteStatus;
    /** Human-readable route validation failure message (if any). */
    socketRouteError: string | null;
    /** True when socket route preflight has passed. */
    canUseListenTogether: boolean;

    // Actions (cold path — REST)
    createGroup: (options?: CreateGroupOptions) => Promise<GroupSnapshot | null>;
    joinGroup: (joinCode: string) => Promise<GroupSnapshot | null>;
    leaveGroup: () => Promise<void>;
    clearError: () => void;
    recheckSocketRoute: () => Promise<boolean>;

    // Actions (hot path — Socket.IO, forwarded through context for convenience)
    syncPlay: () => void;
    syncPause: () => void;
    syncSeek: (positionMs: number) => void;
    syncNext: () => void;
    syncPrevious: () => void;
    syncSetTrack: (index: number) => void;
    syncAddToQueue: (trackIds: string[]) => void;
    syncRemoveFromQueue: (index: number) => void;
    syncClearQueue: () => void;
}

const ListenTogetherContext = createContext<ListenTogetherContextType | undefined>(undefined);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a SyncQueueItem to a local Track for the audio player. */
function toLocalTrack(item: SyncQueueItem): Track {
    const provider = normalizeCanonicalMediaProviderIdentity({
        mediaSource: item.mediaSource,
        providerTrackId: item.provider?.providerTrackId,
        tidalTrackId: item.provider?.tidalTrackId ?? item.tidalTrackId,
        youtubeVideoId: item.provider?.youtubeVideoId ?? item.youtubeVideoId,
        streamSource: item.streamSource,
    });
    const legacyStreamFields = toLegacyStreamFields(provider);

    return {
        id: item.id,
        title: item.title,
        duration: item.duration,
        artist: { id: item.artist.id, name: item.artist.name },
        album: { id: item.album.id, title: item.album.title, coverArt: item.album.coverArt ?? undefined },
        mediaSource: provider.source,
        provider,
        ...legacyStreamFields,
    };
}

function extractLocalTrackIds(queue: Track[], currentTrack: Track | null): {
    localTrackIds: string[];
    removedCount: number;
} {
    const source = queue.length > 0 ? queue : currentTrack ? [currentTrack] : [];
    const local = source.filter((t) => !t.streamSource);
    return { localTrackIds: local.map((t) => t.id), removedCount: source.length - local.length };
}

function formatSocketRouteError(result: SocketRouteProbeResult): string {
    switch (result.reason) {
        case "frontend-route":
            return "Listen Together is blocked: /socket.io/listen-together is not reaching the backend Socket.IO service. Verify frontend socket proxy routing or direct backend path routing.";
        case "http-error":
            return `Listen Together socket probe failed with HTTP ${result.status ?? "error"}. Ensure /socket.io/listen-together reaches backend Socket.IO and websocket upgrades are enabled.`;
        case "timeout":
            return "Listen Together socket probe timed out. Verify your proxy/tunnel forwards /socket.io/listen-together correctly.";
        case "network-error":
            return "Listen Together socket probe could not reach the server. Check public URL, proxy/tunnel routing, and backend reachability.";
        case "unexpected-response":
            return "Listen Together socket probe received an unexpected response. /socket.io/listen-together must terminate on the backend Socket.IO service.";
        default:
            return "Listen Together websocket routing is not configured correctly. Ensure /socket.io/listen-together reaches backend Socket.IO.";
    }
}

export type ListenTogetherMembershipPendingOperation =
    | "create"
    | "join"
    | null;

export function resolveListenTogetherMembershipPendingState(
    operation: ListenTogetherMembershipPendingOperation,
): boolean {
    return operation === "create" || operation === "join";
}

export interface ResolveListenTogetherHostControlInput {
    activeGroupId: string | null | undefined;
    hostUserId: string | null | undefined;
    userId: string | null | undefined;
    snapshot: ListenTogetherSessionSnapshot | null;
}

export function canIssueListenTogetherHostPlaybackCommand(
    input: ResolveListenTogetherHostControlInput,
): boolean {
    if (!input.activeGroupId) return false;

    const hasUserId =
        typeof input.userId === "string" && input.userId.length > 0;
    const hasHostUserId =
        typeof input.hostUserId === "string" && input.hostUserId.length > 0;

    if (hasUserId && hasHostUserId) {
        return input.hostUserId === input.userId;
    }

    if (!input.snapshot || !input.snapshot.isHost) {
        return false;
    }

    return input.snapshot.groupId === input.activeGroupId;
}

export type ListenTogetherReadyReportRecoveryAction =
    | "retry"
    | "terminal-retry"
    | "recover";

export function resolveListenTogetherReadyReportRecoveryAction(input: {
    elapsedMs: number;
    maxWaitMs: number;
    terminalRetryAttempted: boolean;
}): ListenTogetherReadyReportRecoveryAction {
    if (input.elapsedMs < input.maxWaitMs) {
        return "retry";
    }
    return input.terminalRetryAttempted ? "recover" : "terminal-retry";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ListenTogetherProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, user } = useAuth();
    const audioState = useAudioState();
    const controls = useAudioControls();

    // State
    const [activeGroup, setActiveGroup] = useState<GroupSnapshot | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isConnected, setIsConnected] = useState(false);
    const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
    const [reconnectAttempt, setReconnectAttempt] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [socketRouteStatus, setSocketRouteStatus] = useState<SocketRouteStatus>("checking");
    const [socketRouteError, setSocketRouteError] = useState<string | null>(null);

    // Derived
    const isHost = canIssueListenTogetherHostPlaybackCommand({
        activeGroupId: activeGroup?.id,
        hostUserId: activeGroup?.hostUserId,
        userId: user?.id,
        snapshot: getListenTogetherSessionSnapshot(),
    });
    const canControl = Boolean(isHost);
    const canEditQueue = Boolean(activeGroup);
    const canUseListenTogether = socketRouteStatus === "ok";

    // Refs to avoid stale closures in socket callbacks
    const activeGroupRef = useRef<GroupSnapshot | null>(null);
    const lastAppliedVersionRef = useRef(0);
    const isApplyingRemoteRef = useRef(false);
    const awaitingInitialStateRef = useRef(true);
    const readyReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const routeRecheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingReconnectAudioRecoveryRef = useRef(false);
    const reconnectAudioRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const controlsRef = useRef(controls);
    const audioStateRef = useRef(audioState);
    const lastLoadedTrackIdRef = useRef<string | null>(null);

    // Keep refs in sync
    useEffect(() => { activeGroupRef.current = activeGroup; }, [activeGroup]);
    useEffect(() => { controlsRef.current = controls; }, [controls]);
    useEffect(() => { audioStateRef.current = audioState; }, [audioState]);
    useEffect(() => {
        const onLoad = () => {
            lastLoadedTrackIdRef.current =
                audioStateRef.current.currentTrack?.id ?? null;
        };

        playbackEngine.on("load", onLoad);
        return () => {
            playbackEngine.off("load", onLoad);
        };
    }, []);
    useEffect(() => {
        return () => {
            if (readyReportTimerRef.current) {
                clearTimeout(readyReportTimerRef.current);
                readyReportTimerRef.current = null;
            }
            if (routeRecheckTimerRef.current) {
                clearTimeout(routeRecheckTimerRef.current);
                routeRecheckTimerRef.current = null;
            }
            if (reconnectAudioRecoveryTimeoutRef.current) {
                clearTimeout(reconnectAudioRecoveryTimeoutRef.current);
                reconnectAudioRecoveryTimeoutRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        return () => {
            setListenTogetherMembershipPending(false);
        };
    }, []);

    const validateSocketRoute = useCallback(async (force: boolean = false): Promise<boolean> => {
        setSocketRouteStatus("checking");
        const probeResult = await listenTogetherSocket.probeRoute(force);
        if (probeResult.ok) {
            setSocketRouteStatus("ok");
            setSocketRouteError(null);
            return true;
        }

        const message = formatSocketRouteError(probeResult);
        setSocketRouteStatus("failed");
        setSocketRouteError(message);
        return false;
    }, []);

    const scheduleRouteRecheck = useCallback((delayMs: number = 1500) => {
        if (routeRecheckTimerRef.current) return;
        routeRecheckTimerRef.current = setTimeout(() => {
            routeRecheckTimerRef.current = null;
            void validateSocketRoute(true);
        }, delayMs);
    }, [validateSocketRoute]);

    // -----------------------------------------------------------------------
    // Player manipulation helpers (defined before the callbacks that use them)
    // -----------------------------------------------------------------------

    const applyPlaybackToPlayer = useCallback((snapshot: GroupSnapshot) => {
        const pb = snapshot.playback;
        if (!pb || !Array.isArray(pb.queue)) return;
        const mappedQueue = pb.queue.map(toLocalTrack);
        const safeIndex = mappedQueue.length > 0
            ? Math.min(Math.max(pb.currentIndex, 0), mappedQueue.length - 1)
            : 0;
        const targetTrack = mappedQueue[safeIndex] ?? null;

        const state = audioStateRef.current;
        const ctrl = controlsRef.current;

        isApplyingRemoteRef.current = true;

        // Set queue + track
        state.setPlaybackType("track");
        state.setQueue(mappedQueue);
        state.setCurrentIndex(safeIndex);
        state.setCurrentTrack(targetTrack);
        state.setCurrentAudiobook(null);
        state.setCurrentPodcast(null);
        state.setIsShuffle(false); // Sync groups don't use shuffle
        state.setVibeMode(false);

        // Compute target position (compensate for network latency)
        let targetMs = Math.max(0, pb.positionMs);
        if (pb.isPlaying && pb.serverTime) {
            const age = Date.now() - pb.serverTime;
            targetMs += Math.min(Math.max(age, 0), 5000); // Cap compensation at 5s
        }
        if (targetTrack?.duration) {
            targetMs = Math.min(targetMs, targetTrack.duration * 1000);
        }

        // Convert to seconds for the player
        const targetSec = targetMs / 1000;

        // Seek if needed
        const drift = Math.abs(playbackEngine.getCurrentTime() - targetSec);
        if (drift > 1.5 || state.currentTrack?.id !== targetTrack?.id) {
            ctrl.seek(targetSec, {
                allowListenTogetherFollower: true,
                suppressListenTogetherBroadcast: true,
            });
        }

        // Play/pause
        if (pb.isPlaying) {
            ctrl.resume({
                suppressListenTogetherBroadcast: true,
                listenTogetherForceIsPlaying: true,
                listenTogetherPositionMs: pb.positionMs,
                listenTogetherServerTimeMs: pb.serverTime,
            });
        } else {
            ctrl.pause({ suppressListenTogetherBroadcast: true });
        }

        requestAnimationFrame(() => { isApplyingRemoteRef.current = false; });
    }, []);

    const applyDeltaToPlayer = useCallback((delta: PlaybackDelta) => {
        const state = audioStateRef.current;
        const ctrl = controlsRef.current;

        isApplyingRemoteRef.current = true;

        // Handle track change if currentIndex changed
        const currentQueue = state.queue;
        if (delta.currentIndex !== state.currentIndex && currentQueue.length > 0) {
            const safeIdx = Math.min(Math.max(delta.currentIndex, 0), currentQueue.length - 1);
            state.setCurrentIndex(safeIdx);
            state.setCurrentTrack(currentQueue[safeIdx] ?? null);
        }

        // Compute target position
        let targetMs = Math.max(0, delta.positionMs);
        if (delta.isPlaying && delta.serverTime) {
            const age = Date.now() - delta.serverTime;
            targetMs += Math.min(Math.max(age, 0), 5000);
        }
        const track = currentQueue[delta.currentIndex];
        if (track?.duration) {
            targetMs = Math.min(targetMs, track.duration * 1000);
        }

        const targetSec = targetMs / 1000;
        const drift = Math.abs(playbackEngine.getCurrentTime() - targetSec);

        // Seek if drift is significant
        if (drift > 1.5) {
            ctrl.seek(targetSec, {
                allowListenTogetherFollower: true,
                suppressListenTogetherBroadcast: true,
            });
        }

        // Play/pause
        if (delta.isPlaying && !playbackEngine.isPlaying()) {
            ctrl.resume({
                suppressListenTogetherBroadcast: true,
                listenTogetherForceIsPlaying: true,
                listenTogetherPositionMs: delta.positionMs,
                listenTogetherServerTimeMs: delta.serverTime,
            });
        } else if (!delta.isPlaying && playbackEngine.isPlaying()) {
            ctrl.pause({ suppressListenTogetherBroadcast: true });
        }

        requestAnimationFrame(() => { isApplyingRemoteRef.current = false; });
    }, []);

    const recoverAudioAfterReconnect = useCallback((snapshot: GroupSnapshot) => {
        const pb = snapshot.playback;
        if (!pb?.isPlaying || !Array.isArray(pb.queue) || pb.queue.length === 0) {
            return;
        }

        const safeIndex = Math.min(
            Math.max(pb.currentIndex, 0),
            pb.queue.length - 1
        );
        const targetTrack = pb.queue[safeIndex];
        if (!targetTrack) {
            return;
        }

        let targetMs = Math.max(0, pb.positionMs);
        if (pb.serverTime) {
            const age = Date.now() - pb.serverTime;
            targetMs += Math.min(Math.max(age, 0), 5000);
        }
        if (targetTrack.duration) {
            targetMs = Math.min(targetMs, targetTrack.duration * 1000);
        }
        const targetSec = targetMs / 1000;

        const clearRecoveryTimeout = () => {
            if (reconnectAudioRecoveryTimeoutRef.current) {
                clearTimeout(reconnectAudioRecoveryTimeoutRef.current);
                reconnectAudioRecoveryTimeoutRef.current = null;
            }
        };

        const onReloaded = () => {
            playbackEngine.off("load", onReloaded);
            clearRecoveryTimeout();

            const active = activeGroupRef.current;
            if (!active?.playback?.isPlaying) return;

            controlsRef.current.seek(targetSec, {
                allowListenTogetherFollower: true,
                suppressListenTogetherBroadcast: true,
            });
            controlsRef.current.resume({
                suppressListenTogetherBroadcast: true,
                listenTogetherForceIsPlaying: true,
                listenTogetherPositionMs: active.playback.positionMs,
                listenTogetherServerTimeMs: active.playback.serverTime,
            });
        };

        // Force stream re-open to recover from dead socket-backed stream handles
        // after backend pod failover.
        playbackEngine.on("load", onReloaded);
        clearRecoveryTimeout();
        reconnectAudioRecoveryTimeoutRef.current = setTimeout(() => {
            playbackEngine.off("load", onReloaded);
            reconnectAudioRecoveryTimeoutRef.current = null;
        }, 10_000);
        playbackEngine.reload();
    }, []);

    // -----------------------------------------------------------------------
    // Apply remote state to local player
    // -----------------------------------------------------------------------

    /**
     * Core sync function: takes a group snapshot and drives the local player
     * to match. Only runs for followers (non-controllers) or on initial join.
     */
    const applyGroupState = useCallback((snapshot: GroupSnapshot, forceApply: boolean = false) => {
        const incomingVersion = snapshot.playback?.stateVersion ?? 0;
        const shouldApplyPlayback = forceApply
            ? incomingVersion >= lastAppliedVersionRef.current
            : incomingVersion > lastAppliedVersionRef.current;

        setActiveGroup((prev) => {
            if (!prev || shouldApplyPlayback) {
                return snapshot;
            }

            // Preserve the latest known playback fields to prevent
            // stale/equal-version snapshots from visually rewinding track state.
            return {
                ...snapshot,
                syncState: prev.syncState,
                playback: prev.playback,
            };
        });

        if (!shouldApplyPlayback) return;
        lastAppliedVersionRef.current = incomingVersion;

        applyPlaybackToPlayer(snapshot);
    }, [applyPlaybackToPlayer]);

    /**
     * Apply a lightweight playback delta (play/pause/seek).
     * Lighter than full state — doesn't touch the queue.
     */
    const applyPlaybackDelta = useCallback((delta: PlaybackDelta) => {
        if (!activeGroupRef.current) return;

        // Ignore stale/equal versions so late packets cannot cause track/index flicker.
        if (delta.stateVersion <= lastAppliedVersionRef.current) return;
        lastAppliedVersionRef.current = delta.stateVersion;

        // Update local group state
        setActiveGroup((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                playback: {
                    ...prev.playback,
                    isPlaying: delta.isPlaying,
                    positionMs: delta.positionMs,
                    serverTime: delta.serverTime,
                    stateVersion: delta.stateVersion,
                    currentIndex: delta.currentIndex,
                    trackId: delta.trackId,
                },
                syncState: delta.isPlaying ? "playing" : "paused",
            };
        });

        applyDeltaToPlayer(delta);
    }, [applyDeltaToPlayer]);

    /**
     * Apply a queue delta — queue changed server-side.
     */
    const applyQueueDelta = useCallback((delta: QueueDelta) => {
        // Ignore stale/equal versions so late queue packets cannot rewind visuals.
        if (delta.stateVersion <= lastAppliedVersionRef.current) return;
        lastAppliedVersionRef.current = delta.stateVersion;

        setActiveGroup((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                playback: {
                    ...prev.playback,
                    queue: delta.queue,
                    currentIndex: delta.currentIndex,
                    trackId: delta.trackId,
                    stateVersion: delta.stateVersion,
                },
            };
        });

        // Rebuild local queue from sync queue
        if (!Array.isArray(delta.queue)) return;
        const mappedQueue = delta.queue.map(toLocalTrack);
        const safeIndex = mappedQueue.length > 0
            ? Math.min(Math.max(delta.currentIndex, 0), mappedQueue.length - 1)
            : 0;

        isApplyingRemoteRef.current = true;
        const aState = audioStateRef.current;

        aState.setPlaybackType("track");
        aState.setQueue(mappedQueue);
        aState.setCurrentIndex(safeIndex);
        aState.setCurrentTrack(mappedQueue[safeIndex] ?? null);
        aState.setCurrentAudiobook(null);
        aState.setCurrentPodcast(null);
        aState.setVibeMode(false);

        // Use requestAnimationFrame to clear the flag after React processes updates
        requestAnimationFrame(() => { isApplyingRemoteRef.current = false; });
    }, []);

    // -----------------------------------------------------------------------
    // Socket.IO lifecycle
    // -----------------------------------------------------------------------

    /** Connect to Socket.IO and wire up event handlers. */
    const connectSocket = useCallback((groupId: string) => {
        awaitingInitialStateRef.current = true;

        listenTogetherSocket.connect({
            onGroupState: (snapshot) => {
                const forceApply = awaitingInitialStateRef.current;
                const shouldRecoverAudio = pendingReconnectAudioRecoveryRef.current;
                awaitingInitialStateRef.current = false;
                applyGroupState(snapshot, forceApply);
                if (shouldRecoverAudio) {
                    pendingReconnectAudioRecoveryRef.current = false;
                    recoverAudioAfterReconnect(snapshot);
                }
            },
            onPlaybackDelta: (delta) => applyPlaybackDelta(delta),
            onQueueDelta: (delta) => applyQueueDelta(delta),
            onWaiting: (data: WaitingEvent) => {
                if (readyReportTimerRef.current) {
                    clearTimeout(readyReportTimerRef.current);
                    readyReportTimerRef.current = null;
                }

                // The server says "buffer this track and report ready".
                // Wait for track match + media load readiness before reporting
                // ready, with a bounded timeout fallback to avoid hard deadlocks.
                const startedAt = Date.now();
                let terminalRetryAttempted = false;
                let recoveryTriggered = false;

                const triggerReadyReportRecovery = (
                    reason: string,
                    details: Record<string, unknown>,
                ) => {
                    if (recoveryTriggered) return;
                    recoveryTriggered = true;
                    sharedFrontendLogger.warn(reason, details);
                    void requestListenTogetherGroupResync(
                        activeGroupRef.current?.id,
                    ).catch((recoveryError) => {
                        sharedFrontendLogger.warn(
                            "[ListenTogether] ready report recovery resync failed",
                            {
                                error:
                                    recoveryError instanceof Error
                                        ? recoveryError.message
                                        : String(recoveryError),
                            },
                        );
                    });
                };

                const tryReportReady = () => {
                    const state = audioStateRef.current;
                    const queuedTrackId = state.queue[state.currentIndex]?.id ?? null;
                    const activeTrackId = state.currentTrack?.id ?? null;
                    const expectedTrackId = data.trackId ?? null;
                    const hasTrackMatch =
                        !expectedTrackId ||
                        queuedTrackId === expectedTrackId ||
                        activeTrackId === expectedTrackId;
                    const loadedTrackId = lastLoadedTrackIdRef.current;
                    const readinessTrackId =
                        expectedTrackId ?? activeTrackId ?? queuedTrackId;
                    const hasLoadedExpectedTrack =
                        Boolean(readinessTrackId) &&
                        loadedTrackId === readinessTrackId;
                    const durationSec = playbackEngine.getDuration();
                    const currentTimeSec = playbackEngine.getCurrentTime();
                    const hasEngineMediaData =
                        (Number.isFinite(durationSec) && durationSec > 0) ||
                        (Number.isFinite(currentTimeSec) && currentTimeSec > 0);
                    const mediaReady = hasLoadedExpectedTrack && hasEngineMediaData;
                    const timedOut =
                        Date.now() - startedAt >= LT_READY_REPORT_MAX_WAIT_MS;

                    if (hasTrackMatch && (mediaReady || timedOut)) {
                        readyReportTimerRef.current = setTimeout(() => {
                            readyReportTimerRef.current = null;
                            listenTogetherSocket.reportReady().catch((error) => {
                                const elapsedMs = Date.now() - startedAt;
                                const recoveryAction =
                                    resolveListenTogetherReadyReportRecoveryAction(
                                        {
                                            elapsedMs,
                                            maxWaitMs: LT_READY_REPORT_MAX_WAIT_MS,
                                            terminalRetryAttempted,
                                        },
                                    );
                                if (recoveryAction === "retry") {
                                    readyReportTimerRef.current = setTimeout(
                                        tryReportReady,
                                        LT_READY_REPORT_RETRY_DELAY_MS,
                                    );
                                    return;
                                }
                                if (recoveryAction === "terminal-retry") {
                                    terminalRetryAttempted = true;
                                    readyReportTimerRef.current = setTimeout(
                                        tryReportReady,
                                        LT_READY_REPORT_RETRY_DELAY_MS,
                                    );
                                    return;
                                }

                                triggerReadyReportRecovery(
                                    "[ListenTogether] reportReady failed after terminal retry window",
                                    {
                                        error:
                                            error instanceof Error
                                                ? error.message
                                                : String(error),
                                        elapsedMs,
                                        expectedTrackId,
                                        queuedTrackId,
                                        activeTrackId,
                                        terminalRetryAttempted,
                                    },
                                );
                            });
                        }, LT_READY_REPORT_DELAY_MS);
                        return;
                    }

                    if (timedOut) {
                        readyReportTimerRef.current = null;
                        triggerReadyReportRecovery(
                            "[ListenTogether] ready report timed out before local media was ready",
                            {
                                expectedTrackId,
                                queuedTrackId,
                                activeTrackId,
                                loadedTrackId,
                                mediaReady,
                            },
                        );
                        return;
                    }

                    readyReportTimerRef.current = setTimeout(
                        tryReportReady,
                        LT_READY_REPORT_POLL_INTERVAL_MS,
                    );
                };

                tryReportReady();
            },
            onPlayAt: (data: PlayAtEvent) => {
                // Synchronized start: the server says "play at positionMs at serverTime"
                const state = audioStateRef.current;
                const ctrl = controlsRef.current;

                if (data.stateVersion <= lastAppliedVersionRef.current) return;
                lastAppliedVersionRef.current = data.stateVersion;

                isApplyingRemoteRef.current = true;

                setActiveGroup((prev) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        syncState: "playing",
                        playback: {
                            ...prev.playback,
                            isPlaying: true,
                            positionMs: data.positionMs,
                            serverTime: data.serverTime,
                            stateVersion: data.stateVersion,
                        },
                    };
                });

                const elapsed = Date.now() - data.serverTime;
                const targetSec = (data.positionMs + Math.max(elapsed, 0)) / 1000;
                const track = state.queue[state.currentIndex];
                const clampedSec = track?.duration
                    ? Math.min(targetSec, track.duration)
                    : targetSec;

                ctrl.seek(Math.max(0, clampedSec), {
                    allowListenTogetherFollower: true,
                    suppressListenTogetherBroadcast: true,
                });
                ctrl.resume({
                    suppressListenTogetherBroadcast: true,
                    listenTogetherForceIsPlaying: true,
                    listenTogetherPositionMs: data.positionMs,
                    listenTogetherServerTimeMs: data.serverTime,
                });

                requestAnimationFrame(() => { isApplyingRemoteRef.current = false; });
            },
            onMemberJoined: (data) => {
                if (data.userId !== user?.id) {
                    toast.info(`${data.username} joined`);
                }
                // Refresh group state
                setActiveGroup((prev) => {
                    if (!prev) return prev;
                    const exists = prev.members.some((m) => m.userId === data.userId);
                    if (exists) return prev;
                    return {
                        ...prev,
                        members: [
                            ...prev.members,
                            {
                                userId: data.userId,
                                username: data.username,
                                isHost: false,
                                joinedAt: new Date().toISOString(),
                                isConnected: true,
                            },
                        ],
                    };
                });
            },
            onMemberLeft: (data) => {
                if (data.userId !== user?.id) {
                    toast.info(`${data.username} left`);
                }
                setActiveGroup((prev) => {
                    if (!prev) return prev;
                    const updated = {
                        ...prev,
                        members: prev.members.filter((m) => m.userId !== data.userId),
                        hostUserId: data.newHostUserId ?? prev.hostUserId,
                    };
                    // Update host flag
                    if (data.newHostUserId) {
                        updated.members = updated.members.map((m) => ({
                            ...m,
                            isHost: m.userId === data.newHostUserId,
                        }));
                        if (data.newHostUserId === user?.id) {
                            toast.success("You are now the host!");
                        }
                    }
                    return updated;
                });
            },
            onGroupEnded: (_data) => {
                setActiveGroup(null);
                setHasConnectedOnce(false);
                lastAppliedVersionRef.current = 0;
                setListenTogetherMembershipPending(false);
                toast.info("Listen Together session ended");
                listenTogetherSocket.disconnect();
            },
            onConnect: () => {
                setIsConnected(true);
                setHasConnectedOnce(true);
                setReconnectAttempt(0);
                setSocketRouteStatus("ok");
                setSocketRouteError(null);
                awaitingInitialStateRef.current = true;
            },
            onReconnect: (_attempt) => {
                setIsConnected(true);
                setReconnectAttempt(0);
                setSocketRouteStatus("ok");
                setSocketRouteError(null);
                pendingReconnectAudioRecoveryRef.current = true;
            },
            onReconnectAttempt: (attempt) => {
                setReconnectAttempt(attempt);
                setIsConnected(false);
                setSocketRouteStatus("checking");
                pendingReconnectAudioRecoveryRef.current = true;
            },
            onReconnectError: (err) => {
                sharedFrontendLogger.error("[ListenTogether] Reconnect error:", err.message);
            },
            onReconnectFailed: () => {
                setError("Listen Together reconnect failed. Check route/proxy health and try rejoining.");
                void validateSocketRoute(true);
            },
            onDisconnect: (_reason) => {
                setIsConnected(false);
            },
            onError: (err) => {
                sharedFrontendLogger.error("[ListenTogether] Socket error:", err.message);
                const isRouteSensitiveError =
                    err.message.includes("xhr poll error") ||
                    err.message.includes("websocket error") ||
                    err.message.includes("transport error");
                if (isRouteSensitiveError) {
                    setSocketRouteStatus("checking");
                    scheduleRouteRecheck();
                }
            },
        });

        // Join the group room (may fail initially before socket connects —
        // the onConnect handler will retry via currentGroupId)
        listenTogetherSocket.joinGroup(groupId).catch(() => {
            // Expected to fail before socket connects; onConnect handler retries
        });
    }, [
        applyGroupState,
        applyPlaybackDelta,
        applyQueueDelta,
        recoverAudioAfterReconnect,
        scheduleRouteRecheck,
        user?.id,
        validateSocketRoute,
    ]);

    // -----------------------------------------------------------------------
    // Initial group fetch on mount
    // -----------------------------------------------------------------------

    useEffect(() => {
        if (!isAuthenticated) {
            setListenTogetherMembershipPending(false);
            queueMicrotask(() => {
                setActiveGroup(null);
                setIsLoading(false);
                lastAppliedVersionRef.current = 0;
                setSocketRouteStatus("ok");
                setSocketRouteError(null);
            });
            return;
        }

        let mounted = true;

        // Fetch the user's active group (if any) and connect if found.
        // We start the async operation immediately; the loading state is
        // set before the first render via the useState(true) initializer.
        (async () => {
            try {
                const probeResult = await listenTogetherSocket.probeRoute();
                if (!mounted) return;
                if (probeResult.ok) {
                    setSocketRouteStatus("ok");
                    setSocketRouteError(null);
                } else {
                    setSocketRouteStatus("failed");
                    setSocketRouteError(formatSocketRouteError(probeResult));
                }

                const routeOk = probeResult.ok;
                const groupSnapshot = await api.getMyListenGroup();
                if (!mounted) return;

                if (!groupSnapshot || !groupSnapshot.id) {
                    setActiveGroup(null);
                    lastAppliedVersionRef.current = 0;
                    setIsLoading(false);
                    return;
                }

                // Ensure snapshot has required structure before using it
                if (!groupSnapshot.playback || !Array.isArray(groupSnapshot.members)) {
                    sharedFrontendLogger.warn("[ListenTogether] Received malformed group snapshot, ignoring");
                    setActiveGroup(null);
                    lastAppliedVersionRef.current = 0;
                    setIsLoading(false);
                    return;
                }

                // We have an active group — connect socket
                lastAppliedVersionRef.current = groupSnapshot.playback?.stateVersion ?? 0;
                setActiveGroup(groupSnapshot);
                setIsLoading(false);
                if (routeOk) {
                    connectSocket(groupSnapshot.id);
                }
            } catch (err) {
                if (!mounted) return;
                sharedFrontendLogger.error("[ListenTogether] Failed to fetch active group:", err);
                setIsLoading(false);
            }
        })();

        return () => { mounted = false; };
    }, [isAuthenticated, connectSocket]);

    // Disconnect socket when group goes away
    useEffect(() => {
        if (!activeGroup && listenTogetherSocket.isConnected) {
            listenTogetherSocket.disconnect();
        }
    }, [activeGroup]);

    useEffect(() => {
        if (!activeGroup) {
            setListenTogetherSessionSnapshot(null);
            return;
        }
        setListenTogetherSessionSnapshot({
            groupId: activeGroup.id,
            isHost: Boolean(isHost),
            playback: {
                isPlaying: Boolean(activeGroup.playback?.isPlaying),
                positionMs: Number(activeGroup.playback?.positionMs ?? 0),
                serverTime: Number(activeGroup.playback?.serverTime ?? Date.now()),
                currentIndex: Number(activeGroup.playback?.currentIndex ?? 0),
            },
        });
    }, [activeGroup, isHost]);

    // -----------------------------------------------------------------------
    // Host heartbeat: push local playback state to server periodically.
    // Only runs when user canControl and is NOT in a waiting state.
    // This ensures the server's position stays in sync with what the host
    // is actually hearing, without any echo loops (the host never applies
    // its own broadcasts back).
    // -----------------------------------------------------------------------

    const syncState = activeGroup?.syncState;
    const groupId = activeGroup?.id;
    useEffect(() => {
        if (!groupId || !canControl || !isConnected) return;
        if (syncState === "waiting") return;

        const interval = setInterval(() => {
            if (isApplyingRemoteRef.current) return;
            if (!listenTogetherSocket.isConnected) return;

            // Only push if we're actually playing
            if (!playbackEngine.isPlaying()) return;

            // Use seek to sync position (lightweight, no ready gate)
            const positionMs = playbackEngine.getCurrentTime() * 1000;
            listenTogetherSocket.seek(positionMs).catch(() => {});
        }, 5000); // Every 5 seconds

        return () => clearInterval(interval);
    }, [groupId, canControl, isConnected, syncState]);

    const applyOptimisticHostTrackSelection = useCallback((index: number): boolean => {
        const state = audioStateRef.current;
        const queue = state.queue;
        if (!Array.isArray(queue) || queue.length === 0) return false;

        const safeIndex = Math.min(Math.max(index, 0), queue.length - 1);
        const targetTrack = queue[safeIndex] ?? null;
        if (!targetTrack) return false;
        const optimisticSelectionPolicy =
            getListenTogetherOptimisticTrackSelectionPolicy();
        if (optimisticSelectionPolicy.guardRemoteApply) {
            isApplyingRemoteRef.current = true;
        }

        // Pause current playback immediately to avoid stale audio while
        // the host navigation emit is still in-flight, then re-assert
        // playing so the load effect auto-plays the new track.
        controlsRef.current.pause({ suppressListenTogetherBroadcast: true });
        state.setPlaybackType("track");
        state.setCurrentIndex(safeIndex);
        state.setCurrentTrack(targetTrack);
        state.setCurrentAudiobook(null);
        state.setCurrentPodcast(null);
        state.setVibeMode(false);
        controlsRef.current.seek(0, {
            allowListenTogetherFollower: true,
            suppressListenTogetherBroadcast: true,
        });
        controlsRef.current.resume({ suppressListenTogetherBroadcast: true });
        if (optimisticSelectionPolicy.guardRemoteApply) {
            requestAnimationFrame(() => {
                isApplyingRemoteRef.current = false;
            });
        }
        return true;
    }, []);

    const resolveAdjacentHostTrackIndex = useCallback(
        (action: "next" | "previous"): number | null => {
            const state = audioStateRef.current;
            return resolveListenTogetherNavigationIndex({
                action,
                queueLength: state.queue.length,
                currentIndex: state.currentIndex,
                currentPositionMs: Math.max(
                    0,
                    playbackEngine.getCurrentTime() * 1000,
                ),
            });
        },
        [],
    );

    // -----------------------------------------------------------------------
    // Actions — cold path (REST)
    // -----------------------------------------------------------------------

    const createGroupAction = useCallback(async (options?: CreateGroupOptions): Promise<GroupSnapshot | null> => {
        setListenTogetherMembershipPending(
            resolveListenTogetherMembershipPendingState("create"),
        );
        try {
            setError(null);
            const routeOk = await validateSocketRoute();
            if (!routeOk) {
                setError("Listen Together needs socket route forwarding. See docs/REVERSE_PROXY_AND_TUNNELS.md.");
                toast.error("Listen Together socket route is not configured");
                return null;
            }
            const shouldUseCurrentQueue = options?.useCurrentQueue !== false;
            let localTrackIds: string[] = [];
            let currentTrackId: string | undefined;
            let currentTimeMs: number | undefined;
            let isPlaying: boolean | undefined;

            if (shouldUseCurrentQueue) {
                const { localTrackIds: ids, removedCount } = extractLocalTrackIds(
                    audioState.queue,
                    audioState.currentTrack,
                );
                localTrackIds = ids;

                const nowPlayingTrack = audioState.currentTrack;
                const isLocalNowPlayingTrack = Boolean(
                    audioState.playbackType === "track" &&
                        nowPlayingTrack?.id &&
                        !nowPlayingTrack.streamSource
                );

                if (
                    isLocalNowPlayingTrack &&
                    localTrackIds.includes(nowPlayingTrack.id)
                ) {
                    currentTrackId = nowPlayingTrack.id;
                    currentTimeMs = Math.max(0, playbackEngine.getCurrentTime() * 1000);
                    isPlaying = playbackEngine.isPlaying();
                }

                if (removedCount > 0) {
                    toast.info(`Filtered ${removedCount} streaming track${removedCount === 1 ? "" : "s"} — only local tracks are shared`);
                }
            }

            const group = await api.createListenGroup({
                name: options?.name,
                visibility: options?.visibility,
                queueTrackIds: localTrackIds,
                currentTrackId,
                currentTimeMs,
                isPlaying,
            });

            lastAppliedVersionRef.current = group.playback?.stateVersion ?? 0;
            setActiveGroup(group);

            // Connect socket
            connectSocket(group.id);

            toast.success("Group created!");
            return group;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to create group";
            setError(message);
            toast.error(message);
            return null;
        } finally {
            setListenTogetherMembershipPending(
                resolveListenTogetherMembershipPendingState(null),
            );
        }
    }, [
        audioState.queue,
        audioState.currentTrack,
        audioState.playbackType,
        connectSocket,
        validateSocketRoute,
    ]);

    const joinGroupAction = useCallback(async (joinCode: string): Promise<GroupSnapshot | null> => {
        setListenTogetherMembershipPending(
            resolveListenTogetherMembershipPendingState("join"),
        );
        try {
            setError(null);
            const routeOk = await validateSocketRoute();
            if (!routeOk) {
                setError("Listen Together needs socket route forwarding. See docs/REVERSE_PROXY_AND_TUNNELS.md.");
                toast.error("Listen Together socket route is not configured");
                return null;
            }
            const group = await api.joinListenGroup(joinCode);

            lastAppliedVersionRef.current = group.playback?.stateVersion ?? 0;
            setActiveGroup(group);

            // Connect socket — applyGroupState will run on first group:state event
            connectSocket(group.id);

            toast.success("Joined group!");
            return group;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to join group";
            setError(message);
            toast.error(message);
            return null;
        } finally {
            setListenTogetherMembershipPending(
                resolveListenTogetherMembershipPendingState(null),
            );
        }
    }, [connectSocket, validateSocketRoute]);

    const leaveGroupAction = useCallback(async () => {
        const group = activeGroupRef.current;
        if (!group) return;

        setError(null);
        setListenTogetherMembershipPending(false);
        // Optimistic cleanup first so UI remains responsive even if backend is slow.
        listenTogetherSocket.disconnect();
        setActiveGroup(null);
        setHasConnectedOnce(false);
        lastAppliedVersionRef.current = 0;

        try {
            await api.leaveListenGroup(group.id);
            toast.success("Left Listen Together group");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to leave group";
            setError(message);
            toast.error(`Leave request failed in background: ${message}`);
        }
    }, []);

    const clearError = useCallback(() => setError(null), []);

    const recheckSocketRoute = useCallback(async (): Promise<boolean> => {
        const ok = await validateSocketRoute(true);
        if (ok) {
            const group = activeGroupRef.current;
            if (group?.id && !listenTogetherSocket.isConnected) {
                connectSocket(group.id);
            }
        }
        return ok;
    }, [connectSocket, validateSocketRoute]);

    // -----------------------------------------------------------------------
    // Actions — hot path (Socket.IO wrappers)
    // -----------------------------------------------------------------------

    const syncPlay = useCallback(() => {
        // Drive local player immediately for responsive feedback
        controlsRef.current.resume({ suppressListenTogetherBroadcast: true });
        listenTogetherSocket.play().catch(() => {});
    }, []);
    const syncPause = useCallback(() => {
        controlsRef.current.pause({ suppressListenTogetherBroadcast: true });
        listenTogetherSocket.pause().catch(() => {});
    }, []);
    const syncSeek = useCallback((positionMs: number) => {
        controlsRef.current.seek(positionMs / 1000, {
            allowListenTogetherFollower: true,
            suppressListenTogetherBroadcast: true,
        });
        listenTogetherSocket.seek(positionMs).catch(() => {});
    }, []);
    const canCurrentUserControlHostPlayback = useCallback(
        (group: GroupSnapshot | null): boolean => {
            if (!group) return false;
            return canIssueListenTogetherHostPlaybackCommand({
                activeGroupId: group.id,
                hostUserId: group.hostUserId,
                userId: user?.id,
                snapshot: getListenTogetherSessionSnapshot(),
            });
        },
        [user?.id],
    );
    const syncNext = useCallback(() => {
        const group = activeGroupRef.current;
        if (!canCurrentUserControlHostPlayback(group)) {
            return;
        }

        const nextIndex = resolveAdjacentHostTrackIndex("next");
        if (nextIndex === null) return;

        enqueueLatestListenTogetherHostTrackOperation({
            action: "next",
        });
        applyOptimisticHostTrackSelection(nextIndex);
    }, [
        applyOptimisticHostTrackSelection,
        canCurrentUserControlHostPlayback,
        resolveAdjacentHostTrackIndex,
    ]);
    const syncPrevious = useCallback(() => {
        const group = activeGroupRef.current;
        if (!canCurrentUserControlHostPlayback(group)) {
            return;
        }

        const prevIndex = resolveAdjacentHostTrackIndex("previous");
        if (prevIndex === null) return;

        enqueueLatestListenTogetherHostTrackOperation({
            action: "previous",
        });
        applyOptimisticHostTrackSelection(prevIndex);
    }, [
        applyOptimisticHostTrackSelection,
        canCurrentUserControlHostPlayback,
        resolveAdjacentHostTrackIndex,
    ]);
    const syncSetTrack = useCallback((index: number) => {
        const group = activeGroupRef.current;
        if (!canCurrentUserControlHostPlayback(group)) {
            return;
        }

        const state = audioStateRef.current;
        const queueLength = state.queue.length;
        if (queueLength === 0) return;

        const safeIndex = Math.min(Math.max(index, 0), queueLength - 1);
        if (safeIndex === state.currentIndex) return;

        enqueueLatestListenTogetherHostTrackOperation({
            action: "set-track",
            index: safeIndex,
        });
        applyOptimisticHostTrackSelection(safeIndex);
    }, [applyOptimisticHostTrackSelection, canCurrentUserControlHostPlayback]);
    const syncAddToQueue = useCallback((trackIds: string[]) => {
        listenTogetherSocket.addToQueue(trackIds).catch((err) => {
            toast.error(err?.message || "Failed to add to queue");
        });
    }, []);
    const syncRemoveFromQueue = useCallback((index: number) => {
        listenTogetherSocket.removeFromQueue(index).catch((err) => {
            toast.error(err?.message || "Failed to remove from queue");
        });
    }, []);
    const syncClearQueue = useCallback(() => {
        listenTogetherSocket.clearQueue().catch((err) => {
            toast.error(err?.message || "Failed to clear queue");
        });
    }, []);

    // -----------------------------------------------------------------------
    // Context value
    // -----------------------------------------------------------------------

    const value = useMemo<ListenTogetherContextType>(() => ({
        activeGroup,
        isInGroup: Boolean(activeGroup),
        isHost: Boolean(isHost),
        canControl,
        canEditQueue,
        isLoading,
        isConnected,
        hasConnectedOnce,
        reconnectAttempt,
        error,
        socketRouteStatus,
        socketRouteError,
        canUseListenTogether,
        createGroup: createGroupAction,
        joinGroup: joinGroupAction,
        leaveGroup: leaveGroupAction,
        clearError,
        recheckSocketRoute,
        syncPlay,
        syncPause,
        syncSeek,
        syncNext,
        syncPrevious,
        syncSetTrack,
        syncAddToQueue,
        syncRemoveFromQueue,
        syncClearQueue,
    }), [
        activeGroup,
        isHost,
        canControl,
        canEditQueue,
        isLoading,
        isConnected,
        hasConnectedOnce,
        reconnectAttempt,
        error,
        socketRouteStatus,
        socketRouteError,
        canUseListenTogether,
        createGroupAction,
        joinGroupAction,
        leaveGroupAction,
        clearError,
        recheckSocketRoute,
        syncPlay,
        syncPause,
        syncSeek,
        syncNext,
        syncPrevious,
        syncSetTrack,
        syncAddToQueue,
        syncRemoveFromQueue,
        syncClearQueue,
    ]);

    return (
        <ListenTogetherContext.Provider value={value}>
            {children}
        </ListenTogetherContext.Provider>
    );
}

export function useListenTogether(): ListenTogetherContextType {
    const context = useContext(ListenTogetherContext);
    if (!context) {
        throw new Error("useListenTogether must be used within a ListenTogetherProvider");
    }
    return context;
}
