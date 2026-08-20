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
    startTransition,
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
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import { useAudioControls } from "@/lib/audio-controls-context";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";
import {
    applyGroupMemberPresence,
    formatListenTogetherSocketRouteError,
    getServerClockOffsetMs,
    listenTogetherSocket,
    type GroupSnapshot,
    type PlaybackDelta,
    type QueueDelta,
    type QueueTrackInput,
    type AvailabilityItem,
    type GroupAvailabilityEvent,
    type WaitingEvent,
    type PlayAtEvent,
    type SyncQueueItem,
} from "@/lib/listen-together-socket";
import {
    canIssueListenTogetherHostPlaybackCommand,
    computeCompensatedTargetMs,
    isStaleGroupEvent,
    resolveFollowerSeekTarget,
    resolveReconnectSeekTarget,
} from "@/lib/listenTogetherPlaybackSync";
import {
    enqueueLatestListenTogetherHostTrackOperation,
    getListenTogetherOptimisticTrackSelectionPolicy,
    getListenTogetherSessionSnapshot,
    scheduleListenTogetherGroupResync,
    setListenTogetherMembershipPending,
    setListenTogetherSessionSnapshot,
} from "@/lib/listen-together-session";
import { resolveListenTogetherNavigationIndex } from "@/lib/listen-together-navigation";
import {
    normalizeCanonicalMediaProviderIdentity,
    toLegacyStreamFields,
} from "@soundspan/media-metadata-contract";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import {
    isPlaybackAutoRestartSuppressed,
    markRemoteTrackChange as markTrackChange,
    writePlaybackAdvanceOrigin as writeOrigin,
} from "@/lib/audio-engine/playbackAdvanceOrigin";
import {
    resumeGroupForRole,
    resumeListenTogetherPlayback,
} from "@/lib/audio-engine/listenTogetherPlaybackResume";
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
    createGroup: (
        options?: CreateGroupOptions,
    ) => Promise<GroupSnapshot | null>;
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
    syncAddToQueue: (tracks: QueueTrackInput[]) => void;
    syncRemoveFromQueue: (index: number) => void;
    syncClearQueue: () => void;
    trackAvailability: Map<number, AvailabilityItem>;
}

const ListenTogetherContext = createContext<
    ListenTogetherContextType | undefined
>(undefined);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a SyncQueueItem to a local Track for the audio player. */
function toLocalTrack(
    item: SyncQueueItem,
    availability?: AvailabilityItem,
): Track {
    const resolvedSource = availability?.source;
    const effectiveSource = resolvedSource ?? item.originSource;
    const effectiveLocalTrackId =
        availability?.localTrackId ?? item.localTrackId;
    const effectiveTidalTrackId =
        availability?.tidalTrackId ??
        item.provider?.tidalTrackId ??
        item.tidalTrackId;
    const effectiveYoutubeVideoId =
        availability?.youtubeVideoId ??
        item.provider?.youtubeVideoId ??
        item.youtubeVideoId;
    const effectiveTrackId =
        effectiveSource === "local"
            ? (effectiveLocalTrackId ?? item.id)
            : item.id;
    const provider = normalizeCanonicalMediaProviderIdentity({
        mediaSource: effectiveSource === "local" ? "local" : item.mediaSource,
        providerTrackId: item.provider?.providerTrackId,
        tidalTrackId:
            effectiveSource === "youtube" ? undefined : effectiveTidalTrackId,
        youtubeVideoId:
            effectiveSource === "tidal" ? undefined : effectiveYoutubeVideoId,
        youtubeAudioFormat:
            item.provider?.youtubeAudioFormat ?? item.youtubeAudioFormat,
        streamSource:
            effectiveSource === "local"
                ? undefined
                : (effectiveSource ?? item.streamSource),
    });
    const legacyStreamFields = toLegacyStreamFields(provider);

    return {
        id: effectiveTrackId,
        title: item.title,
        duration: item.duration,
        artist: { id: item.artist.id, name: item.artist.name },
        album: {
            id: item.album.id,
            title: item.album.title,
            coverArt: item.album.coverArt ?? undefined,
        },
        mediaSource: provider.source,
        provider,
        ...legacyStreamFields,
    };
}

function extractQueueTrackInputs(
    queue: readonly QueueItem[],
    currentTrack: Track | null,
): {
    queueTracks: QueueTrackInput[];
    currentTrackId?: string;
} {
    const source: readonly QueueItem[] =
        queue.length > 0 ? queue : currentTrack ? [currentTrack] : [];
    const queueTracks: QueueTrackInput[] = [];
    for (const track of source) {
        // Listen Together queues are music-only; skip podcast episodes.
        if (isEpisodeQueueItem(track)) continue;
        try {
            queueTracks.push(toAddToPlaylistRef(track));
        } catch {
            continue;
        }
    }

    const currentTrackId =
        currentTrack && queueTracks.length > 0 ? currentTrack.id : undefined;
    return { queueTracks, currentTrackId };
}

export type ListenTogetherMembershipPendingOperation = "create" | "join" | null;

/**
 * Executes resolveListenTogetherMembershipPendingState.
 */
export function resolveListenTogetherMembershipPendingState(
    operation: ListenTogetherMembershipPendingOperation,
): boolean {
    return operation === "create" || operation === "join";
}

export type ListenTogetherReadyReportRecoveryAction =
    | "retry"
    | "terminal-retry"
    | "recover";

/**
 * Executes resolveListenTogetherReadyReportRecoveryAction.
 */
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

/**
 * Renders the ListenTogetherProvider component.
 */
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
    const [socketRouteStatus, setSocketRouteStatus] =
        useState<SocketRouteStatus>("checking");
    const [socketRouteError, setSocketRouteError] = useState<string | null>(
        null,
    );
    const [trackAvailability, setTrackAvailability] = useState<
        Map<number, AvailabilityItem>
    >(new Map());

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
    const pendingHostTrackIndexRef = useRef<number | null>(null);
    const hostMustAdoptGroupPositionRef = useRef(false);
    const hasEverConnectedRef = useRef(false);
    const awaitingInitialStateRef = useRef(true);
    const readyReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const readyReportLoadListenerRef = useRef<(() => void) | null>(null);
    const readyReportTargetRef = useRef<{
        currentIndex: number;
        trackId: string | null;
    } | null>(null);
    const availabilitySwapLoadListenerRef = useRef<(() => void) | null>(null);
    const routeRecheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const pendingReconnectAudioRecoveryRef = useRef(false);
    const reconnectAudioRecoveryTimeoutRef = useRef<ReturnType<
        typeof setTimeout
    > | null>(null);
    /** Grace period before flipping the connection indicator to disconnected. */
    const disconnectGraceTimerRef = useRef<ReturnType<
        typeof setTimeout
    > | null>(null);
    const controlsRef = useRef(controls);
    const audioStateRef = useRef(audioState);
    const trackAvailabilityRef = useRef<Map<number, AvailabilityItem>>(
        new Map(),
    );
    const trackAvailabilityStateVersionRef = useRef<number | null>(null);
    const lastLoadedTrackIdRef = useRef<string | null>(null);

    const clearReadyReportLoadListener = useCallback(() => {
        const listener = readyReportLoadListenerRef.current;
        if (listener) {
            playbackEngine.off("load", listener);
            readyReportLoadListenerRef.current = null;
        }
        readyReportTargetRef.current = null;
    }, []);

    const clearObsoleteReadyReportLoadListener = useCallback(
        (nextTrackIndex: number, nextTrackId: string | null) => {
            const target = readyReportTargetRef.current;
            const trackChanged = Boolean(
                target &&
                (target.currentIndex !== nextTrackIndex ||
                    (target.trackId &&
                        nextTrackId &&
                        target.trackId !== nextTrackId)),
            );
            if (trackChanged) {
                clearReadyReportLoadListener();
            }
        },
        [clearReadyReportLoadListener],
    );

    const clearAvailabilitySwapLoadListener = useCallback(() => {
        const listener = availabilitySwapLoadListenerRef.current;
        if (!listener) return;
        playbackEngine.off("load", listener);
        availabilitySwapLoadListenerRef.current = null;
    }, []);

    const clearActiveSessionTimers = useCallback(() => {
        clearReadyReportLoadListener();
        clearAvailabilitySwapLoadListener();
        if (readyReportTimerRef.current) {
            clearTimeout(readyReportTimerRef.current);
            readyReportTimerRef.current = null;
        }
        if (disconnectGraceTimerRef.current) {
            clearTimeout(disconnectGraceTimerRef.current);
            disconnectGraceTimerRef.current = null;
        }
    }, [clearAvailabilitySwapLoadListener, clearReadyReportLoadListener]);

    const clearActiveMembership = useCallback(() => {
        clearActiveSessionTimers();
        activeGroupRef.current = null;
        setActiveGroup(null);
        setTrackAvailability(new Map());
        trackAvailabilityRef.current = new Map();
        trackAvailabilityStateVersionRef.current = null;
        setListenTogetherSessionSnapshot(null);
        setListenTogetherMembershipPending(false);
        hasEverConnectedRef.current = false;
        setHasConnectedOnce(false);
        setIsConnected(false);
        setReconnectAttempt(0);
        lastAppliedVersionRef.current = 0;
        pendingHostTrackIndexRef.current = null;
        hostMustAdoptGroupPositionRef.current = false;
        awaitingInitialStateRef.current = true;
        pendingReconnectAudioRecoveryRef.current = false;
        isApplyingRemoteRef.current = false;
        lastLoadedTrackIdRef.current = null;
        listenTogetherSocket.disconnect();
    }, [clearActiveSessionTimers]);

    const handleMembershipRevoked = useCallback(
        (revokedGroupId: string) => {
            if (activeGroupRef.current?.id !== revokedGroupId) return;
            clearActiveMembership();
            toast.info("You left the Listen Together group");
        },
        [clearActiveMembership],
    );

    // Keep refs in sync
    useEffect(() => {
        activeGroupRef.current = activeGroup;
    }, [activeGroup]);
    useEffect(() => {
        controlsRef.current = controls;
    }, [controls]);
    useEffect(() => {
        audioStateRef.current = audioState;
    }, [audioState]);
    useEffect(() => {
        trackAvailabilityRef.current = trackAvailability;
    }, [trackAvailability]);
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
            clearActiveSessionTimers();
            if (routeRecheckTimerRef.current) {
                clearTimeout(routeRecheckTimerRef.current);
                routeRecheckTimerRef.current = null;
            }
            if (reconnectAudioRecoveryTimeoutRef.current) {
                clearTimeout(reconnectAudioRecoveryTimeoutRef.current);
                reconnectAudioRecoveryTimeoutRef.current = null;
            }
        };
    }, [clearActiveSessionTimers]);

    useEffect(() => {
        return () => {
            setListenTogetherMembershipPending(false);
        };
    }, []);

    const validateSocketRoute = useCallback(
        async (force: boolean = false): Promise<boolean> => {
            setSocketRouteStatus("checking");
            const probeResult = await listenTogetherSocket.probeRoute(force);
            if (probeResult.ok) {
                setSocketRouteStatus("ok");
                setSocketRouteError(null);
                return true;
            }

            const message = formatListenTogetherSocketRouteError(probeResult);
            setSocketRouteStatus("failed");
            setSocketRouteError(message);
            return false;
        },
        [],
    );

    const scheduleRouteRecheck = useCallback(
        (delayMs: number = 1500) => {
            if (routeRecheckTimerRef.current) return;
            routeRecheckTimerRef.current = setTimeout(() => {
                routeRecheckTimerRef.current = null;
                void validateSocketRoute(true);
            }, delayMs);
        },
        [validateSocketRoute],
    );

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

    // -----------------------------------------------------------------------
    // Player manipulation helpers (defined before the callbacks that use them)
    // -----------------------------------------------------------------------

    const applyPlaybackToPlayer = useCallback(
        (snapshot: GroupSnapshot) => {
            const pb = snapshot.playback;
            if (!pb || !Array.isArray(pb.queue)) return;
            const availabilityForState =
                trackAvailabilityStateVersionRef.current === pb.stateVersion
                    ? trackAvailabilityRef.current
                    : null;
            const mappedQueue = pb.queue.map((item, index) =>
                toLocalTrack(item, availabilityForState?.get(index)),
            );
            const safeIndex =
                mappedQueue.length > 0
                    ? Math.min(
                          Math.max(pb.currentIndex, 0),
                          mappedQueue.length - 1,
                      )
                    : 0;
            const targetTrack = mappedQueue[safeIndex] ?? null;

            const state = audioStateRef.current;
            const ctrl = controlsRef.current;
            const isCurrentClientHost =
                canCurrentUserControlHostPlayback(snapshot);
            const outgoingTrackId = state.currentTrack?.id ?? null;
            const trackChanged = outgoingTrackId !== (targetTrack?.id ?? null);
            markTrackChange(outgoingTrackId, targetTrack?.id ?? null);

            if (
                pendingHostTrackIndexRef.current !== null &&
                pendingHostTrackIndexRef.current !== safeIndex
            ) {
                pendingHostTrackIndexRef.current = null;
            }
            clearObsoleteReadyReportLoadListener(
                safeIndex,
                pb.queue[safeIndex]?.id ?? null,
            );
            isApplyingRemoteRef.current = true;

            // Pause before switching tracks to prevent buffered audio from
            // the old track replaying during the async transition.
            if (trackChanged && playbackEngine.isPlaying()) {
                ctrl.pause({ suppressListenTogetherBroadcast: true });
            }

            // Set queue + track
            state.setPlaybackType("track");
            state.setQueue(mappedQueue);
            state.setCurrentIndex(safeIndex);
            state.setCurrentTrack(targetTrack);
            state.setCurrentAudiobook(null);
            state.setCurrentPodcast(null);
            state.setIsShuffle(false); // Sync groups don't use shuffle
            state.setVibeMode(false);

            if (!isCurrentClientHost || hostMustAdoptGroupPositionRef.current) {
                const { targetSec, drifted } = resolveFollowerSeekTarget({
                    positionMs: pb.positionMs,
                    serverTimeMs: pb.serverTime,
                    isPlaying: pb.isPlaying,
                    trackDurationSec: targetTrack?.duration,
                    currentTimeSec: playbackEngine.getCurrentTime(),
                    nowMs: Date.now(),
                    clockOffsetMs: getServerClockOffsetMs(),
                });
                // Adopting hosts seek even inside the drift threshold.
                if (
                    (isCurrentClientHost &&
                        hostMustAdoptGroupPositionRef.current) ||
                    drifted ||
                    trackChanged
                ) {
                    ctrl.seek(targetSec, {
                        allowListenTogetherFollower: true,
                        suppressListenTogetherBroadcast: true,
                    });
                }
                hostMustAdoptGroupPositionRef.current = false;
            }

            // Play/pause — skip resume when a reconnect audio recovery is pending,
            // because recoverAudioAfterReconnect will reload the stream and resume
            // after the reload completes. Resuming here would race with the reload
            // and cause overlapping audio. Pause must still be applied so that a
            // paused host state is respected (recoverAudioAfterReconnect exits
            // early when !pb.isPlaying).
            if (pendingReconnectAudioRecoveryRef.current && pb.isPlaying) {
                // Let recoverAudioAfterReconnect handle resume after reload
            } else if (pb.isPlaying) {
                resumeGroupForRole(isCurrentClientHost, ctrl.resume, pb);
            } else {
                ctrl.pause({ suppressListenTogetherBroadcast: true });
            }

            queueMicrotask(() => {
                isApplyingRemoteRef.current = false;
            });
        },
        [
            canCurrentUserControlHostPlayback,
            clearObsoleteReadyReportLoadListener,
        ],
    );

    const applyDeltaToPlayer = useCallback(
        (delta: PlaybackDelta) => {
            // Ignore deltas while a reconnect audio recovery is in progress.
            // recoverAudioAfterReconnect owns the reload+resume lifecycle;
            // applying a delta here would race with that reload.
            if (pendingReconnectAudioRecoveryRef.current) return;

            const state = audioStateRef.current;
            const ctrl = controlsRef.current;
            const isCurrentClientHost = canCurrentUserControlHostPlayback(
                activeGroupRef.current,
            );

            isApplyingRemoteRef.current = true;

            // Handle track change if currentIndex changed
            const currentQueue = state.queue;
            let trackChanged = false;
            if (currentQueue.length > 0) {
                const safeIdx = Math.min(
                    Math.max(delta.currentIndex, 0),
                    currentQueue.length - 1,
                );
                const queueItem = currentQueue[safeIdx] ?? null;
                // Listen Together queues are music-only; ignore episode entries.
                const effectiveTrack =
                    queueItem && !isEpisodeQueueItem(queueItem)
                        ? queueItem
                        : null;
                trackChanged = effectiveTrack?.id !== state.currentTrack?.id;
                if (
                    pendingHostTrackIndexRef.current !== null &&
                    pendingHostTrackIndexRef.current !== safeIdx
                ) {
                    pendingHostTrackIndexRef.current = null;
                }
                clearObsoleteReadyReportLoadListener(safeIdx, delta.trackId);
                if (trackChanged) {
                    markTrackChange(
                        state.currentTrack?.id ?? null,
                        effectiveTrack?.id ?? null,
                    );
                    // Pause before switching to prevent buffered audio from the old
                    // track replaying during the async transition.
                    if (playbackEngine.isPlaying()) {
                        ctrl.pause({ suppressListenTogetherBroadcast: true });
                    }
                    state.setCurrentIndex(safeIdx);
                    state.setCurrentTrack(effectiveTrack);
                } else if (safeIdx !== state.currentIndex) {
                    state.setCurrentIndex(safeIdx);
                }
            }

            if (!isCurrentClientHost) {
                const safeTrackIdx =
                    currentQueue.length > 0
                        ? Math.min(
                              Math.max(delta.currentIndex, 0),
                              currentQueue.length - 1,
                          )
                        : -1;
                const track =
                    safeTrackIdx >= 0 ? currentQueue[safeTrackIdx] : undefined;
                const { targetSec, drifted } = resolveFollowerSeekTarget({
                    positionMs: delta.positionMs,
                    serverTimeMs: delta.serverTime,
                    isPlaying: delta.isPlaying,
                    trackDurationSec: track?.duration,
                    currentTimeSec: playbackEngine.getCurrentTime(),
                    nowMs: Date.now(),
                    clockOffsetMs: getServerClockOffsetMs(),
                });
                if (drifted) {
                    ctrl.seek(targetSec, {
                        allowListenTogetherFollower: true,
                        suppressListenTogetherBroadcast: true,
                    });
                }
            }

            // Play/pause — after a track change, always call resume if delta says
            // playing, because the pre-switch pause may have cleared isPlaying state.
            if (
                delta.isPlaying &&
                (trackChanged || !playbackEngine.isPlaying())
            ) {
                resumeGroupForRole(isCurrentClientHost, ctrl.resume, delta);
            } else if (!delta.isPlaying && playbackEngine.isPlaying()) {
                ctrl.pause({ suppressListenTogetherBroadcast: true });
            }

            queueMicrotask(() => {
                isApplyingRemoteRef.current = false;
            });
        },
        [
            canCurrentUserControlHostPlayback,
            clearObsoleteReadyReportLoadListener,
        ],
    );

    const recoverAudioAfterReconnect = useCallback(
        (snapshot: GroupSnapshot) => {
            const pb = snapshot.playback;
            if (
                !pb?.isPlaying ||
                !Array.isArray(pb.queue) ||
                pb.queue.length === 0
            ) {
                pendingReconnectAudioRecoveryRef.current = false;
                return;
            }

            const safeIndex = Math.min(
                Math.max(pb.currentIndex, 0),
                pb.queue.length - 1,
            );
            const targetTrack = pb.queue[safeIndex];
            if (!targetTrack) {
                pendingReconnectAudioRecoveryRef.current = false;
                return;
            }
            if (isPlaybackAutoRestartSuppressed()) {
                pendingReconnectAudioRecoveryRef.current = false;
                return;
            }

            const isCurrentClientHost =
                canCurrentUserControlHostPlayback(snapshot);
            const targetSec = resolveReconnectSeekTarget({
                isHost: isCurrentClientHost,
                positionMs: pb.positionMs,
                serverTimeMs: pb.serverTime,
                isPlaying: pb.isPlaying,
                trackDurationSec: targetTrack.duration,
                currentTimeSec: playbackEngine.getCurrentTime(),
                nowMs: Date.now(),
                clockOffsetMs: getServerClockOffsetMs(),
            });

            const clearRecoveryTimeout = () => {
                if (reconnectAudioRecoveryTimeoutRef.current) {
                    clearTimeout(reconnectAudioRecoveryTimeoutRef.current);
                    reconnectAudioRecoveryTimeoutRef.current = null;
                }
            };

            const onReloaded = () => {
                playbackEngine.off("load", onReloaded);
                clearRecoveryTimeout();
                pendingReconnectAudioRecoveryRef.current = false;

                const active = activeGroupRef.current;
                if (!active?.playback?.isPlaying) return;

                controlsRef.current.seek(targetSec, {
                    allowListenTogetherFollower: true,
                    suppressListenTogetherBroadcast: true,
                });
                resumeGroupForRole(
                    isCurrentClientHost,
                    controlsRef.current.resume,
                    active.playback,
                );
            };

            // Force stream re-open to recover from dead socket-backed stream handles
            // after backend pod failover.
            playbackEngine.on("load", onReloaded);
            clearRecoveryTimeout();
            reconnectAudioRecoveryTimeoutRef.current = setTimeout(() => {
                playbackEngine.off("load", onReloaded);
                reconnectAudioRecoveryTimeoutRef.current = null;
                pendingReconnectAudioRecoveryRef.current = false;
            }, 10_000);
            playbackEngine.reload();
        },
        [canCurrentUserControlHostPlayback],
    );

    // -----------------------------------------------------------------------
    // Apply remote state to local player
    // -----------------------------------------------------------------------

    /**
     * Core sync function: takes a group snapshot and drives the local player
     * to match. Only runs for followers (non-controllers) or on initial join.
     */
    const applyGroupState = useCallback(
        (snapshot: GroupSnapshot, forceApply: boolean = false) => {
            const incomingVersion = snapshot.playback?.stateVersion ?? 0;
            const shouldApplyPlayback = forceApply
                ? incomingVersion >= lastAppliedVersionRef.current
                : incomingVersion > lastAppliedVersionRef.current;

            setActiveGroup((prev) => {
                let next: GroupSnapshot;
                if (!prev || shouldApplyPlayback) {
                    next = snapshot;
                } else {
                    // Preserve the latest known playback fields to prevent
                    // stale/equal-version snapshots from visually rewinding track state.
                    next = {
                        ...snapshot,
                        syncState: prev.syncState,
                        playback: prev.playback,
                    };
                }
                // Sync ref immediately so socket handlers that read activeGroupRef
                // (e.g. onAvailability) see the latest state without waiting for
                // the useEffect render cycle.
                activeGroupRef.current = next;
                return next;
            });

            if (!shouldApplyPlayback) return;
            lastAppliedVersionRef.current = incomingVersion;

            applyPlaybackToPlayer(snapshot);
        },
        [applyPlaybackToPlayer],
    );

    /**
     * Apply a lightweight playback delta (play/pause/seek).
     * Lighter than full state — doesn't touch the queue.
     */
    const applyPlaybackDelta = useCallback(
        (delta: PlaybackDelta) => {
            if (!activeGroupRef.current) return;

            // Ignore stale/equal versions so late packets cannot cause track/index flicker.
            if (delta.stateVersion <= lastAppliedVersionRef.current) return;
            lastAppliedVersionRef.current = delta.stateVersion;

            // Update local group state
            setActiveGroup((prev) => {
                if (!prev) return prev;
                const next = {
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
                    syncState: (delta.isPlaying ? "playing" : "paused") as
                        | "playing"
                        | "paused",
                };
                activeGroupRef.current = next;
                return next;
            });

            applyDeltaToPlayer(delta);
        },
        [applyDeltaToPlayer],
    );

    /**
     * Apply a queue delta — queue changed server-side.
     */
    const applyQueueDelta = useCallback(
        (delta: QueueDelta) => {
            // Ignore stale/equal versions so late queue packets cannot rewind visuals.
            if (delta.stateVersion <= lastAppliedVersionRef.current) return;
            lastAppliedVersionRef.current = delta.stateVersion;

            setActiveGroup((prev) => {
                if (!prev) return prev;
                const next = {
                    ...prev,
                    playback: {
                        ...prev.playback,
                        queue: delta.queue,
                        currentIndex: delta.currentIndex,
                        trackId: delta.trackId,
                        stateVersion: delta.stateVersion,
                    },
                };
                activeGroupRef.current = next;
                return next;
            });

            // Rebuild local queue from sync queue
            if (!Array.isArray(delta.queue)) return;
            const availabilityForState =
                trackAvailabilityStateVersionRef.current === delta.stateVersion
                    ? trackAvailabilityRef.current
                    : null;
            const mappedQueue = delta.queue.map((item, index) =>
                toLocalTrack(item, availabilityForState?.get(index)),
            );
            const safeIndex =
                mappedQueue.length > 0
                    ? Math.min(
                          Math.max(delta.currentIndex, 0),
                          mappedQueue.length - 1,
                      )
                    : 0;

            if (
                pendingHostTrackIndexRef.current !== null &&
                pendingHostTrackIndexRef.current !== safeIndex
            ) {
                pendingHostTrackIndexRef.current = null;
            }
            clearObsoleteReadyReportLoadListener(safeIndex, delta.trackId);
            isApplyingRemoteRef.current = true;
            const aState = audioStateRef.current;
            markTrackChange(
                aState.currentTrack?.id ?? null,
                mappedQueue[safeIndex]?.id ?? null,
            );

            startTransition(() => {
                aState.setPlaybackType("track");
                aState.setQueue(mappedQueue);
                aState.setCurrentIndex(safeIndex);
                aState.setCurrentTrack(mappedQueue[safeIndex] ?? null);
                aState.setCurrentAudiobook(null);
                aState.setCurrentPodcast(null);
                aState.setVibeMode(false);
            });

            // Allow time for the deferred startTransition to commit before clearing
            setTimeout(() => {
                isApplyingRemoteRef.current = false;
            }, 100);
        },
        [clearObsoleteReadyReportLoadListener],
    );

    // -----------------------------------------------------------------------
    // Socket.IO lifecycle
    // -----------------------------------------------------------------------

    /** Connect to Socket.IO and wire up event handlers. */
    const connectSocket = useCallback(
        (groupId: string, options?: { adoptGroupPosition?: boolean }) => {
            awaitingInitialStateRef.current = true;
            // One-shot adoption: only a session's first-ever connection
            // hydrates; reading the ref here avoids stale-closure decisions.
            hostMustAdoptGroupPositionRef.current =
                options?.adoptGroupPosition ?? !hasEverConnectedRef.current;

            listenTogetherSocket.connect({
                onGroupState: (snapshot) => {
                    const forceApply = awaitingInitialStateRef.current;
                    const shouldRecoverAudio =
                        pendingReconnectAudioRecoveryRef.current;
                    awaitingInitialStateRef.current = false;
                    applyGroupState(snapshot, forceApply);
                    if (shouldRecoverAudio) {
                        // Note: the ref stays true until recoverAudioAfterReconnect
                        // completes (or exits early), so deltas are suppressed during
                        // the async reload window.
                        recoverAudioAfterReconnect(snapshot);
                    }
                },
                onPlaybackDelta: (delta) => applyPlaybackDelta(delta),
                onQueueDelta: (delta) => applyQueueDelta(delta),
                onAvailability: (data: GroupAvailabilityEvent) => {
                    const availabilityMap = new Map<number, AvailabilityItem>();
                    for (const item of data.availability ?? []) {
                        availabilityMap.set(item.queueIndex, item);
                    }
                    setTrackAvailability(availabilityMap);
                    trackAvailabilityStateVersionRef.current =
                        data.stateVersion;

                    const group = activeGroupRef.current;
                    if (!group?.playback?.queue) return;

                    const mappedQueue = group.playback.queue.map(
                        (item, index) =>
                            toLocalTrack(item, availabilityMap.get(index)),
                    );
                    const safeIndex =
                        mappedQueue.length > 0
                            ? Math.min(
                                  Math.max(group.playback.currentIndex, 0),
                                  mappedQueue.length - 1,
                              )
                            : 0;
                    const state = audioStateRef.current;
                    const targetTrack = mappedQueue[safeIndex] ?? null;
                    const loadedTrackId = state.currentTrack?.id ?? null;
                    startTransition(() => {
                        state.setQueue(mappedQueue);
                    });
                    if ((targetTrack?.id ?? null) === loadedTrackId) return;

                    const currentTimeSec = playbackEngine.getCurrentTime();
                    const resumePositionSec = Number.isFinite(currentTimeSec)
                        ? Math.max(0, currentTimeSec)
                        : 0;
                    clearAvailabilitySwapLoadListener();
                    const onSwappedTrackLoaded = () => {
                        if (
                            audioStateRef.current.currentTrack?.id !==
                            targetTrack?.id
                        ) {
                            return;
                        }
                        clearAvailabilitySwapLoadListener();
                        controlsRef.current.seek(resumePositionSec, {
                            allowListenTogetherFollower: true,
                            suppressListenTogetherBroadcast: true,
                        });
                    };
                    availabilitySwapLoadListenerRef.current =
                        onSwappedTrackLoaded;
                    playbackEngine.on("load", onSwappedTrackLoaded);

                    startTransition(() => {
                        state.setCurrentIndex(safeIndex);
                        state.setCurrentTrack(targetTrack);
                    });
                },
                onWaiting: (data: WaitingEvent) => {
                    clearReadyReportLoadListener();
                    if (readyReportTimerRef.current) {
                        clearTimeout(readyReportTimerRef.current);
                        readyReportTimerRef.current = null;
                    }

                    const trackAvailabilityForIndex =
                        trackAvailabilityRef.current.get(data.currentIndex);
                    if (trackAvailabilityForIndex?.available === false) {
                        void listenTogetherSocket
                            .reportReady()
                            .catch((error) => {
                                sharedFrontendLogger.warn(
                                    "[ListenTogether] reportReady failed for unavailable track",
                                    {
                                        queueIndex: data.currentIndex,
                                        reason: trackAvailabilityForIndex.reason,
                                        error:
                                            error instanceof Error
                                                ? error.message
                                                : String(error),
                                    },
                                );
                            });
                        return;
                    }

                    // The server says "buffer this track and report ready".
                    // Report on the matching engine load event, while retaining
                    // bounded polling as a fallback when no load event arrives.
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
                        scheduleListenTogetherGroupResync(
                            activeGroupRef.current?.id,
                        );
                    };

                    const tryReportReady = () => {
                        const state = audioStateRef.current;
                        const queuedTrackId =
                            state.queue[data.currentIndex]?.id ??
                            state.queue[state.currentIndex]?.id ??
                            null;
                        const activeTrackId = state.currentTrack?.id ?? null;
                        const expectedTrackId = data.trackId ?? null;
                        const serverQueuedTrackId =
                            activeGroupRef.current?.playback?.queue?.[
                                data.currentIndex
                            ]?.id ?? null;
                        const currentPlayback =
                            activeGroupRef.current?.playback;
                        const availabilityMatchesState =
                            trackAvailabilityStateVersionRef.current !== null &&
                            currentPlayback?.stateVersion ===
                                trackAvailabilityStateVersionRef.current &&
                            currentPlayback?.currentIndex === data.currentIndex;
                        const availabilityExpected = availabilityMatchesState
                            ? trackAvailabilityRef.current.get(
                                  data.currentIndex,
                              )
                            : undefined;
                        const expectedLocalTrackId =
                            availabilityExpected?.localTrackId ?? null;
                        const expectedCandidates = Array.from(
                            new Set(
                                [
                                    expectedTrackId,
                                    serverQueuedTrackId,
                                    expectedLocalTrackId,
                                ].filter(
                                    (candidate): candidate is string =>
                                        typeof candidate === "string" &&
                                        candidate.length > 0,
                                ),
                            ),
                        );
                        const localCandidates = Array.from(
                            new Set(
                                [activeTrackId, queuedTrackId].filter(
                                    (candidate): candidate is string =>
                                        typeof candidate === "string" &&
                                        candidate.length > 0,
                                ),
                            ),
                        );
                        const hasTrackMatch =
                            expectedCandidates.length === 0 ||
                            localCandidates.some((candidate) =>
                                expectedCandidates.includes(candidate),
                            );
                        const loadedTrackId = lastLoadedTrackIdRef.current;
                        const readinessTrackId =
                            localCandidates.find(
                                (candidate) =>
                                    expectedCandidates.length === 0 ||
                                    expectedCandidates.includes(candidate),
                            ) ?? null;
                        const hasLoadedExpectedTrack =
                            Boolean(readinessTrackId) &&
                            loadedTrackId === readinessTrackId;
                        const durationSec = playbackEngine.getDuration();
                        const currentTimeSec = playbackEngine.getCurrentTime();
                        const hasEngineMediaData =
                            (Number.isFinite(durationSec) && durationSec > 0) ||
                            (Number.isFinite(currentTimeSec) &&
                                currentTimeSec > 0);
                        const mediaReady =
                            hasLoadedExpectedTrack && hasEngineMediaData;
                        const timedOut =
                            Date.now() - startedAt >=
                            LT_READY_REPORT_MAX_WAIT_MS;

                        if (hasTrackMatch && (mediaReady || timedOut)) {
                            readyReportTimerRef.current = setTimeout(() => {
                                readyReportTimerRef.current = null;
                                clearReadyReportLoadListener();
                                listenTogetherSocket
                                    .reportReady()
                                    .catch((error) => {
                                        const elapsedMs =
                                            Date.now() - startedAt;
                                        const recoveryAction =
                                            resolveListenTogetherReadyReportRecoveryAction(
                                                {
                                                    elapsedMs,
                                                    maxWaitMs:
                                                        LT_READY_REPORT_MAX_WAIT_MS,
                                                    terminalRetryAttempted,
                                                },
                                            );
                                        if (recoveryAction === "retry") {
                                            readyReportTimerRef.current =
                                                setTimeout(
                                                    tryReportReady,
                                                    LT_READY_REPORT_RETRY_DELAY_MS,
                                                );
                                            return;
                                        }
                                        if (
                                            recoveryAction === "terminal-retry"
                                        ) {
                                            terminalRetryAttempted = true;
                                            readyReportTimerRef.current =
                                                setTimeout(
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
                            clearReadyReportLoadListener();
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

                    const onTargetTrackLoaded = () => {
                        clearReadyReportLoadListener();
                        if (readyReportTimerRef.current) {
                            clearTimeout(readyReportTimerRef.current);
                            readyReportTimerRef.current = null;
                        }
                        void listenTogetherSocket.reportReady().catch(() => {
                            readyReportTimerRef.current = setTimeout(
                                tryReportReady,
                                LT_READY_REPORT_RETRY_DELAY_MS,
                            );
                        });
                    };
                    readyReportTargetRef.current = {
                        currentIndex: data.currentIndex,
                        trackId: data.trackId,
                    };
                    readyReportLoadListenerRef.current = onTargetTrackLoaded;
                    playbackEngine.on("load", onTargetTrackLoaded);
                    tryReportReady();
                },
                onPlayAt: (data: PlayAtEvent) => {
                    // Synchronized start: the server says "play at positionMs at serverTime"
                    const state = audioStateRef.current;
                    const ctrl = controlsRef.current;

                    if (data.stateVersion <= lastAppliedVersionRef.current)
                        return;
                    lastAppliedVersionRef.current = data.stateVersion;

                    isApplyingRemoteRef.current = true;

                    setActiveGroup((prev) => {
                        if (!prev) return prev;
                        const next = {
                            ...prev,
                            syncState: "playing" as const,
                            playback: {
                                ...prev.playback,
                                isPlaying: true,
                                positionMs: data.positionMs,
                                serverTime: data.serverTime,
                                stateVersion: data.stateVersion,
                            },
                        };
                        activeGroupRef.current = next;
                        return next;
                    });

                    const group = activeGroupRef.current;
                    const isCurrentClientHost =
                        canCurrentUserControlHostPlayback(group);
                    pendingHostTrackIndexRef.current = null;

                    if (isCurrentClientHost) {
                        if (!playbackEngine.isPlaying()) {
                            ctrl.resume({
                                suppressListenTogetherBroadcast: true,
                            });
                        }
                        queueMicrotask(() => {
                            isApplyingRemoteRef.current = false;
                        });
                        return;
                    }

                    const targetMs = computeCompensatedTargetMs(
                        data.positionMs,
                        data.serverTime,
                        Date.now(),
                        getServerClockOffsetMs(),
                        5_000,
                    );
                    const targetSec = targetMs / 1000;
                    const track = state.queue[state.currentIndex];
                    const clampedSec = track?.duration
                        ? Math.min(targetSec, track.duration)
                        : targetSec;

                    ctrl.seek(Math.max(0, clampedSec), {
                        allowListenTogetherFollower: true,
                        suppressListenTogetherBroadcast: true,
                    });
                    resumeListenTogetherPlayback(ctrl.resume, data);

                    queueMicrotask(() => {
                        isApplyingRemoteRef.current = false;
                    });
                },
                onMemberJoined: (data) => {
                    if (isStaleGroupEvent(data, groupId)) return;
                    if (data.userId !== user?.id)
                        toast.info(`${data.username} joined`);
                    setActiveGroup((prev) => {
                        if (!prev) return prev;
                        const exists = prev.members.some(
                            (m) => m.userId === data.userId,
                        );
                        if (exists) return prev;
                        const next = {
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
                        activeGroupRef.current = next;
                        return next;
                    });
                },
                onMemberPresence: (data) => {
                    if (isStaleGroupEvent(data, groupId)) return;
                    setActiveGroup((prev) =>
                        applyGroupMemberPresence(prev, data),
                    );
                },
                onMemberLeft: (data) => {
                    if (isStaleGroupEvent(data, groupId)) return;
                    if (data.userId === user?.id) {
                        handleMembershipRevoked(data.groupId ?? groupId);
                        return;
                    }
                    toast.info(`${data.username} left`);
                    setActiveGroup((prev) => {
                        if (!prev) return prev;
                        const updated = {
                            ...prev,
                            members: prev.members.filter(
                                (m) => m.userId !== data.userId,
                            ),
                            hostUserId: data.newHostUserId ?? prev.hostUserId,
                        };
                        if (data.newHostUserId) {
                            updated.members = updated.members.map((m) => ({
                                ...m,
                                isHost: m.userId === data.newHostUserId,
                            }));
                            if (data.newHostUserId === user?.id) {
                                toast.success("You are now the host!");
                            }
                        }
                        activeGroupRef.current = updated;
                        return updated;
                    });
                },
                onMembershipRevoked: (data) => {
                    handleMembershipRevoked(data.groupId);
                },
                onGroupEnded: (_data) => {
                    clearActiveMembership();
                    toast.info("Listen Together session ended");
                },
                onConnect: () => {
                    if (disconnectGraceTimerRef.current) {
                        clearTimeout(disconnectGraceTimerRef.current);
                        disconnectGraceTimerRef.current = null;
                    }
                    setIsConnected(true);
                    hasEverConnectedRef.current = true;
                    setHasConnectedOnce(true);
                    setReconnectAttempt(0);
                    setSocketRouteStatus("ok");
                    setSocketRouteError(null);
                    awaitingInitialStateRef.current = true;
                },
                onReconnect: (_attempt) => {
                    if (disconnectGraceTimerRef.current) {
                        clearTimeout(disconnectGraceTimerRef.current);
                        disconnectGraceTimerRef.current = null;
                    }
                    setIsConnected(true);
                    setReconnectAttempt(0);
                    setSocketRouteStatus("ok");
                    setSocketRouteError(null);
                    pendingReconnectAudioRecoveryRef.current = true;
                },
                onReconnectAttempt: (attempt) => {
                    setReconnectAttempt(attempt);
                    pendingReconnectAudioRecoveryRef.current = true;
                    // Defer the visual disconnect so brief reconnects don't flash grey.
                    // Only schedule the grace timer once; later attempts just bump the counter.
                    if (!disconnectGraceTimerRef.current) {
                        disconnectGraceTimerRef.current = setTimeout(() => {
                            disconnectGraceTimerRef.current = null;
                            setIsConnected(false);
                            setSocketRouteStatus("checking");
                        }, 2000);
                    }
                },
                onReconnectError: (err) => {
                    sharedFrontendLogger.error(
                        "[ListenTogether] Reconnect error:",
                        err.message,
                    );
                },
                onReconnectFailed: () => {
                    // Reconnection exhausted — show disconnected immediately.
                    if (disconnectGraceTimerRef.current) {
                        clearTimeout(disconnectGraceTimerRef.current);
                        disconnectGraceTimerRef.current = null;
                    }
                    setIsConnected(false);
                    setError(
                        "Listen Together reconnect failed. Check route/proxy health and try rejoining.",
                    );
                    void validateSocketRoute(true);
                },
                onRejoinFailed: () => {
                    scheduleListenTogetherGroupResync(
                        activeGroupRef.current?.id,
                    );
                },
                onDisconnect: (_reason) => {
                    // Defer the visual disconnect; if Socket.IO reconnects within
                    // the grace window the indicator stays green.
                    if (!disconnectGraceTimerRef.current) {
                        disconnectGraceTimerRef.current = setTimeout(() => {
                            disconnectGraceTimerRef.current = null;
                            setIsConnected(false);
                        }, 2000);
                    }
                },
                onError: (err) => {
                    sharedFrontendLogger.error(
                        "[ListenTogether] Socket error:",
                        err.message,
                    );
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
        },
        [
            applyGroupState,
            applyPlaybackDelta,
            applyQueueDelta,
            canCurrentUserControlHostPlayback,
            clearAvailabilitySwapLoadListener,
            clearActiveMembership,
            clearReadyReportLoadListener,
            handleMembershipRevoked,
            recoverAudioAfterReconnect,
            scheduleRouteRecheck,
            user?.id,
            validateSocketRoute,
        ],
    );

    // -----------------------------------------------------------------------
    // Initial group fetch on mount
    // -----------------------------------------------------------------------

    useEffect(() => {
        if (!isAuthenticated) {
            setListenTogetherMembershipPending(false);
            queueMicrotask(() => {
                activeGroupRef.current = null;
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
                    setSocketRouteError(
                        formatListenTogetherSocketRouteError(probeResult),
                    );
                }

                const routeOk = probeResult.ok;
                const groupSnapshot = await api.getMyListenGroup();
                if (!mounted) return;

                if (!groupSnapshot || !groupSnapshot.id) {
                    activeGroupRef.current = null;
                    setActiveGroup(null);
                    lastAppliedVersionRef.current = 0;
                    setIsLoading(false);
                    return;
                }

                // Ensure snapshot has required structure before using it
                if (
                    !groupSnapshot.playback ||
                    !Array.isArray(groupSnapshot.members)
                ) {
                    sharedFrontendLogger.warn(
                        "[ListenTogether] Received malformed group snapshot, ignoring",
                    );
                    activeGroupRef.current = null;
                    setActiveGroup(null);
                    lastAppliedVersionRef.current = 0;
                    setIsLoading(false);
                    return;
                }

                // We have an active group — connect socket
                lastAppliedVersionRef.current =
                    groupSnapshot.playback?.stateVersion ?? 0;
                activeGroupRef.current = groupSnapshot;
                setActiveGroup(groupSnapshot);
                setIsLoading(false);
                if (routeOk) {
                    connectSocket(groupSnapshot.id);
                }
            } catch (err) {
                if (!mounted) return;
                sharedFrontendLogger.error(
                    "[ListenTogether] Failed to fetch active group:",
                    err,
                );
                setIsLoading(false);
            }
        })();

        return () => {
            mounted = false;
        };
    }, [isAuthenticated, connectSocket]);

    // Disconnect socket when group goes away
    useEffect(() => {
        if (!activeGroup && listenTogetherSocket.isConnected) {
            listenTogetherSocket.disconnect();
        }
    }, [activeGroup]);

    useEffect(() => {
        if (!activeGroup) {
            setTrackAvailability(new Map());
            trackAvailabilityStateVersionRef.current = null;
            setListenTogetherSessionSnapshot(null);
            return;
        }
        setListenTogetherSessionSnapshot({
            groupId: activeGroup.id,
            isHost: Boolean(isHost),
            playback: {
                isPlaying: Boolean(activeGroup.playback?.isPlaying),
                positionMs: Number(activeGroup.playback?.positionMs ?? 0),
                serverTime: Number(
                    activeGroup.playback?.serverTime ??
                        Date.now() - getServerClockOffsetMs(),
                ),
                currentIndex: Number(activeGroup.playback?.currentIndex ?? 0),
            },
        });
    }, [activeGroup, isHost]);

    // -----------------------------------------------------------------------
    // Push the authoritative host position while connected and not waiting.
    // Remote position is adopted only during initial session hydration.
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
            listenTogetherSocket
                .seek(positionMs, lastAppliedVersionRef.current)
                .catch(() => {});
        }, 5000); // Every 5 seconds

        return () => clearInterval(interval);
    }, [groupId, canControl, isConnected, syncState]);

    const applyOptimisticHostTrackSelection = useCallback(
        (index: number): boolean => {
            const state = audioStateRef.current;
            const queue = state.queue;
            if (!Array.isArray(queue) || queue.length === 0) return false;

            const safeIndex = Math.min(Math.max(index, 0), queue.length - 1);
            const targetTrack = queue[safeIndex] ?? null;
            // Listen Together queues are music-only; ignore episode entries.
            if (!targetTrack || isEpisodeQueueItem(targetTrack)) return false;
            pendingHostTrackIndexRef.current = safeIndex;
            clearObsoleteReadyReportLoadListener(safeIndex, targetTrack.id);
            const optimisticSelectionPolicy =
                getListenTogetherOptimisticTrackSelectionPolicy();
            if (optimisticSelectionPolicy.guardRemoteApply) {
                isApplyingRemoteRef.current = true;
            }

            // Pause current playback immediately to avoid stale audio while
            // the host navigation emit is still in-flight, then re-assert
            // playing so the load effect auto-plays the new track.
            controlsRef.current.pause({
                suppressListenTogetherBroadcast: true,
            });
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
            controlsRef.current.resume({
                suppressListenTogetherBroadcast: true,
            });
            if (optimisticSelectionPolicy.guardRemoteApply) {
                queueMicrotask(() => {
                    isApplyingRemoteRef.current = false;
                });
            }
            return true;
        },
        [clearObsoleteReadyReportLoadListener],
    );

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

    const createGroupAction = useCallback(
        async (options?: CreateGroupOptions): Promise<GroupSnapshot | null> => {
            setListenTogetherMembershipPending(
                resolveListenTogetherMembershipPendingState("create"),
            );
            try {
                setError(null);
                const routeOk = await validateSocketRoute();
                if (!routeOk) {
                    setError(
                        "Listen Together needs socket route forwarding. See docs/REVERSE_PROXY_AND_TUNNELS.md.",
                    );
                    toast.error(
                        "Listen Together socket route is not configured",
                    );
                    return null;
                }
                const shouldUseCurrentQueue =
                    options?.useCurrentQueue !== false;
                let queueTracks: QueueTrackInput[] = [];
                let currentTrackId: string | undefined;
                let currentTimeMs: number | undefined;
                let isPlaying: boolean | undefined;

                if (shouldUseCurrentQueue) {
                    const {
                        queueTracks: queueInputs,
                        currentTrackId: snapshotTrackId,
                    } = extractQueueTrackInputs(
                        audioState.queue,
                        audioState.currentTrack,
                    );
                    queueTracks = queueInputs;

                    const nowPlayingTrack = audioState.currentTrack;
                    const isTrackNowPlaying = Boolean(
                        audioState.playbackType === "track" &&
                        nowPlayingTrack?.id,
                    );

                    if (
                        isTrackNowPlaying &&
                        snapshotTrackId &&
                        queueTracks.length > 0
                    ) {
                        currentTrackId = snapshotTrackId;
                        currentTimeMs = Math.max(
                            0,
                            playbackEngine.getCurrentTime() * 1000,
                        );
                        isPlaying = playbackEngine.isPlaying();
                    }
                }

                const requestedQueueTrackCount = queueTracks.length;

                const group = await api.createListenGroup({
                    name: options?.name,
                    visibility: options?.visibility,
                    queueTracks,
                    currentTrackId,
                    currentTimeMs,
                    isPlaying,
                });

                if (requestedQueueTrackCount > 500) {
                    toast.info(
                        "Listen Together kept the first 500 tracks from the current queue",
                    );
                }

                lastAppliedVersionRef.current =
                    group.playback?.stateVersion ?? 0;
                activeGroupRef.current = group;
                setActiveGroup(group);

                // The creator has no server position to adopt.
                connectSocket(group.id, { adoptGroupPosition: false });

                toast.success("Group created!");
                return group;
            } catch (err) {
                const message =
                    err instanceof Error
                        ? err.message
                        : "Failed to create group";
                setError(message);
                toast.error(message);
                return null;
            } finally {
                setListenTogetherMembershipPending(
                    resolveListenTogetherMembershipPendingState(null),
                );
            }
        },
        [
            audioState.queue,
            audioState.currentTrack,
            audioState.playbackType,
            connectSocket,
            validateSocketRoute,
        ],
    );

    const joinGroupAction = useCallback(
        async (joinCode: string): Promise<GroupSnapshot | null> => {
            setListenTogetherMembershipPending(
                resolveListenTogetherMembershipPendingState("join"),
            );
            try {
                setError(null);
                const routeOk = await validateSocketRoute();
                if (!routeOk) {
                    setError(
                        "Listen Together needs socket route forwarding. See docs/REVERSE_PROXY_AND_TUNNELS.md.",
                    );
                    toast.error(
                        "Listen Together socket route is not configured",
                    );
                    return null;
                }
                const group = await api.joinListenGroup(joinCode);

                lastAppliedVersionRef.current =
                    group.playback?.stateVersion ?? 0;
                activeGroupRef.current = group;
                setActiveGroup(group);

                // Connect socket — applyGroupState will run on first group:state event
                connectSocket(group.id);

                toast.success("Joined group!");
                return group;
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : "Failed to join group";
                setError(message);
                toast.error(message);
                return null;
            } finally {
                setListenTogetherMembershipPending(
                    resolveListenTogetherMembershipPendingState(null),
                );
            }
        },
        [connectSocket, validateSocketRoute],
    );

    const leaveGroupAction = useCallback(async () => {
        const group = activeGroupRef.current;
        if (!group) return;

        setError(null);
        // Optimistic cleanup first so UI remains responsive even if backend is slow.
        clearActiveMembership();

        try {
            await api.leaveListenGroup(group.id);
            toast.success("Left Listen Together group");
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to leave group";
            setError(message);
            toast.error(`Leave request failed in background: ${message}`);
        }
    }, [clearActiveMembership]);

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
        writeOrigin("manual", audioStateRef.current.currentTrack?.id ?? null);
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
    const syncNext = useCallback(() => {
        const group = activeGroupRef.current;
        if (!canCurrentUserControlHostPlayback(group)) {
            return;
        }
        const nextIndex = resolveAdjacentHostTrackIndex("next");
        if (nextIndex === null) return;
        writeOrigin("manual", group?.playback.trackId ?? null);
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
        writeOrigin("manual", group?.playback.trackId ?? null);
        enqueueLatestListenTogetherHostTrackOperation({
            action: "previous",
        });
        applyOptimisticHostTrackSelection(prevIndex);
    }, [
        applyOptimisticHostTrackSelection,
        canCurrentUserControlHostPlayback,
        resolveAdjacentHostTrackIndex,
    ]);
    const syncSetTrack = useCallback(
        (index: number) => {
            const group = activeGroupRef.current;
            if (!canCurrentUserControlHostPlayback(group)) {
                return;
            }

            const state = audioStateRef.current;
            const queueLength = state.queue.length;
            if (queueLength === 0) return;

            const safeIndex = Math.min(Math.max(index, 0), queueLength - 1);
            if (safeIndex === state.currentIndex) return;
            writeOrigin("manual", group?.playback.trackId ?? null);
            enqueueLatestListenTogetherHostTrackOperation({
                action: "set-track",
                index: safeIndex,
            });
            applyOptimisticHostTrackSelection(safeIndex);
        },
        [applyOptimisticHostTrackSelection, canCurrentUserControlHostPlayback],
    );
    const syncAddToQueue = useCallback((tracks: QueueTrackInput[]) => {
        listenTogetherSocket.addToQueue(tracks).catch((err) => {
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

    const value = useMemo<ListenTogetherContextType>(
        () => ({
            activeGroup,
            trackAvailability,
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
        }),
        [
            activeGroup,
            trackAvailability,
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
        ],
    );

    return (
        <ListenTogetherContext.Provider value={value}>
            {children}
        </ListenTogetherContext.Provider>
    );
}

/**
 * Executes useListenTogether.
 */
export function useListenTogether(): ListenTogetherContextType {
    const context = useContext(ListenTogetherContext);
    if (!context) {
        throw new Error(
            "useListenTogether must be used within a ListenTogetherProvider",
        );
    }
    return context;
}
