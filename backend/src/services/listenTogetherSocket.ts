/**
 * Socket.IO namespace for Listen Together.
 *
 * Handles all real-time communication: playback sync, queue mutations,
 * ready-gate protocol, and member presence.
 *
 * JWT authentication is verified on connection handshake.
 */

import type { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { createIORedisClient } from "../utils/ioredis";
import { listenTogetherClusterSync } from "./listenTogetherClusterSync";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
import {
    subscribeSocialPresenceUpdates,
    type SocialPresenceUpdatedEvent,
} from "./socialPresenceEvents";
import {
    groupManager,
    GroupError,
    type ManagerCallbacks,
    type GroupSnapshot,
    type PlaybackDelta,
    type QueueDelta,
} from "./listenTogetherManager";
import {
    joinGroupById,
    leaveGroup,
    validateLocalTracks,
} from "./listenTogether";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;
if (!JWT_SECRET) {
    throw new Error("JWT_SECRET or SESSION_SECRET is required for Socket.IO auth");
}

interface JWTPayload {
    userId: string;
    username: string;
    role: string;
    tokenVersion?: number;
}

interface AuthenticatedSocket extends Socket {
    data: {
        userId: string;
        username: string;
        groupId: string | null;
    };
}

type SocketAck = (res: unknown) => void;

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

// ---------------------------------------------------------------------------
// Socket.IO setup
// ---------------------------------------------------------------------------

let io: Server | null = null;
const LISTEN_TOGETHER_PING_INTERVAL_MS = 25_000;
const LISTEN_TOGETHER_PING_TIMEOUT_MS = 60_000;
const DISCONNECT_MEMBER_GRACE_MS = 60_000;
const DEFAULT_LISTEN_TOGETHER_RECONNECT_SLO_MS = 5_000;
const parsedReconnectSloMs = Number.parseInt(
    process.env.LISTEN_TOGETHER_RECONNECT_SLO_MS ||
        `${DEFAULT_LISTEN_TOGETHER_RECONNECT_SLO_MS}`,
    10
);
const LISTEN_TOGETHER_RECONNECT_SLO_MS =
    Number.isFinite(parsedReconnectSloMs) && parsedReconnectSloMs > 0
        ? parsedReconnectSloMs
        : DEFAULT_LISTEN_TOGETHER_RECONNECT_SLO_MS;
const LISTEN_TOGETHER_ALLOW_POLLING =
    process.env.LISTEN_TOGETHER_ALLOW_POLLING === "true";
const LISTEN_TOGETHER_SOCKET_TRANSPORTS: Array<"websocket" | "polling"> =
    LISTEN_TOGETHER_ALLOW_POLLING ? ["websocket", "polling"] : ["websocket"];
const LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED =
    process.env.LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED !== "false";
const LISTEN_TOGETHER_MUTATION_LOCK_ENABLED =
    process.env.LISTEN_TOGETHER_MUTATION_LOCK_ENABLED !== "false";
const DEFAULT_LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS = 3_000;
const parsedMutationLockTtlMs = Number.parseInt(
    process.env.LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS ||
        `${DEFAULT_LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS}`,
    10
);
const LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS =
    Number.isFinite(parsedMutationLockTtlMs) && parsedMutationLockTtlMs > 0
        ? parsedMutationLockTtlMs
        : DEFAULT_LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS;
const LISTEN_TOGETHER_MUTATION_LOCK_PREFIX =
    process.env.LISTEN_TOGETHER_MUTATION_LOCK_PREFIX ||
    "listen-together:mutation-lock";
const LISTEN_TOGETHER_CONFLICT_RETRY_AFTER_MS = Math.min(
    500,
    Math.max(75, Math.floor(LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS / 10))
);
const LISTEN_TOGETHER_OBSERVABILITY_LOG_EVERY = 25;
const pendingDisconnectCleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
>();
const recentDisconnectAtMs = new Map<string, number>();
const pendingGroupSnapshotWrites = new Map<string, Promise<void>>();
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
const mutationLockNodeId = randomUUID();
let mutationLockRedisClient: ReturnType<typeof createIORedisClient> | null = null;
let unsubscribeSocialPresenceUpdates: (() => void) | null = null;

if (LISTEN_TOGETHER_MUTATION_LOCK_ENABLED) {
    mutationLockRedisClient = createIORedisClient("listen-together-mutation-locks");
}

function logListenTogetherObservability(reason: string): void {
    logger.info(
        `[ListenTogether/Observability] reason=${reason} reconnectSamples=${listenTogetherObservabilityCounters.reconnectSamples} reconnectBreaches=${listenTogetherObservabilityCounters.reconnectBreaches} conflictErrors=${listenTogetherObservabilityCounters.conflictErrors} mutationLockAcquireFailures=${listenTogetherObservabilityCounters.mutationLockAcquireFailures} disconnectCleanupScheduled=${listenTogetherObservabilityCounters.disconnectCleanupScheduled} disconnectCleanupExecuted=${listenTogetherObservabilityCounters.disconnectCleanupExecuted}`
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
    message: string
): void {
    listenTogetherObservabilityCounters.conflictErrors += 1;
    logger.warn(
        `[ListenTogether/Conflict] operation=${operation} groupId=${groupId ?? "none"} userId=${userId} message=${message}`
    );
    maybeLogListenTogetherObservability("conflict");
}

function buildTransientConflictAck(message: string): TransientConflictAckPayload {
    return {
        error: message,
        code: "CONFLICT",
        transient: true,
        retryable: true,
        retryAfterMs: LISTEN_TOGETHER_CONFLICT_RETRY_AFTER_MS,
    };
}

function enqueueGroupSnapshotWrite(
    groupId: string,
    write: () => Promise<void>
): Promise<void> {
    const previous = pendingGroupSnapshotWrites.get(groupId) ?? Promise.resolve();
    let queued: Promise<void>;
    queued = previous
        .then(() => undefined, () => undefined)
        .then(write)
        .catch(() => undefined)
        .finally(() => {
            if (pendingGroupSnapshotWrites.get(groupId) === queued) {
                pendingGroupSnapshotWrites.delete(groupId);
            }
        });
    pendingGroupSnapshotWrites.set(groupId, queued);
    return queued;
}

async function flushGroupSnapshotWrites(groupId: string): Promise<void> {
    const pending = pendingGroupSnapshotWrites.get(groupId);
    if (!pending) return;
    await pending;
}

function queuePersistAndPublishSnapshot(
    groupId: string,
    snapshot?: GroupSnapshot
): Promise<void> {
    const resolvedSnapshot = snapshot ?? groupManager.snapshotById(groupId);
    if (!resolvedSnapshot) {
        return Promise.resolve();
    }

    return enqueueGroupSnapshotWrite(groupId, async () => {
        await listenTogetherStateStore.setSnapshot(groupId, resolvedSnapshot);
        await listenTogetherClusterSync.publishSnapshot(groupId, resolvedSnapshot);
    });
}

function queueEndedSnapshotSync(groupId: string): Promise<void> {
    const snapshot = groupManager.snapshotById(groupId);
    return enqueueGroupSnapshotWrite(groupId, async () => {
        await listenTogetherStateStore.deleteSnapshot(groupId);
        if (snapshot) {
            await listenTogetherClusterSync.publishSnapshot(groupId, snapshot);
        }
    });
}

async function withGroupMutationLock<T>(
    groupId: string,
    operationName: string,
    operation: () => Promise<T>
): Promise<T> {
    if (!LISTEN_TOGETHER_MUTATION_LOCK_ENABLED || !mutationLockRedisClient) {
        try {
            return await operation();
        } finally {
            await flushGroupSnapshotWrites(groupId);
        }
    }

    const lockKey = `${LISTEN_TOGETHER_MUTATION_LOCK_PREFIX}:${groupId}`;
    const lockToken = `${mutationLockNodeId}:${Date.now()}:${Math.random()}`;
    const ttlSeconds = Math.max(
        1,
        Math.ceil(LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS / 1000)
    );

    try {
        const acquired = await mutationLockRedisClient.set(
            lockKey,
            lockToken,
            "EX",
            ttlSeconds,
            "NX"
        );

        if (acquired !== "OK") {
            throw new GroupError(
                "CONFLICT",
                "Another group update is in progress. Please retry."
            );
        }
    } catch (err) {
        if (err instanceof GroupError) {
            throw err;
        }

        logger.error(
            `[ListenTogether/MutationLock] Failed to acquire lock for ${operationName} (${groupId})`,
            err
        );
        listenTogetherObservabilityCounters.mutationLockAcquireFailures += 1;
        maybeLogListenTogetherObservability("mutation-lock-acquire-failure");
        throw new GroupError(
            "CONFLICT",
            "Group coordination temporarily unavailable. Please retry."
        );
    }

    try {
        const authoritativeSnapshot =
            await listenTogetherStateStore.getSnapshot(groupId);
        if (authoritativeSnapshot) {
            groupManager.applyExternalSnapshot(authoritativeSnapshot);
        }

        return await operation();
    } finally {
        await flushGroupSnapshotWrites(groupId);
        try {
            await mutationLockRedisClient.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                1,
                lockKey,
                lockToken
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/MutationLock] Failed to release lock for ${operationName} (${groupId})`,
                err
            );
        }
    }
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

function recordReconnectSlo(groupId: string, userId: string, username: string): void {
    const key = disconnectCleanupKey(groupId, userId);
    const disconnectedAtMs = recentDisconnectAtMs.get(key);
    if (!disconnectedAtMs) {
        return;
    }

    recentDisconnectAtMs.delete(key);
    const reconnectMs = Math.max(0, Date.now() - disconnectedAtMs);
    listenTogetherObservabilityCounters.reconnectSamples += 1;

    logger.info(
        `[ListenTogether/SLO] Reconnect latency ${reconnectMs}ms for ${username} (${groupId})`
    );

    if (reconnectMs > LISTEN_TOGETHER_RECONNECT_SLO_MS) {
        listenTogetherObservabilityCounters.reconnectBreaches += 1;
        logger.warn(
            `[ListenTogether/SLO] Reconnect latency ${reconnectMs}ms exceeded target ${LISTEN_TOGETHER_RECONNECT_SLO_MS}ms for ${username} (${groupId})`
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

export function setupListenTogetherSocket(httpServer: HttpServer): Server {
    io = new Server(httpServer, {
        path: "/socket.io/listen-together",
        cors: {
            origin: (_origin, cb) => cb(null, true), // Same CORS policy as Express
            credentials: true,
        },
        transports: LISTEN_TOGETHER_SOCKET_TRANSPORTS,
        pingInterval: LISTEN_TOGETHER_PING_INTERVAL_MS,
        pingTimeout: LISTEN_TOGETHER_PING_TIMEOUT_MS,
        // Limit payload size to prevent abuse
        maxHttpBufferSize: 1e6, // 1 MB
    });

    const ns = io.of("/listen-together");

    if (!unsubscribeSocialPresenceUpdates) {
        unsubscribeSocialPresenceUpdates = subscribeSocialPresenceUpdates(
            (event: SocialPresenceUpdatedEvent) => {
                ns.emit("social:presence-updated", event);
            }
        );
    }

    if (LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED) {
        try {
            // Require dynamically so local/dev builds still run if the adapter
            // package is missing. In that case we log and continue in local mode.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createAdapter } = require("@socket.io/redis-adapter") as {
                createAdapter: (pubClient: unknown, subClient: unknown) => unknown;
            };

            redisAdapterPubClient = createIORedisClient(
                "listen-together-socket-adapter-pub"
            );
            redisAdapterSubClient = redisAdapterPubClient.duplicate();

            // Attach adapter at the Server level; Namespace does not expose adapter(...)
            // as a callable function in this runtime.
            (io as any).adapter(
                createAdapter(redisAdapterPubClient, redisAdapterSubClient)
            );
            logger.info(
                "[ListenTogether/WS] Redis adapter enabled for cross-pod Socket.IO fanout"
            );
            if (listenTogetherStateStore.isEnabled()) {
                logger.info(
                    "[ListenTogether/WS] Cross-pod authoritative session snapshots are enabled via Redis state store"
                );
            } else {
                logger.warn(
                    "[ListenTogether/WS] Cross-pod fanout is enabled, but authoritative session snapshots are disabled (LISTEN_TOGETHER_STATE_STORE_ENABLED=false); GroupManager state remains pod-local in-memory between mutations."
                );
            }
        } catch (err) {
            logger.error(
                "[ListenTogether/WS] Failed to initialize Redis adapter; continuing in single-pod fanout mode",
                err
            );
        }
    } else {
        logger.info(
            "[ListenTogether/WS] Redis adapter disabled via LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED=false"
        );
    }

    if (listenTogetherClusterSync.isEnabled()) {
        listenTogetherClusterSync
            .start((snapshot) => {
                groupManager.applyExternalSnapshot(snapshot);
            })
            .catch((err) => {
                logger.error(
                    "[ListenTogether/StateSync] Failed to start cluster sync; proceeding with pod-local state",
                    err
                );
            });
    } else {
        logger.info(
            "[ListenTogether/StateSync] Disabled via LISTEN_TOGETHER_STATE_SYNC_ENABLED=false"
        );
    }

    if (LISTEN_TOGETHER_MUTATION_LOCK_ENABLED) {
        logger.info(
            `[ListenTogether/MutationLock] Enabled (ttlMs=${LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS}, prefix=${LISTEN_TOGETHER_MUTATION_LOCK_PREFIX})`
        );
    } else {
        logger.info(
            "[ListenTogether/MutationLock] Disabled via LISTEN_TOGETHER_MUTATION_LOCK_ENABLED=false"
        );
    }

    if (listenTogetherStateStore.isEnabled()) {
        logger.info("[ListenTogether/StateStore] Enabled");
    } else {
        logger.info(
            "[ListenTogether/StateStore] Disabled via LISTEN_TOGETHER_STATE_STORE_ENABLED=false"
        );
    }
    logger.info(
        `[ListenTogether/SLO] Reconnect target set to ${LISTEN_TOGETHER_RECONNECT_SLO_MS}ms`
    );
    logger.info(
        `[ListenTogether/WS] Transport policy: ${
            LISTEN_TOGETHER_ALLOW_POLLING
                ? "websocket + polling fallback"
                : "websocket-only"
        }`
    );

    // JWT auth middleware
    ns.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token as string | undefined;
            if (!token) {
                return next(new Error("Authentication required"));
            }

            const decoded = jwt.verify(token, JWT_SECRET!) as unknown as JWTPayload;

            // Verify user exists and tokenVersion matches
            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: { id: true, username: true, role: true, tokenVersion: true },
            });

            if (!user) {
                return next(new Error("User not found"));
            }

            if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
                return next(new Error("Token expired"));
            }

            socket.data = {
                userId: user.id,
                username: user.username,
                groupId: null,
            };

            next();
        } catch (err) {
            next(new Error("Invalid token"));
        }
    });

    // Wire up manager callbacks → Socket.IO broadcasts
    const callbacks: ManagerCallbacks = {
        onGroupState(groupId: string, snapshot: GroupSnapshot) {
            ns.to(groupId).emit("group:state", snapshot);
            void queuePersistAndPublishSnapshot(groupId, snapshot);
        },
        onPlaybackDelta(groupId: string, delta: PlaybackDelta) {
            ns.to(groupId).emit("group:playback-delta", delta);
            void queuePersistAndPublishSnapshot(groupId);
        },
        onQueueDelta(groupId: string, delta: QueueDelta) {
            ns.to(groupId).emit("group:queue-delta", delta);
            void queuePersistAndPublishSnapshot(groupId);
        },
        onWaiting(groupId: string, data) {
            ns.to(groupId).emit("group:waiting", data);
            void queuePersistAndPublishSnapshot(groupId);
        },
        onPlayAt(groupId: string, data) {
            ns.to(groupId).emit("group:play-at", data);
            void queuePersistAndPublishSnapshot(groupId);
        },
        onMemberJoined(groupId: string, member) {
            ns.to(groupId).emit("group:member-joined", member);
            void queuePersistAndPublishSnapshot(groupId);
        },
        onMemberLeft(groupId: string, data) {
            ns.to(groupId).emit("group:member-left", data);
            void queuePersistAndPublishSnapshot(groupId);
        },
        onGroupEnded(groupId: string, reason: string) {
            ns.to(groupId).emit("group:ended", { reason });
            void queueEndedSnapshotSync(groupId);
        },
    };

    groupManager.setCallbacks(callbacks);

    // Connection handler
    ns.on("connection", (rawSocket) => {
        const socket = rawSocket as AuthenticatedSocket;
        const { userId, username } = socket.data;

        logger.debug(`[ListenTogether/WS] Connected: ${username} (${socket.id})`);

        // ----- join-group -----
        socket.on("join-group", async (data: { groupId: string }, ack?: (res: unknown) => void) => {
            try {
                const { groupId } = data;
                if (!groupId || typeof groupId !== "string") {
                    sendAck(ack, { error: "groupId is required" });
                    return;
                }

                // Leave previous room if any
                if (socket.data.groupId && socket.data.groupId !== groupId) {
                    await handleLeaveRoom(socket);
                }

                // Join via service (validates DB membership, hydrates if needed)
                const snapshot = await joinGroupById(userId, username, groupId);

                // Track socket in manager
                recordReconnectSlo(groupId, userId, username);
                clearDisconnectCleanup(groupId, userId);
                groupManager.addSocket(groupId, userId, socket.id);
                socket.data.groupId = groupId;

                // Join Socket.IO room
                await socket.join(groupId);

                // Send current state to the new member only
                socket.emit("group:state", snapshot);

                sendAck(ack, { ok: true });
                logger.debug(`[ListenTogether/WS] ${username} joined room ${groupId}`);
            } catch (err) {
                const message = err instanceof GroupError ? err.message : "Failed to join group";
                sendAck(ack, { error: message });
                logger.error(`[ListenTogether/WS] join-group error:`, err);
            }
        });

        // ----- playback commands -----
        socket.on(
            "playback",
            async (
                data: { action: string; positionMs?: number; index?: number },
                ack?: (res: unknown) => void
            ) => {
                try {
                    const groupId = socket.data.groupId;
                    if (!groupId) {
                        sendAck(ack, { error: "Not in a group" });
                        return;
                    }

                    await withGroupMutationLock(
                        groupId,
                        `playback:${data.action}`,
                        async () => {
                            switch (data.action) {
                                case "play":
                                    groupManager.play(groupId, userId);
                                    return;
                                case "pause":
                                    groupManager.pause(groupId, userId);
                                    return;
                                case "seek":
                                    if (typeof data.positionMs !== "number") {
                                        throw new GroupError(
                                            "INVALID",
                                            "positionMs required for seek"
                                        );
                                    }
                                    groupManager.seek(groupId, userId, data.positionMs);
                                    return;
                                case "next":
                                    groupManager.next(groupId, userId);
                                    return;
                                case "previous":
                                    groupManager.previous(groupId, userId);
                                    return;
                                case "set-track":
                                    if (typeof data.index !== "number") {
                                        throw new GroupError(
                                            "INVALID",
                                            "index required for set-track"
                                        );
                                    }
                                    groupManager.setTrack(groupId, userId, data.index);
                                    return;
                                default:
                                    throw new GroupError(
                                        "INVALID",
                                        `Unknown action: ${data.action}`
                                    );
                            }
                        }
                    );

                    sendAck(ack, { ok: true });
                } catch (err) {
                    const message =
                        err instanceof GroupError ? err.message : "Playback error";
                    if (err instanceof GroupError && err.code === "CONFLICT") {
                        recordGroupConflict(
                            socket.data.groupId,
                            userId,
                            `playback:${data.action}`,
                            message
                        );
                        sendAck(ack, buildTransientConflictAck(message));
                        return;
                    }
                    sendAck(ack, { error: message });
                }
            }
        );

        // ----- queue commands -----
        socket.on("queue", async (data: { action: string; trackIds?: string[]; index?: number; fromIndex?: number; toIndex?: number }, ack?: (res: unknown) => void) => {
            try {
                const groupId = socket.data.groupId;
                if (!groupId) {
                    sendAck(ack, { error: "Not in a group" });
                    return;
                }

                switch (data.action) {
                    case "add": {
                        if (!Array.isArray(data.trackIds) || data.trackIds.length === 0) {
                            sendAck(ack, { error: "trackIds required" });
                            return;
                        }
                        // Validate tracks are local
                        const items = await validateLocalTracks(data.trackIds);
                        if (items.length === 0) {
                            sendAck(ack, { error: "No valid local tracks found" });
                            return;
                        }
                        await withGroupMutationLock(
                            groupId,
                            "queue:add",
                            async () => {
                                groupManager.modifyQueue(groupId, userId, {
                                    action: "add",
                                    items,
                                });
                            }
                        );
                        break;
                    }
                    case "insert-next": {
                        if (!Array.isArray(data.trackIds) || data.trackIds.length === 0) {
                            sendAck(ack, { error: "trackIds required" });
                            return;
                        }
                        const insertItems = await validateLocalTracks(data.trackIds);
                        if (insertItems.length === 0) {
                            sendAck(ack, { error: "No valid local tracks found" });
                            return;
                        }
                        await withGroupMutationLock(
                            groupId,
                            "queue:insert-next",
                            async () => {
                                groupManager.modifyQueue(groupId, userId, {
                                    action: "insert-next",
                                    items: insertItems,
                                });
                            }
                        );
                        break;
                    }
                    case "remove": {
                        if (typeof data.index !== "number") {
                            sendAck(ack, { error: "index required" });
                            return;
                        }
                        const removeIndex = data.index;
                        await withGroupMutationLock(
                            groupId,
                            "queue:remove",
                            async () => {
                                groupManager.modifyQueue(groupId, userId, {
                                    action: "remove",
                                    index: removeIndex,
                                });
                            }
                        );
                        break;
                    }
                    case "reorder": {
                        if (typeof data.fromIndex !== "number" || typeof data.toIndex !== "number") {
                            sendAck(ack, { error: "fromIndex and toIndex required" });
                            return;
                        }
                        const fromIndex = data.fromIndex;
                        const toIndex = data.toIndex;
                        await withGroupMutationLock(
                            groupId,
                            "queue:reorder",
                            async () => {
                                groupManager.modifyQueue(groupId, userId, {
                                    action: "reorder",
                                    fromIndex,
                                    toIndex,
                                });
                            }
                        );
                        break;
                    }
                    case "clear":
                        await withGroupMutationLock(
                            groupId,
                            "queue:clear",
                            async () => {
                                groupManager.modifyQueue(groupId, userId, {
                                    action: "clear",
                                });
                            }
                        );
                        break;
                    default:
                        sendAck(ack, { error: `Unknown action: ${data.action}` });
                        return;
                }
                sendAck(ack, { ok: true });
            } catch (err) {
                const message = err instanceof GroupError ? err.message : "Queue error";
                if (err instanceof GroupError && err.code === "CONFLICT") {
                    recordGroupConflict(
                        socket.data.groupId,
                        userId,
                        `queue:${data.action}`,
                        message
                    );
                }
                sendAck(ack, { error: message });
            }
        });

        // ----- ready gate -----
        socket.on("ready", async (payloadOrAck?: unknown, maybeAck?: unknown) => {
            const ack = resolveAck(payloadOrAck, maybeAck);
            try {
                const groupId = socket.data.groupId;
                if (!groupId) {
                    sendAck(ack, { error: "Not in a group" });
                    return;
                }
                await withGroupMutationLock(groupId, "ready", async () => {
                    groupManager.reportReady(groupId, userId);
                });
                sendAck(ack, { ok: true });
            } catch (err) {
                if (err instanceof GroupError && err.code === "CONFLICT") {
                    recordGroupConflict(
                        socket.data.groupId,
                        userId,
                        "ready",
                        err.message
                    );
                    sendAck(ack, buildTransientConflictAck(err.message));
                    return;
                }
                sendAck(ack, { error: "Ready report failed" });
            }
        });

        // ----- ping (latency measurement) -----
        socket.on("lt-ping", (payloadOrAck?: unknown, maybeAck?: unknown) => {
            const ack = resolveAck(payloadOrAck, maybeAck);
            sendAck(ack, { serverTime: Date.now() });
        });

        // ----- leave group -----
        socket.on("leave-group", async (payloadOrAck?: unknown, maybeAck?: unknown) => {
            const ack = resolveAck(payloadOrAck, maybeAck);
            try {
                await handleLeaveRoom(socket);
                sendAck(ack, { ok: true });
            } catch (err) {
                sendAck(ack, { error: "Failed to leave group" });
            }
        });

        // ----- disconnect -----
        socket.on("disconnect", async (reason) => {
            logger.debug(`[ListenTogether/WS] Disconnected: ${username} (${reason})`);
            await handleLeaveRoom(socket, true);
        });
    });

    return io;
}

/**
 * Handle a socket leaving its current group room.
 * On disconnect, we only remove the socket (not the member) so they can reconnect.
 * On explicit leave-group, we remove the member entirely.
 */
async function handleLeaveRoom(socket: AuthenticatedSocket, isDisconnect: boolean = false): Promise<void> {
    const { userId, groupId } = socket.data;
    if (!groupId) return;

    // Always remove this specific socket
    groupManager.removeSocket(groupId, userId, socket.id);
    socket.data.groupId = null;
    socket.leave(groupId);

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

        // Explicit leave — remove member from in-memory and DB
        try {
            await leaveGroup(userId, groupId);
        } catch (err) {
            logger.error(`[ListenTogether/WS] Error leaving group:`, err);
        }
    }
}

export function getListenTogetherIO(): Server | null {
    return io;
}

export function shutdownListenTogetherSocket(): void {
    for (const timer of pendingDisconnectCleanupTimers.values()) {
        clearTimeout(timer);
    }
    pendingDisconnectCleanupTimers.clear();
    recentDisconnectAtMs.clear();
    pendingGroupSnapshotWrites.clear();

    if (io) {
        io.close();
        io = null;
    }

    void listenTogetherClusterSync.stop();

    if (redisAdapterSubClient) {
        redisAdapterSubClient.disconnect();
        redisAdapterSubClient = null;
    }

    if (redisAdapterPubClient) {
        redisAdapterPubClient.disconnect();
        redisAdapterPubClient = null;
    }

    if (mutationLockRedisClient) {
        mutationLockRedisClient.disconnect();
        mutationLockRedisClient = null;
    }

    if (unsubscribeSocialPresenceUpdates) {
        unsubscribeSocialPresenceUpdates();
        unsubscribeSocialPresenceUpdates = null;
    }

    listenTogetherStateStore.stop();
}
