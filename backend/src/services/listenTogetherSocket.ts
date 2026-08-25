/**
 * Socket.IO namespace for Listen Together.
 *
 * Handles all real-time communication: playback sync, queue mutations,
 * ready-gate protocol, and member presence.
 *
 * JWT authentication is verified on connection handshake.
 */

import type { Server as HttpServer } from "http";
import { Server, type Namespace, type Socket } from "socket.io";
import { verifyAccessToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config } from "../config";
import { isOriginAllowed } from "../utils/cors";
import { createIORedisClient } from "../utils/ioredis";
import {
    listenTogetherClusterSync,
    type ClusterGroupMembership,
    type ClusterPublicationMetadata,
} from "./listenTogetherClusterSync";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
import {
    subscribeSocialPresenceUpdates,
    type SocialPresenceUpdatedEvent,
} from "./socialPresenceEvents";
import { groupErrorMessage } from "./listenTogetherGroupError";
import {
    groupManager,
    GroupError,
    MAX_QUEUE_SIZE,
} from "./listenTogetherManager";
import type {
    GroupSnapshot,
    ManagerCallbacks,
    PlaybackDelta,
    QueueDelta,
    StatePublicationOptions,
} from "./listenTogetherTypes";
import {
    joinGroupByIdAdmitted,
    leaveGroup,
    leaveGroupAdmitted,
    validateQueueTracks,
    type QueueTrackInput,
} from "./listenTogether";
import { trackMappingService } from "./trackMappingService";
import {
    releaseLocalGroupMutationState,
    shutdownGroupMutationLock,
    withGroupMutationLock as withSharedGroupMutationLock,
} from "./listenTogetherMutationLock";
import {
    configureGroupPublicationBroadcaster,
    enqueueGroupEndedBroadcast,
    enqueueGroupEndedPublication,
    enqueueGroupMembershipPublication,
    enqueueGroupPresenceBroadcast,
    enqueueGroupSnapshotBroadcast,
    enqueueGroupSnapshotPublication,
    flushGroupPublications,
    resetGroupPublications,
} from "./listenTogetherCallbacks";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import { ReadyGateCompletionSupervisor } from "./listenTogetherInternalCompletion";
import {
    publishAvailabilityForGroup,
    resetAvailabilityPublications,
    shutdownAvailabilityPublications,
} from "./listenTogetherAvailabilityPublication";
import {
    resetListenTogetherMutationAdmission,
    stopListenTogetherMutationAdmission,
    withListenTogetherMutationAdmission,
    type ListenTogetherDrainResult,
} from "./listenTogetherMutationAdmission";
import { drainListenTogetherMutationBoundaries } from "./listenTogetherShutdownDrain";
import { revokeGroupSockets } from "./listenTogetherSocketRevocation";
import { createClusterSocketReconciliationHandlers } from "./listenTogetherSocketReconciliation";
import {
    createClusterSocketAuthorityHandlers,
    hydrateSocketMutationAuthority,
} from "./listenTogetherSocketMutationAuthority";
import { assertSocketMutationUserEligible } from "./listenTogetherSocketMutationEligibility";
import {
    applySocketPlaybackAction,
    type SocketPlaybackRequest,
} from "./listenTogetherSocketPlayback";

const log = logger.child("ListenTogetherSocket");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Token verification is delegated to the shared `verifyAccessToken` accessor
// in ../middleware/auth: one validated secret source, HS256 pinned, and
// refresh tokens rejected. Importing that module also fail-fasts at startup
// when neither JWT_SECRET nor SESSION_SECRET is configured.

interface AuthenticatedSocket extends Socket {
    data: {
        userId: string;
        username: string;
        groupId: string | null;
    };
}

type SocketAck = (res: unknown) => void;

interface SocketMutationOptions {
    signal?: AbortSignal;
    abandonOperationOnAbort?: boolean;
    flushPublications?: boolean;
    actingUserId?: string;
}

function resolveAck(arg1?: unknown, arg2?: unknown): SocketAck | undefined {
    if (typeof arg2 === "function") return arg2 as SocketAck;
    if (typeof arg1 === "function") return arg1 as SocketAck;
    return undefined;
}

function sendAck(ack: unknown, res: unknown): void {
    if (typeof ack === "function") {
        (ack as SocketAck)(res);
    }
}

type TransientConflictAckPayload = {
    error: string;
    code: "CONFLICT";
    transient: true;
    retryable: true;
    retryAfterMs: number;
};

type PermanentOperationErrorAckPayload = {
    error: string;
    code?: GroupError["code"];
};

// ---------------------------------------------------------------------------
// Socket.IO setup
// ---------------------------------------------------------------------------

let io: Server | null = null;
const LISTEN_TOGETHER_PING_INTERVAL_MS = 25_000;
const LISTEN_TOGETHER_PING_TIMEOUT_MS = 60_000;
const DISCONNECT_MEMBER_GRACE_MS = 60_000;
const LISTEN_TOGETHER_RECONNECT_SLO_MS = config.listenTogether.reconnectSloMs;
const LISTEN_TOGETHER_ALLOW_POLLING = config.listenTogether.allowPolling;
const LISTEN_TOGETHER_SOCKET_TRANSPORTS: Array<"websocket" | "polling"> =
    LISTEN_TOGETHER_ALLOW_POLLING ? ["websocket", "polling"] : ["websocket"];
const LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED =
    config.listenTogether.redisAdapterEnabled;
const LISTEN_TOGETHER_MUTATION_LOCK_ENABLED =
    config.listenTogether.mutationLockEnabled;
const LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS =
    config.listenTogether.mutationLockTtlMs;
const LISTEN_TOGETHER_MUTATION_LOCK_PREFIX =
    config.listenTogether.mutationLockPrefix;
const LISTEN_TOGETHER_CONFLICT_RETRY_AFTER_MS = Math.min(
    500,
    Math.max(75, Math.floor(LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS / 10)),
);
const LISTEN_TOGETHER_OBSERVABILITY_LOG_EVERY = 25;
const pendingDisconnectCleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
>();
const pendingReadyGateCompletions = new Map<string, Promise<void>>();
const readyGateCompletionSupervisor = new ReadyGateCompletionSupervisor();
const recentDisconnectAtMs = new Map<string, number>();
const listenTogetherObservabilityCounters = {
    reconnectSamples: 0,
    reconnectBreaches: 0,
    conflictErrors: 0,
    mutationLockAcquireFailures: 0,
    disconnectCleanupScheduled: 0,
    disconnectCleanupExecuted: 0,
};
let redisAdapterPubClient: any = null;
let redisAdapterSubClient: any = null;
let unsubscribeSocialPresenceUpdates: (() => void) | null = null;
let listenTogetherNamespace: Namespace | null = null;
let clusterStopStarted = false;

function stopClusterStateSync(): void {
    if (clusterStopStarted) return;
    clusterStopStarted = true;
    void listenTogetherClusterSync.stop();
}

function logListenTogetherObservability(reason: string): void {
    logger.info(
        `[ListenTogether/Observability] reason=${reason} reconnectSamples=${listenTogetherObservabilityCounters.reconnectSamples} reconnectBreaches=${listenTogetherObservabilityCounters.reconnectBreaches} conflictErrors=${listenTogetherObservabilityCounters.conflictErrors} mutationLockAcquireFailures=${listenTogetherObservabilityCounters.mutationLockAcquireFailures} disconnectCleanupScheduled=${listenTogetherObservabilityCounters.disconnectCleanupScheduled} disconnectCleanupExecuted=${listenTogetherObservabilityCounters.disconnectCleanupExecuted}`,
    );
}

function maybeLogListenTogetherObservability(reason: string): void {
    const totalEvents =
        listenTogetherObservabilityCounters.reconnectSamples +
        listenTogetherObservabilityCounters.conflictErrors +
        listenTogetherObservabilityCounters.mutationLockAcquireFailures;

    if (
        totalEvents > 0 &&
        totalEvents % LISTEN_TOGETHER_OBSERVABILITY_LOG_EVERY === 0
    ) {
        logListenTogetherObservability(reason);
    }
}

function recordGroupConflict(
    groupId: string | null,
    userId: string,
    operation: string,
    message: string,
): void {
    listenTogetherObservabilityCounters.conflictErrors += 1;
    logger.warn(
        `[ListenTogether/Conflict] operation=${operation} groupId=${groupId ?? "none"} userId=${userId} message=${message}`,
    );
    maybeLogListenTogetherObservability("conflict");
}

function buildTransientConflictAck(
    message: string,
): TransientConflictAckPayload {
    return {
        error: message,
        code: "CONFLICT",
        transient: true,
        retryable: true,
        retryAfterMs: LISTEN_TOGETHER_CONFLICT_RETRY_AFTER_MS,
    };
}

function buildOperationErrorAck(
    error: unknown,
    fallbackMessage: string,
): PermanentOperationErrorAckPayload | TransientConflictAckPayload {
    const message = groupErrorMessage(error, fallbackMessage);
    if (
        error instanceof GroupError &&
        (error.code === "CONFLICT" || error.code === "UNAVAILABLE") &&
        error.retryable
    ) {
        return buildTransientConflictAck(message);
    }
    return error instanceof GroupError
        ? { error: message, code: error.code }
        : { error: message };
}

function queuePersistAndPublishSnapshot(
    groupId: string,
    snapshot?: GroupSnapshot,
    fence?: GroupMutationFence,
    emitPayload?: () => void | Promise<void>,
): Promise<void> {
    const resolvedSnapshot = snapshot ?? groupManager.snapshotById(groupId);
    if (!resolvedSnapshot) {
        return Promise.resolve();
    }

    return enqueueGroupSnapshotPublication(
        groupId,
        resolvedSnapshot,
        undefined,
        undefined,
        [],
        fence,
        emitPayload,
    );
}

async function withGroupMutationLock<T>(
    groupId: string,
    operationName: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    options: SocketMutationOptions = {},
): Promise<T> {
    return withListenTogetherMutationAdmission(operationName, () =>
        runSocketGroupMutation(groupId, operationName, operation, options),
    );
}

async function runSocketGroupMutation<T>(
    groupId: string,
    operationName: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    options: SocketMutationOptions = {},
): Promise<T> {
    const { signal, abandonOperationOnAbort, actingUserId } = options;
    const flushPublications = options.flushPublications ?? true;
    let enteredMutationBoundary = false;
    try {
        return await withSharedGroupMutationLock(
            groupId,
            operationName,
            operation,
            {
                beforeOperation: async () => {
                    signal?.throwIfAborted();
                    enteredMutationBoundary = true;
                    await assertSocketMutationUserEligible(
                        listenTogetherNamespace,
                        groupId,
                        actingUserId,
                        clearRevokedSocketState,
                    );
                    await hydrateSocketMutationAuthority(
                        groupId,
                        listenTogetherNamespace,
                        clearRevokedSocketState,
                    );
                    signal?.throwIfAborted();
                },
                afterOperation: async () => {
                    signal?.throwIfAborted();
                    if (!flushPublications) return;
                    await flushGroupPublications(groupId);
                    groupManager.markPublicationConfirmed(groupId);
                },
                onAcquireFailure: () => {
                    listenTogetherObservabilityCounters.mutationLockAcquireFailures += 1;
                    maybeLogListenTogetherObservability(
                        "mutation-lock-acquire-failure",
                    );
                },
                signal,
                abandonOperationOnAbort,
            },
        );
    } catch (error) {
        if (error instanceof GroupError && error.code !== "CONFLICT") {
            throw error;
        }
        if (!enteredMutationBoundary && error instanceof GroupError) {
            throw error;
        }
        groupManager.invalidate(groupId);
        if (error instanceof GroupError) throw error;
        throw new GroupError(
            "CONFLICT",
            "Group state could not be synchronized. Please retry.",
        );
    }
}

function scheduleReadyGateCompletion(
    groupId: string,
    data: { currentIndex: number; stateVersion: number },
): void {
    const completionId = `${groupId}:${data.currentIndex}:${data.stateVersion}`;
    if (pendingReadyGateCompletions.has(completionId)) return;
    let tracked: Promise<void>;
    tracked = readyGateCompletionSupervisor
        .run(
            groupId,
            data,
            (signal) =>
                withGroupMutationLock(
                    groupId,
                    "ready-gate-completion",
                    async (fence) => {
                        signal.throwIfAborted();
                        return groupManager.handleReadyGateCompletion(
                            groupId,
                            data.currentIndex,
                            data.stateVersion,
                            fence,
                        );
                    },
                    { signal, abandonOperationOnAbort: true },
                ),
            (delayMs) => {
                groupManager.rearmReadyGateCompletion(
                    groupId,
                    data.currentIndex,
                    data.stateVersion,
                    delayMs,
                );
            },
        )
        .then(() => undefined)
        .catch((error) => {
            log.error("Ready gate completion failed", { groupId, error });
        })
        .finally(() => {
            if (pendingReadyGateCompletions.get(completionId) === tracked) {
                pendingReadyGateCompletions.delete(completionId);
            }
        });
    pendingReadyGateCompletions.set(completionId, tracked);
}

function disconnectCleanupKey(groupId: string, userId: string): string {
    return `${groupId}:${userId}`;
}

function clearDisconnectCleanup(groupId: string, userId: string): void {
    const key = disconnectCleanupKey(groupId, userId);
    const timer = pendingDisconnectCleanupTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    pendingDisconnectCleanupTimers.delete(key);
}

function recordReconnectSlo(
    groupId: string,
    userId: string,
    username: string,
): void {
    const key = disconnectCleanupKey(groupId, userId);
    const disconnectedAtMs = recentDisconnectAtMs.get(key);
    if (!disconnectedAtMs) {
        return;
    }

    recentDisconnectAtMs.delete(key);
    const reconnectMs = Math.max(0, Date.now() - disconnectedAtMs);
    listenTogetherObservabilityCounters.reconnectSamples += 1;

    logger.info(
        `[ListenTogether/SLO] Reconnect latency ${reconnectMs}ms for ${username} (${groupId})`,
    );

    if (reconnectMs > LISTEN_TOGETHER_RECONNECT_SLO_MS) {
        listenTogetherObservabilityCounters.reconnectBreaches += 1;
        logger.warn(
            `[ListenTogether/SLO] Reconnect latency ${reconnectMs}ms exceeded target ${LISTEN_TOGETHER_RECONNECT_SLO_MS}ms for ${username} (${groupId})`,
        );
        logListenTogetherObservability("reconnect-slo-breach");
        return;
    }

    maybeLogListenTogetherObservability("reconnect-sample");
}

function scheduleDisconnectCleanup(
    groupId: string,
    userId: string,
    username: string,
): void {
    const key = disconnectCleanupKey(groupId, userId);
    if (pendingDisconnectCleanupTimers.has(key)) {
        return;
    }
    listenTogetherObservabilityCounters.disconnectCleanupScheduled += 1;
    maybeLogListenTogetherObservability("disconnect-cleanup-scheduled");

    const timer = setTimeout(async () => {
        pendingDisconnectCleanupTimers.delete(key);

        if (groupManager.socketCount(groupId, userId) > 0) {
            recentDisconnectAtMs.delete(key);
            return;
        }

        try {
            listenTogetherObservabilityCounters.disconnectCleanupExecuted += 1;
            await leaveGroup(userId, groupId);
            recentDisconnectAtMs.delete(key);
            logger.debug(
                `[ListenTogether/WS] Removed stale disconnected member ${username} (${groupId}) after ${DISCONNECT_MEMBER_GRACE_MS}ms`,
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/WS] Failed stale-member cleanup for ${username} (${groupId}):`,
                err,
            );
        }
    }, DISCONNECT_MEMBER_GRACE_MS);

    if (typeof timer.unref === "function") {
        timer.unref();
    }

    recentDisconnectAtMs.set(key, Date.now());
    pendingDisconnectCleanupTimers.set(key, timer);
}

function clearRevokedSocketState(groupId: string, userId: string): void {
    clearDisconnectCleanup(groupId, userId);
    recentDisconnectAtMs.delete(disconnectCleanupKey(groupId, userId));
}

function isJoinedGroupCurrent(
    groupId: string,
    snapshot: GroupSnapshot,
    userId: string,
): boolean {
    const current = groupManager.get(groupId);
    if (!current || current.id !== groupId) return false;
    return (
        groupManager.hasMember(groupId, userId) &&
        (typeof snapshot.joinCode !== "string" ||
            snapshot.joinCode === current.joinCode)
    );
}

async function attachJoinedSocket(
    socket: AuthenticatedSocket,
    groupId: string,
    snapshot: GroupSnapshot,
): Promise<GroupSnapshot> {
    return runSocketGroupMutation(
        groupId,
        "join-group-attachment",
        async () => attachSocketInsideBoundary(socket, groupId, snapshot),
        { actingUserId: socket.data.userId },
    );
}

function joinedGroupError(groupId: string): GroupError {
    return groupManager.has(groupId)
        ? new GroupError("NOT_MEMBER", "Not a member of this group")
        : new GroupError("NOT_FOUND", "Group not found");
}

async function attachSocketInsideBoundary(
    socket: AuthenticatedSocket,
    groupId: string,
    snapshot: GroupSnapshot,
): Promise<GroupSnapshot> {
    if (!isJoinedGroupCurrent(groupId, snapshot, socket.data.userId)) {
        throw joinedGroupError(groupId);
    }
    await socket.join(groupId);
    if (!isJoinedGroupCurrent(groupId, snapshot, socket.data.userId)) {
        await socket.leave(groupId);
        socket.data.groupId = null;
        throw joinedGroupError(groupId);
    }
    if (!groupManager.addSocket(groupId, socket.data.userId, socket.id)) {
        await socket.leave(groupId);
        socket.data.groupId = null;
        throw new GroupError("NOT_MEMBER", "Not a member of this group");
    }
    socket.data.groupId = groupId;
    const current = groupManager.get(groupId);
    if (!current) throw new GroupError("NOT_FOUND", "Group not found");
    return groupManager.snapshot(current);
}

function publishManagerState(
    groupId: string,
    snapshot: GroupSnapshot,
    options: StatePublicationOptions | undefined,
    fence: GroupMutationFence | undefined,
): void {
    if (options?.synchronize === false) {
        void enqueueGroupSnapshotBroadcast(groupId, snapshot);
        return;
    }
    void enqueueGroupSnapshotPublication(
        groupId,
        snapshot,
        undefined,
        undefined,
        [],
        fence,
    );
}

function publishManagerDelta(
    ns: Namespace,
    event: string,
    groupId: string,
    payload: unknown,
    fence: GroupMutationFence | undefined,
): void {
    void queuePersistAndPublishSnapshot(groupId, undefined, fence, () => {
        ns.to(groupId).emit(event, payload);
    });
}

function publishManagerEnd(
    groupId: string,
    reason: string,
    options?: StatePublicationOptions,
): void {
    if (options?.synchronize === false) {
        void enqueueGroupEndedBroadcast(groupId, reason);
        return;
    }
    void enqueueGroupEndedPublication(groupId, reason);
}

function runBoundaryWatchdog(
    groupId: string,
    data: { currentIndex: number; stateVersion: number },
): void {
    void withGroupMutationLock(groupId, "boundary-watchdog", async (fence) => {
        groupManager.handleBoundaryWatchdog(
            groupId,
            data.currentIndex,
            data.stateVersion,
            fence,
        );
    }).catch((error) => {
        log.error(`Boundary watchdog failed for group ${groupId}`, error);
    });
}

function createManagerCallbacks(ns: Namespace): ManagerCallbacks {
    return {
        onGroupState: publishManagerState,
        onPlaybackDelta: (groupId, delta, fence) =>
            publishManagerDelta(
                ns,
                "group:playback-delta",
                groupId,
                delta,
                fence,
            ),
        onQueueDelta: (groupId, delta, fence) =>
            publishManagerDelta(ns, "group:queue-delta", groupId, delta, fence),
        onWaiting: (groupId, data, fence) =>
            publishManagerDelta(ns, "group:waiting", groupId, data, fence),
        onPlayAt: (groupId, data, fence) =>
            publishManagerDelta(ns, "group:play-at", groupId, data, fence),
        onMemberJoined: (groupId, member) => {
            void enqueueGroupMembershipPublication(groupId, {
                type: "joined",
                member,
            });
        },
        onMemberPresence: (groupId, member) => {
            void enqueueGroupPresenceBroadcast(groupId, member, {
                membershipVersion:
                    groupManager.get(groupId)?.membershipVersion ?? 0,
            });
        },
        onMemberLeft: (groupId, member) => {
            void enqueueGroupMembershipPublication(groupId, {
                type: "left",
                member,
            });
        },
        onGroupEnded: publishManagerEnd,
        onBoundaryWatchdog: runBoundaryWatchdog,
        onReadyGateCompletion: scheduleReadyGateCompletion,
    };
}
function configureSocketBroadcaster(ns: Namespace): void {
    // Publication revalidates immediately before these synchronous emits.
    // Lease loss between that check and emit is bounded; #661 resync repairs
    // any stale membership view by loading the authoritative snapshot.
    configureGroupPublicationBroadcaster({
        emitSnapshot(groupId, snapshot) {
            ns.to(groupId).emit("group:state", snapshot);
            void publishAvailabilityForGroup(
                ns,
                groupId,
                withGroupMutationLock,
                snapshot,
            ).catch((error) => {
                log.warn("Availability publication failed", { groupId, error });
            });
        },
        emitEnded: (groupId, reason) => {
            ns.to(groupId).emit("group:ended", { reason });
        },
        emitMemberJoined: (groupId, member, metadata) => {
            ns.to(groupId).emit("group:member-joined", {
                ...member,
                groupId,
                ...metadata,
            });
        },
        emitMemberPresence: (groupId, member, metadata) => {
            ns.to(groupId).emit("group:member-presence", {
                ...member,
                groupId,
                ...metadata,
            });
        },
        emitMemberLeft: (groupId, member, metadata) => {
            ns.to(groupId).emit("group:member-left", {
                ...member,
                groupId,
                ...metadata,
            });
        },
        revokeSockets: (groupId, socketIds, metadata, userId) =>
            revokeGroupSockets(
                ns,
                groupId,
                socketIds,
                metadata,
                userId,
                clearRevokedSocketState,
            ),
    });
}

function createListenTogetherServer(httpServer: HttpServer): Server {
    return new Server(httpServer, {
        path: "/socket.io/listen-together",
        cors: {
            // Match the Express allowlist. Same-origin proxy traffic has no
            // browser CORS check; JWT auth still protects WebSocket handshakes.
            origin: (origin, callback) =>
                callback(
                    null,
                    isOriginAllowed(
                        origin,
                        config.allowedOrigins,
                        config.nodeEnv,
                    ),
                ),
            credentials: true,
        },
        transports: LISTEN_TOGETHER_SOCKET_TRANSPORTS,
        pingInterval: LISTEN_TOGETHER_PING_INTERVAL_MS,
        pingTimeout: LISTEN_TOGETHER_PING_TIMEOUT_MS,
        maxHttpBufferSize: 1e6,
    });
}

function configureSocialPresence(ns: Namespace): void {
    if (unsubscribeSocialPresenceUpdates) return;
    unsubscribeSocialPresenceUpdates = subscribeSocialPresenceUpdates(
        (event: SocialPresenceUpdatedEvent) => {
            ns.emit("social:presence-updated", event);
        },
    );
}

function configureRedisSocketAdapter(server: Server): void {
    if (!LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED) {
        logger.info(
            "[ListenTogether/WS] Redis adapter disabled via LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED=false",
        );
        return;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createAdapter } = require("@socket.io/redis-adapter") as {
            createAdapter(pubClient: unknown, subClient: unknown): unknown;
        };
        redisAdapterPubClient = createIORedisClient(
            "listen-together-socket-adapter-pub",
        );
        redisAdapterSubClient = redisAdapterPubClient.duplicate();
        (server as any).adapter(
            createAdapter(redisAdapterPubClient, redisAdapterSubClient),
        );
        logger.info(
            "[ListenTogether/WS] Redis adapter enabled for cross-pod Socket.IO fanout",
        );
        if (!listenTogetherStateStore.isEnabled()) {
            logger.warn(
                "[ListenTogether/WS] Cross-pod fanout is enabled, but authoritative session snapshots are disabled (LISTEN_TOGETHER_STATE_STORE_ENABLED=false); GroupManager state remains pod-local in-memory between mutations.",
            );
        } else {
            logger.info(
                "[ListenTogether/WS] Cross-pod authoritative session snapshots are enabled via Redis state store",
            );
        }
    } catch (error) {
        logger.error(
            "[ListenTogether/WS] Failed to initialize Redis adapter; continuing in single-pod fanout mode",
            error,
        );
    }
}

function applyClusterMembership(
    ns: Namespace,
    groupId: string,
    membership: ClusterGroupMembership,
    metadata: ClusterPublicationMetadata,
): () => Promise<void> {
    return async () => {
        if (!groupManager.has(groupId)) return;
        const revokedSocketIds = groupManager.applyCommittedMembership(
            groupId,
            membership.members,
            membership.hostUserId,
            metadata.fencingToken,
        );
        await revokeGroupSockets(
            ns,
            groupId,
            revokedSocketIds,
            {
                membershipVersion: metadata.fencingToken,
            },
            undefined,
            clearRevokedSocketState,
        );
    };
}

function configureClusterStateSync(ns: Namespace): void {
    const authorityHandlers = createClusterSocketAuthorityHandlers(
        ns,
        clearRevokedSocketState,
    );
    const handlers = createClusterSocketReconciliationHandlers(
        ns,
        authorityHandlers.recoveryHandler,
        clearRevokedSocketState,
        (groupId, userId) => groupManager.evictLocalMember(groupId, userId),
    );
    if (!listenTogetherClusterSync.isEnabled()) {
        logger.info(
            "[ListenTogether/StateSync] Disabled; local socket eviction remains authoritative and cluster publication is a no-op",
        );
    }
    void listenTogetherClusterSync
        .start(
            (snapshot) => () => groupManager.applyExternalSnapshot(snapshot),
            authorityHandlers.endedHandler,
            (groupId, membership, metadata) =>
                applyClusterMembership(ns, groupId, membership, metadata),
            authorityHandlers.recoveryHandler,
            handlers.userRevocationHandler,
            handlers.reconciliationHandler,
        )
        .catch((error) => {
            logger.error(
                "[ListenTogether/StateSync] Failed to start cluster sync; proceeding with pod-local state",
                error,
            );
        });
}

function configureSocketAuthentication(ns: Namespace): void {
    ns.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token as string | undefined;
            if (!token) return next(new Error("Authentication required"));
            const decoded = verifyAccessToken(token);
            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: {
                    id: true,
                    username: true,
                    role: true,
                    tokenVersion: true,
                    pendingDeletionAt: true,
                },
            });
            if (!user) return next(new Error("User not found"));
            if (user.pendingDeletionAt) {
                return next(new Error("User deletion is pending"));
            }
            if (
                decoded.tokenVersion !== undefined &&
                decoded.tokenVersion !== user.tokenVersion
            ) {
                return next(new Error("Token expired"));
            }
            socket.data = {
                userId: user.id,
                username: user.username,
                groupId: null,
            };
            next();
        } catch {
            next(new Error("Invalid token"));
        }
    });
}

function logSocketCoordinationMode(): void {
    logger.info(
        LISTEN_TOGETHER_MUTATION_LOCK_ENABLED
            ? `[ListenTogether/MutationLock] Enabled (ttlMs=${LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS}, prefix=${LISTEN_TOGETHER_MUTATION_LOCK_PREFIX})`
            : "[ListenTogether/MutationLock] Disabled via LISTEN_TOGETHER_MUTATION_LOCK_ENABLED=false",
    );
    logger.info(
        listenTogetherStateStore.isEnabled()
            ? "[ListenTogether/StateStore] Enabled"
            : "[ListenTogether/StateStore] Disabled via LISTEN_TOGETHER_STATE_STORE_ENABLED=false",
    );
    logger.info(
        `[ListenTogether/SLO] Reconnect target set to ${LISTEN_TOGETHER_RECONNECT_SLO_MS}ms`,
    );
    logger.info(
        `[ListenTogether/WS] Transport policy: ${
            LISTEN_TOGETHER_ALLOW_POLLING
                ? "websocket + polling fallback"
                : "websocket-only"
        }`,
    );
}

/**
 * Executes setupListenTogetherSocket.
 */
export function setupListenTogetherSocket(httpServer: HttpServer): Server {
    resetListenTogetherMutationAdmission();
    clusterStopStarted = false;
    readyGateCompletionSupervisor.reset();
    resetAvailabilityPublications();
    io = createListenTogetherServer(httpServer);
    const ns = io.of("/listen-together");
    listenTogetherNamespace = ns;
    configureSocialPresence(ns);
    configureRedisSocketAdapter(io);
    configureClusterStateSync(ns);
    logSocketCoordinationMode();
    configureSocketAuthentication(ns);
    configureSocketBroadcaster(ns);
    groupManager.setCallbacks(createManagerCallbacks(ns));
    registerConnectionHandler(ns);
    return io;
}

type QueueRequest = {
    action: string;
    trackIds?: string[];
    tracks?: QueueTrackInput[];
    index?: number;
    fromIndex?: number;
    toIndex?: number;
};

async function joinSocketToGroup(
    ns: Namespace,
    socket: AuthenticatedSocket,
    groupId: string,
): Promise<void> {
    const { userId, username } = socket.data;
    if (socket.data.groupId && socket.data.groupId !== groupId) {
        await handleLeaveRoomAdmitted(socket);
    }
    const snapshot = await joinGroupByIdAdmitted(userId, username, groupId);
    recordReconnectSlo(groupId, userId, username);
    clearDisconnectCleanup(groupId, userId);
    const authoritativeSnapshot = await attachJoinedSocket(
        socket,
        groupId,
        snapshot,
    );
    socket.emit("group:state", authoritativeSnapshot);
    void publishAvailabilityForGroup(
        ns,
        groupId,
        withGroupMutationLock,
        authoritativeSnapshot,
    ).catch((error) => {
        log.warn("Join availability publication failed", { groupId, error });
    });
}

function registerJoinHandler(ns: Namespace, socket: AuthenticatedSocket): void {
    socket.on(
        "join-group",
        async (data: { groupId: string }, ack?: SocketAck) => {
            const { userId, username } = socket.data;
            try {
                if (!data.groupId || typeof data.groupId !== "string") {
                    sendAck(ack, { error: "groupId is required" });
                    return;
                }
                await withListenTogetherMutationAdmission("join-group", () =>
                    joinSocketToGroup(ns, socket, data.groupId),
                );
                sendAck(ack, { ok: true });
                logger.debug(
                    `[ListenTogether/WS] ${username} joined room ${data.groupId}`,
                );
            } catch (error) {
                const message = groupErrorMessage(
                    error,
                    "Failed to join group",
                );
                if (error instanceof GroupError && error.retryable) {
                    recordGroupConflict(
                        typeof data?.groupId === "string" ? data.groupId : null,
                        userId,
                        "join-group",
                        message,
                    );
                }
                sendAck(ack, buildOperationErrorAck(error, message));
                logger.error("[ListenTogether/WS] join-group error:", error);
            }
        },
    );
}

function registerPlaybackHandler(socket: AuthenticatedSocket): void {
    socket.on(
        "playback",
        async (data: SocketPlaybackRequest, ack?: SocketAck) => {
            const { groupId, userId } = socket.data;
            if (!groupId) return sendAck(ack, { error: "Not in a group" });
            try {
                const operationName = `playback:${data.action}`;
                await withListenTogetherMutationAdmission(operationName, () =>
                    runSocketGroupMutation(
                        groupId,
                        operationName,
                        async (fence) =>
                            applySocketPlaybackAction(
                                groupId,
                                userId,
                                data,
                                fence,
                            ),
                        { actingUserId: userId },
                    ),
                );
                sendAck(ack, { ok: true });
            } catch (error) {
                const message = groupErrorMessage(error, "Playback error");
                if (error instanceof GroupError && error.retryable) {
                    recordGroupConflict(
                        groupId,
                        userId,
                        `playback:${data.action}`,
                        message,
                    );
                }
                sendAck(ack, buildOperationErrorAck(error, message));
            }
        },
    );
}

function queueTrackInputs(data: QueueRequest): QueueTrackInput[] {
    if (Array.isArray(data.tracks) && data.tracks.length > 0)
        return data.tracks;
    if (Array.isArray(data.trackIds)) {
        return data.trackIds.map((trackId) => ({ trackId }));
    }
    return [];
}

async function insertQueueTracks(
    groupId: string,
    userId: string,
    action: "add" | "insert-next",
    requestedInputs: QueueTrackInput[],
): Promise<Record<string, unknown>> {
    if (requestedInputs.length === 0) return { error: "trackIds required" };
    const queueLength =
        groupManager.snapshotById(groupId)?.playback.queue.length ?? 0;
    const allowedInputs = requestedInputs.slice(
        0,
        Math.max(0, MAX_QUEUE_SIZE - queueLength),
    );
    if (allowedInputs.length === 0) {
        return {
            ok: true,
            acceptedCount: 0,
            skippedCount: requestedInputs.length,
            truncated: true,
        };
    }
    const items = await validateQueueTracks(allowedInputs);
    if (items.length === 0) return { error: "No valid tracks found" };
    let acceptedCount = 0;
    await runSocketGroupMutation(
        groupId,
        `queue:${action}`,
        async (fence) => {
            const before =
                groupManager.snapshotById(groupId)?.playback.queue.length ?? 0;
            const delta = groupManager.modifyQueue(
                groupId,
                userId,
                { action, items },
                fence,
            );
            acceptedCount = Math.max(0, delta.queue.length - before);
        },
        { actingUserId: userId },
    );
    return {
        ok: true,
        acceptedCount,
        skippedCount: Math.max(0, requestedInputs.length - acceptedCount),
        truncated:
            allowedInputs.length < requestedInputs.length ||
            acceptedCount < items.length,
    };
}

async function runQueueIndexAction(
    groupId: string,
    userId: string,
    data: QueueRequest,
): Promise<Record<string, unknown>> {
    if (data.action === "remove") {
        if (typeof data.index !== "number") return { error: "index required" };
        await runSocketGroupMutation(
            groupId,
            "queue:remove",
            async (fence) => {
                groupManager.modifyQueue(
                    groupId,
                    userId,
                    { action: "remove", index: data.index as number },
                    fence,
                );
            },
            { actingUserId: userId },
        );
        return { ok: true };
    }
    if (data.action === "reorder") {
        if (
            typeof data.fromIndex !== "number" ||
            typeof data.toIndex !== "number"
        ) {
            return { error: "fromIndex and toIndex required" };
        }
        await runSocketGroupMutation(
            groupId,
            "queue:reorder",
            async (fence) => {
                groupManager.modifyQueue(
                    groupId,
                    userId,
                    {
                        action: "reorder",
                        fromIndex: data.fromIndex as number,
                        toIndex: data.toIndex as number,
                    },
                    fence,
                );
            },
            { actingUserId: userId },
        );
        return { ok: true };
    }
    if (data.action === "clear") {
        await runSocketGroupMutation(
            groupId,
            "queue:clear",
            async (fence) => {
                groupManager.modifyQueue(
                    groupId,
                    userId,
                    { action: "clear" },
                    fence,
                );
            },
            { actingUserId: userId },
        );
        return { ok: true };
    }
    return { error: `Unknown action: ${data.action}` };
}

function runQueueAction(
    groupId: string,
    userId: string,
    data: QueueRequest,
): Promise<Record<string, unknown>> {
    if (data.action === "add" || data.action === "insert-next") {
        return insertQueueTracks(
            groupId,
            userId,
            data.action,
            queueTrackInputs(data),
        );
    }
    return runQueueIndexAction(groupId, userId, data);
}

function registerQueueHandler(socket: AuthenticatedSocket): void {
    socket.on("queue", async (data: QueueRequest, ack?: SocketAck) => {
        const { groupId, userId } = socket.data;
        if (!groupId) return sendAck(ack, { error: "Not in a group" });
        try {
            const result = await withListenTogetherMutationAdmission(
                `queue:${data.action}`,
                () => runQueueAction(groupId, userId, data),
            );
            sendAck(ack, result);
        } catch (error) {
            const message = groupErrorMessage(error, "Queue error");
            if (error instanceof GroupError && error.retryable) {
                recordGroupConflict(
                    groupId,
                    userId,
                    `queue:${data.action}`,
                    message,
                );
            }
            sendAck(ack, buildOperationErrorAck(error, message));
        }
    });
}

async function reportSocketReady(socket: AuthenticatedSocket): Promise<void> {
    const { groupId, userId } = socket.data;
    if (!groupId) throw new GroupError("NOT_FOUND", "Not in a group");
    await runSocketGroupMutation(
        groupId,
        "ready",
        async (fence) => {
            const wasWaiting =
                groupManager.snapshotById(groupId)?.syncState === "waiting";
            groupManager.reportReady(groupId, userId);
            if (wasWaiting) {
                void queuePersistAndPublishSnapshot(groupId, undefined, fence);
            }
        },
        { actingUserId: userId },
    );
}

function registerReadyHandler(socket: AuthenticatedSocket): void {
    socket.on("ready", async (payloadOrAck?: unknown, maybeAck?: unknown) => {
        const ack = resolveAck(payloadOrAck, maybeAck);
        try {
            await withListenTogetherMutationAdmission("ready", () =>
                reportSocketReady(socket),
            );
            sendAck(ack, { ok: true });
        } catch (error) {
            if (error instanceof GroupError && error.retryable) {
                recordGroupConflict(
                    socket.data.groupId,
                    socket.data.userId,
                    "ready",
                    error.message,
                );
            }
            sendAck(ack, buildOperationErrorAck(error, "Ready report failed"));
        }
    });
}

async function processPlaybackFailure(
    ns: Namespace,
    socket: AuthenticatedSocket,
    queueIndex: number,
): Promise<void> {
    const groupId = socket.data.groupId;
    if (!groupId) throw new GroupError("NOT_FOUND", "Not in a group");
    await runSocketGroupMutation(
        groupId,
        "track:playback-failed",
        async () => {
            const failedItem =
                groupManager.snapshotById(groupId)?.playback.queue[queueIndex];
            if (failedItem?.trackMappingId) {
                await trackMappingService.markStale(failedItem.trackMappingId);
            }
        },
        { actingUserId: socket.data.userId },
    );
    await publishAvailabilityForGroup(ns, groupId, runSocketGroupMutation);
}

function registerPlaybackFailureHandler(
    ns: Namespace,
    socket: AuthenticatedSocket,
): void {
    socket.on(
        "track:playback-failed",
        async (payloadOrAck?: unknown, maybeAck?: unknown) => {
            const ack = resolveAck(payloadOrAck, maybeAck);
            const queueIndex =
                payloadOrAck &&
                typeof payloadOrAck === "object" &&
                Number.isInteger(
                    (payloadOrAck as { queueIndex?: unknown }).queueIndex,
                )
                    ? ((payloadOrAck as { queueIndex: number }).queueIndex ??
                      -1)
                    : -1;
            if (queueIndex < 0) {
                sendAck(ack, { error: "queueIndex required" });
                return;
            }
            try {
                await withListenTogetherMutationAdmission(
                    "track:playback-failed",
                    () => processPlaybackFailure(ns, socket, queueIndex),
                );
                sendAck(ack, { ok: true });
            } catch (error) {
                const message = groupErrorMessage(
                    error,
                    "Failed to process playback failure",
                );
                if (error instanceof GroupError && error.retryable) {
                    recordGroupConflict(
                        socket.data.groupId,
                        socket.data.userId,
                        "track:playback-failed",
                        message,
                    );
                }
                sendAck(ack, buildOperationErrorAck(error, message));
            }
        },
    );
}

function registerLifecycleHandlers(socket: AuthenticatedSocket): void {
    socket.on("lt-ping", (payloadOrAck?: unknown, maybeAck?: unknown) => {
        sendAck(resolveAck(payloadOrAck, maybeAck), { serverTime: Date.now() });
    });
    socket.on(
        "leave-group",
        async (payloadOrAck?: unknown, maybeAck?: unknown) => {
            const ack = resolveAck(payloadOrAck, maybeAck);
            try {
                await withListenTogetherMutationAdmission("leave-group", () =>
                    handleLeaveRoomAdmitted(socket),
                );
                sendAck(ack, { ok: true });
            } catch (error) {
                if (error instanceof GroupError && error.retryable) {
                    recordGroupConflict(
                        socket.data.groupId,
                        socket.data.userId,
                        "leave-group",
                        error.message,
                    );
                }
                sendAck(
                    ack,
                    buildOperationErrorAck(error, "Failed to leave group"),
                );
            }
        },
    );
    socket.on("disconnect", async (reason) => {
        logger.debug(
            `[ListenTogether/WS] Disconnected: ${socket.data.username} (${reason})`,
        );
        try {
            await withListenTogetherMutationAdmission("disconnect", () =>
                handleLeaveRoomAdmitted(socket, true),
            );
        } catch (error) {
            if (
                !(error instanceof GroupError && error.code === "UNAVAILABLE")
            ) {
                log.warn("Disconnect cleanup failed", { error });
            }
        }
    });
}

function configureConnectedSocket(
    ns: Namespace,
    socket: AuthenticatedSocket,
): void {
    logger.debug(
        `[ListenTogether/WS] Connected: ${socket.data.username} (${socket.id})`,
    );
    registerJoinHandler(ns, socket);
    registerPlaybackHandler(socket);
    registerQueueHandler(socket);
    registerReadyHandler(socket);
    registerPlaybackFailureHandler(ns, socket);
    registerLifecycleHandlers(socket);
}

function registerConnectionHandler(ns: Namespace): void {
    ns.on("connection", (rawSocket) => {
        configureConnectedSocket(ns, rawSocket as AuthenticatedSocket);
    });
}

/**
 * Handle a socket leaving its current group room.
 * On disconnect, we only remove the socket (not the member) so they can reconnect.
 * On explicit leave-group, we remove the member entirely.
 */
async function handleLeaveRoomAdmitted(
    socket: AuthenticatedSocket,
    isDisconnect: boolean = false,
): Promise<void> {
    const { userId, groupId } = socket.data;
    if (!groupId) return;

    // Always remove this specific socket
    groupManager.removeSocket(groupId, userId, socket.id);
    socket.data.groupId = null;
    await socket.leave(groupId);

    if (isDisconnect) {
        // On disconnect, only remove the member if they have no remaining sockets
        // and let stale-member cleanup handle the rest
        const remaining = groupManager.socketCount(groupId, userId);
        if (remaining === 0) {
            // Don't immediately remove — give them a grace period to reconnect.
            scheduleDisconnectCleanup(groupId, userId, socket.data.username);
        }
    } else {
        recentDisconnectAtMs.delete(disconnectCleanupKey(groupId, userId));
        clearDisconnectCleanup(groupId, userId);

        // Explicit leave — remove member from in-memory and DB.
        await leaveGroupAdmitted(userId, groupId);
    }
}

/**
 * Executes getListenTogetherIO.
 */
export function getListenTogetherIO(): Server | null {
    return io;
}

/** Stop new socket mutations and drain every acquired mutation boundary. */
export async function stopListenTogetherSocketIntake(): Promise<ListenTogetherDrainResult> {
    const drainDeadlineAtMs =
        Date.now() + (config.listenTogether.mutationDrainDeadlineMs ?? 10_000);
    const mutationDrain =
        stopListenTogetherMutationAdmission(drainDeadlineAtMs);
    // stop() clears cluster handlers synchronously before its first await.
    stopClusterStateSync();
    readyGateCompletionSupervisor.shutdown();
    shutdownAvailabilityPublications();
    for (const timer of pendingDisconnectCleanupTimers.values()) {
        clearTimeout(timer);
    }
    pendingDisconnectCleanupTimers.clear();
    if (io) {
        io.close();
        io = null;
    }
    listenTogetherNamespace = null;
    const admissionResult = await mutationDrain;
    if (!admissionResult.drained) return admissionResult;
    const boundaryResult = await drainListenTogetherMutationBoundaries(
        drainDeadlineAtMs,
        pendingReadyGateCompletions.values(),
    );
    if (!boundaryResult.drained) {
        log.warn("Shutdown boundary drain deadline expired");
    }
    return boundaryResult;
}

/**
 * Executes shutdownListenTogetherSocket.
 */
export function shutdownListenTogetherSocket(): void {
    stopClusterStateSync();
    readyGateCompletionSupervisor.shutdown();
    shutdownAvailabilityPublications();
    for (const timer of pendingDisconnectCleanupTimers.values()) {
        clearTimeout(timer);
    }
    pendingDisconnectCleanupTimers.clear();
    pendingReadyGateCompletions.clear();
    recentDisconnectAtMs.clear();
    resetGroupPublications();

    if (io) io.close();
    io = null;
    listenTogetherNamespace = null;

    if (redisAdapterSubClient) {
        redisAdapterSubClient.disconnect();
        redisAdapterSubClient = null;
    }

    if (redisAdapterPubClient) {
        redisAdapterPubClient.disconnect();
        redisAdapterPubClient = null;
    }

    shutdownGroupMutationLock();

    if (unsubscribeSocialPresenceUpdates) {
        unsubscribeSocialPresenceUpdates();
        unsubscribeSocialPresenceUpdates = null;
    }

    listenTogetherStateStore.stop();
}
