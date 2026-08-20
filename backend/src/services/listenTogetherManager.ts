/**
 * In-memory group state manager for Listen Together.
 *
 * This is the "hot path" — play, pause, seek, next, prev, queue mutations all
 * happen here with zero database calls.  PostgreSQL is only touched on
 * create / join / leave / discover (cold path) and via periodic persistence.
 *
 * Design references: Jellyfin SyncPlay, Syncplay, Synctube.
 */

import type {} from "@soundspan/media-metadata-contract";
import type { SyncQueueItem } from "./listenTogetherQueueItem";
import type {
    ManagerCallbacks,
    StatePublicationOptions,
} from "./listenTogetherCallbacks";
import { logger } from "../utils/logger";
import {
    compensateSnapshotPosition,
    applyExactCommittedMembership,
    advanceSnapshotWatermark,
    mergeSnapshotMembers,
    reconcileHostFlags,
    selectHostSuccessor,
    shouldApplyIncomingPlayback,
    snapshotMembers,
    type PersistedGroupMember,
} from "./listenTogetherSnapshot";

const log = logger.child("ListenTogetherManager");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SyncQueueItem } from "./listenTogetherQueueItem";
export type {
    ManagerCallbacks,
    StatePublicationOptions,
} from "./listenTogetherCallbacks";

export interface GroupMember {
    userId: string;
    username: string;
    isHost: boolean;
    joinedAt: Date;
    socketIds: Set<string>;
    isReady: boolean;
    unavailableIndices?: Set<number>;
    lastSeen: number; // Date.now()
}

export type { PersistedGroupMember } from "./listenTogetherSnapshot";

export interface GroupPlayback {
    queue: SyncQueueItem[];
    currentIndex: number;
    isPlaying: boolean;
    /** Track position (ms) at the moment captured by `lastPositionUpdate`. */
    positionMs: number;
    /** Date.now() when `positionMs` was last written. */
    lastPositionUpdate: number;
    /** Producer clock from the most recently applied or published snapshot. */
    lastAppliedSnapshotServerTime: number;
    stateVersion: number;
}

export type GroupSyncState = "idle" | "waiting" | "playing" | "paused";

export interface GroupState {
    id: string;
    name: string;
    joinCode: string;
    groupType: "host-follower" | "collaborative";
    visibility: "public" | "private";
    hostUserId: string;
    syncState: GroupSyncState;
    playback: GroupPlayback;
    members: Map<string, GroupMember>;
    /** User-IDs that have reported "ready" during a waiting gate. */
    readyUserIds: Set<string>;
    /** Timer handle for the ready-gate timeout. */
    readyTimeout: ReturnType<typeof setTimeout> | null;
    /** Absolute ready-gate deadline (`Date.now()` ms), if waiting. */
    readyDeadlineMs: number | null;
    /** Timer handle for the current track's boundary watchdog. */
    boundaryTimeout: ReturnType<typeof setTimeout> | null;
    lastActivity: number; // Date.now()
    createdAt: Date;
    /** True when in-memory state has diverged from DB and needs persisting. */
    dirty: boolean;
    /** True when playback came from a live or shared authoritative snapshot. */
    playbackAuthoritative: boolean;
}

/** Serialisable snapshot broadcast to clients. */
export interface GroupSnapshot {
    id: string;
    name: string;
    joinCode: string;
    groupType: "host-follower" | "collaborative";
    visibility: "public" | "private";
    isActive: boolean;
    hostUserId: string;
    syncState: GroupSyncState;
    readyDeadlineMs?: number | null;
    /** Ready votes are optional when reading snapshots written by older versions. */
    readyUserIds?: string[];
    playback: {
        queue: SyncQueueItem[];
        currentIndex: number;
        isPlaying: boolean;
        positionMs: number;
        serverTime: number;
        stateVersion: number;
        trackId: string | null;
    };
    members: Array<{
        userId: string;
        username: string;
        isHost: boolean;
        joinedAt: string;
        isConnected: boolean;
    }>;
}

/** Lightweight delta for play/pause/seek (avoids re-sending full queue). */
export interface PlaybackDelta {
    isPlaying: boolean;
    positionMs: number;
    serverTime: number;
    stateVersion: number;
    currentIndex: number;
    trackId: string | null;
}

export interface QueueDelta {
    queue: SyncQueueItem[];
    currentIndex: number;
    trackId: string | null;
    stateVersion: number;
}

export type QueueAction =
    | { action: "add"; items: SyncQueueItem[] }
    | { action: "insert-next"; items: SyncQueueItem[] }
    | { action: "remove"; index: number }
    | { action: "reorder"; fromIndex: number; toIndex: number }
    | { action: "clear" };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Represents the GroupError class.
 */
export class GroupError extends Error {
    constructor(
        public readonly code:
            | "NOT_FOUND"
            | "NOT_MEMBER"
            | "NOT_ALLOWED"
            | "INVALID"
            | "CONFLICT",
        message: string,
    ) {
        super(message);
        this.name = "GroupError";
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function clampIndex(index: number, length: number): number {
    if (length <= 0) return 0;
    return clamp(index, 0, length - 1);
}

function truncateQueueItemsToAvailableCapacity(
    queueLength: number,
    items: SyncQueueItem[],
): SyncQueueItem[] {
    const remainingCapacity = Math.max(0, MAX_QUEUE_SIZE - queueLength);
    return remainingCapacity > 0 ? items.slice(0, remainingCapacity) : [];
}

function currentTrackDurationMs(pb: GroupPlayback): number | null {
    const durationSeconds = pb.queue[pb.currentIndex]?.duration;
    if (
        typeof durationSeconds !== "number" ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds < 0
    ) {
        return null;
    }
    const durationMs = durationSeconds * 1000;
    return Number.isFinite(durationMs) ? durationMs : null;
}

function computeUnclampedPosition(pb: GroupPlayback): number {
    if (!pb.isPlaying) return pb.positionMs;
    const elapsed = Date.now() - pb.lastPositionUpdate;
    return pb.positionMs + Math.max(elapsed, 0);
}

/** Compute the "live" position in ms without running past the current track. */
function computePosition(pb: GroupPlayback): number {
    const positionMs = Math.max(0, computeUnclampedPosition(pb));
    const durationMs = currentTrackDurationMs(pb);
    return durationMs === null ? positionMs : clamp(positionMs, 0, durationMs);
}

function currentTrackId(pb: GroupPlayback): string | null {
    return pb.queue[pb.currentIndex]?.id ?? null;
}

/** Hard cap on queue size to keep Socket.IO snapshots within 1 MB. */
export const MAX_QUEUE_SIZE = 500;

/** Max time to wait for all members to report ready (ms). */
const READY_GATE_TIMEOUT_MS = 8_000;

/** Grace after a track boundary before the server repairs a stalled host. */
const BOUNDARY_WATCHDOG_GRACE_MS = 5_000;

/** How long before a member with no sockets is considered stale (ms). */
const STALE_MEMBER_MS = 60_000;

// ---------------------------------------------------------------------------
// GroupManager singleton
// ---------------------------------------------------------------------------

class GroupManager {
    private groups = new Map<string, GroupState>();
    private callbacks: ManagerCallbacks | null = null;

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    setCallbacks(cb: ManagerCallbacks): void {
        this.callbacks = cb;
    }

    /** Restore a group from DB row into in-memory state. */
    hydrate(
        id: string,
        opts: {
            name: string;
            joinCode: string;
            groupType: "host-follower" | "collaborative";
            visibility: "public" | "private";
            hostUserId: string;
            queue: SyncQueueItem[];
            currentIndex: number;
            isPlaying: boolean;
            currentTimeMs: number;
            stateVersion: number;
            createdAt: Date;
            members: PersistedGroupMember[];
        },
    ): GroupState {
        const queue =
            opts.queue.length > MAX_QUEUE_SIZE
                ? opts.queue.slice(0, MAX_QUEUE_SIZE)
                : opts.queue;
        const safeIndex = clampIndex(opts.currentIndex, queue.length);
        const now = Date.now();

        const members = new Map<string, GroupMember>();
        for (const m of opts.members) {
            members.set(m.userId, {
                userId: m.userId,
                username: m.username,
                isHost: m.isHost,
                joinedAt: m.joinedAt,
                socketIds: new Set(),
                isReady: false,
                unavailableIndices: new Set(),
                lastSeen: now,
            });
        }

        const group: GroupState = {
            id,
            name: opts.name,
            joinCode: opts.joinCode,
            groupType: opts.groupType,
            visibility: opts.visibility,
            hostUserId: opts.hostUserId,
            syncState: opts.isPlaying
                ? "playing"
                : queue.length > 0
                  ? "paused"
                  : "idle",
            playback: {
                queue,
                currentIndex: safeIndex,
                isPlaying: false, // Always start paused after hydration (no one is connected yet)
                positionMs: opts.currentTimeMs,
                lastPositionUpdate: now,
                lastAppliedSnapshotServerTime: 0,
                stateVersion: opts.stateVersion,
            },
            members,
            readyUserIds: new Set(),
            readyTimeout: null,
            readyDeadlineMs: null,
            boundaryTimeout: null,
            lastActivity: now,
            createdAt: opts.createdAt,
            dirty: false,
            playbackAuthoritative: false,
        };

        this.groups.set(id, group);
        log.debug(
            `Hydrated group ${id} with ${opts.members.length} members, queue=${queue.length}`,
        );
        return group;
    }

    /** Create a brand-new group (after DB row is created). */
    create(
        id: string,
        opts: {
            name: string;
            joinCode: string;
            groupType: "host-follower" | "collaborative";
            visibility: "public" | "private";
            hostUserId: string;
            hostUsername: string;
            queue: SyncQueueItem[];
            currentIndex?: number;
            currentTimeMs?: number;
            isPlaying?: boolean;
            createdAt: Date;
        },
    ): GroupState {
        const now = Date.now();
        const safeIndex = clampIndex(opts.currentIndex ?? 0, opts.queue.length);
        const activeTrack = opts.queue[safeIndex];
        const maxTrackMs = activeTrack ? activeTrack.duration * 1000 : 0;
        const initialPositionMs = clamp(opts.currentTimeMs ?? 0, 0, maxTrackMs);
        const initialIsPlaying = Boolean(
            opts.isPlaying && opts.queue.length > 0,
        );

        const members = new Map<string, GroupMember>();
        members.set(opts.hostUserId, {
            userId: opts.hostUserId,
            username: opts.hostUsername,
            isHost: true,
            joinedAt: opts.createdAt,
            socketIds: new Set(),
            isReady: false,
            unavailableIndices: new Set(),
            lastSeen: now,
        });

        const group: GroupState = {
            id,
            name: opts.name,
            joinCode: opts.joinCode,
            groupType: opts.groupType,
            visibility: opts.visibility,
            hostUserId: opts.hostUserId,
            syncState:
                opts.queue.length === 0
                    ? "idle"
                    : initialIsPlaying
                      ? "playing"
                      : "paused",
            playback: {
                queue: opts.queue,
                currentIndex: safeIndex,
                isPlaying: initialIsPlaying,
                positionMs: initialPositionMs,
                lastPositionUpdate: now,
                lastAppliedSnapshotServerTime: 0,
                stateVersion: 0,
            },
            members,
            readyUserIds: new Set(),
            readyTimeout: null,
            readyDeadlineMs: null,
            boundaryTimeout: null,
            lastActivity: now,
            createdAt: opts.createdAt,
            dirty: false,
            playbackAuthoritative: true,
        };

        this.groups.set(id, group);
        this.syncBoundaryWatchdog(group);
        log.info(
            `Created group ${id} "${opts.name}" hosted by ${opts.hostUsername}`,
        );
        return group;
    }

    get(groupId: string): GroupState | undefined {
        return this.groups.get(groupId);
    }

    has(groupId: string): boolean {
        return this.groups.has(groupId);
    }

    /** Remove group from memory (after DB cleanup). */
    remove(groupId: string): void {
        const group = this.groups.get(groupId);
        if (group) {
            this.clearReadyGateTimer(group);
            this.clearBoundaryWatchdogTimer(group);
        }
        this.groups.delete(groupId);
        log.debug(`Removed group ${groupId} from memory`);
    }

    /** Get all in-memory group IDs (for persist loop). */
    allGroupIds(): string[] {
        return Array.from(this.groups.keys());
    }

    /** Get groups that need DB persistence. */
    dirtyGroups(): GroupState[] {
        return Array.from(this.groups.values()).filter((g) => g.dirty);
    }

    /** Mark a group as persisted. */
    markClean(groupId: string): void {
        const group = this.groups.get(groupId);
        if (group) group.dirty = false;
    }

    // -----------------------------------------------------------------------
    // Socket connection tracking
    // -----------------------------------------------------------------------

    addSocket(groupId: string, userId: string, socketId: string): void {
        const group = this.groups.get(groupId);
        if (!group) return;
        const member = group.members.get(userId);
        if (!member) return;
        const wasConnected = member.socketIds.size > 0;
        member.socketIds.add(socketId);
        member.lastSeen = Date.now();
        group.lastActivity = member.lastSeen;

        // Broadcast presence transition so member connection dots update in real time.
        if (!wasConnected && member.socketIds.size > 0) {
            this.publishPresence(group, userId, true);
        }
    }

    removeSocket(groupId: string, userId: string, socketId: string): void {
        const group = this.groups.get(groupId);
        if (!group) return;
        const member = group.members.get(userId);
        if (!member) return;
        const wasConnected = member.socketIds.size > 0;
        member.socketIds.delete(socketId);
        group.lastActivity = Date.now();

        // Broadcast presence transition so member connection dots update in real time.
        if (wasConnected && member.socketIds.size === 0) {
            this.publishPresence(group, userId, false);

            // In waiting state, disconnected members should not block the gate.
            if (group.syncState === "waiting") {
                this.checkReadyGate(group);
            }
        }
    }

    /** How many sockets a user has in a group. */
    socketCount(groupId: string, userId: string): number {
        const member = this.groups.get(groupId)?.members.get(userId);
        return member?.socketIds.size ?? 0;
    }

    /** Total connected sockets in a group. */
    connectedMemberCount(groupId: string): number {
        const group = this.groups.get(groupId);
        if (!group) return 0;
        let count = 0;
        for (const m of group.members.values()) {
            if (m.socketIds.size > 0) count++;
        }
        return count;
    }

    // -----------------------------------------------------------------------
    // Member management
    // -----------------------------------------------------------------------

    addMember(
        groupId: string,
        userId: string,
        username: string,
        isHost: boolean = false,
    ): GroupSnapshot {
        const group = this.requireGroup(groupId);

        // If already a member, just update
        const existing = group.members.get(userId);
        if (existing) {
            existing.lastSeen = Date.now();
            if (isHost) group.hostUserId = userId;
            reconcileHostFlags(group.members, group.hostUserId);
            this.broadcastState(group);
            return this.snapshot(group);
        }

        if (isHost) group.hostUserId = userId;

        group.members.set(userId, {
            userId,
            username,
            isHost,
            joinedAt: new Date(),
            socketIds: new Set(),
            isReady: false,
            unavailableIndices: new Set(),
            lastSeen: Date.now(),
        });
        reconcileHostFlags(group.members, group.hostUserId);

        group.lastActivity = Date.now();
        group.dirty = true;

        log.info(`Member ${username} (${userId}) joined group ${groupId}`);
        this.callbacks?.onMemberJoined(groupId, { userId, username });
        this.broadcastState(group);
        return this.snapshot(group);
    }

    /** Apply exact committed membership and return sockets that lost membership. */
    applyCommittedMembership(
        groupId: string,
        members: GroupSnapshot["members"],
        hostUserId: string,
    ): string[] {
        const group = this.requireGroup(groupId);
        return applyExactCommittedMembership(
            group,
            members,
            hostUserId,
            Date.now(),
        );
    }

    removeMember(
        groupId: string,
        userId: string,
    ): { ended: boolean; newHostUserId?: string; newHostUsername?: string } {
        const group = this.requireGroup(groupId);
        const member = group.members.get(userId);
        if (!member) return { ended: false };

        const wasHost = member.isHost;
        const username = member.username;
        group.members.delete(userId);
        group.lastActivity = Date.now();
        group.dirty = true;

        // Clear from ready set if in waiting
        group.readyUserIds.delete(userId);

        if (group.members.size === 0) {
            log.info(`Group ${groupId} auto-disbanded: all members left`);
            this.endGroupInternal(group, "All members left");
            return { ended: true };
        }

        let newHostUserId: string | undefined;
        let newHostUsername: string | undefined;

        if (wasHost) {
            // Transfer host: alphabetical by username, then by join order
            const nextHost = selectHostSuccessor(group.members.values());
            if (nextHost) {
                // Demote all, promote new host
                for (const m of group.members.values()) m.isHost = false;
                nextHost.isHost = true;
                group.hostUserId = nextHost.userId;
                newHostUserId = nextHost.userId;
                newHostUsername = nextHost.username;
                log.info(
                    `Host transferred in group ${groupId}: ${username} -> ${nextHost.username}`,
                );
            }
        }

        this.callbacks?.onMemberLeft(groupId, {
            userId,
            username,
            newHostUserId,
            newHostUsername,
        });
        this.broadcastState(group);

        // If we were in a waiting gate, check if everyone remaining is ready
        if (group.syncState === "waiting") {
            this.checkReadyGate(group);
        }

        return { ended: false, newHostUserId, newHostUsername };
    }

    // -----------------------------------------------------------------------
    // Playback control
    // -----------------------------------------------------------------------

    play(groupId: string, userId: string): PlaybackDelta {
        const group = this.requireGroup(groupId);
        this.requireControl(group, userId);
        const waitingDelta = this.playbackDeltaIfWaiting(group);
        if (waitingDelta) return waitingDelta;

        const pb = group.playback;
        if (pb.queue.length === 0)
            throw new GroupError("INVALID", "Queue is empty");

        pb.isPlaying = true;
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.syncState = "playing";
        group.lastActivity = Date.now();
        group.dirty = true;
        this.syncBoundaryWatchdog(group);

        const delta = this.playbackDelta(group);
        this.callbacks?.onPlaybackDelta(groupId, delta);
        return delta;
    }

    pause(groupId: string, userId: string): PlaybackDelta {
        const group = this.requireGroup(groupId);
        this.requireControl(group, userId);
        const waitingDelta = this.playbackDeltaIfWaiting(group);
        if (waitingDelta) return waitingDelta;

        const pb = group.playback;
        this.clearBoundaryWatchdogTimer(group);
        // Freeze position
        pb.positionMs = computePosition(pb);
        pb.isPlaying = false;
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.syncState = "paused";
        group.lastActivity = Date.now();
        group.dirty = true;

        const delta = this.playbackDelta(group);
        this.callbacks?.onPlaybackDelta(groupId, delta);
        return delta;
    }

    seek(
        groupId: string,
        userId: string,
        positionMs: number,
        expectedStateVersion?: number,
    ): PlaybackDelta {
        const group = this.requireGroup(groupId);
        this.requireControl(group, userId);
        if (
            expectedStateVersion !== undefined &&
            expectedStateVersion !== group.playback.stateVersion
        ) {
            log.debug("Ignored seek with stale state version", {
                groupId,
                expectedStateVersion,
                currentStateVersion: group.playback.stateVersion,
            });
            return this.playbackDelta(group);
        }
        const waitingDelta = this.playbackDeltaIfWaiting(group);
        if (waitingDelta) return waitingDelta;

        const pb = group.playback;
        const track = pb.queue[pb.currentIndex];
        const maxMs = track ? track.duration * 1000 : 0;

        pb.positionMs = clamp(positionMs, 0, maxMs);
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.lastActivity = Date.now();
        group.dirty = true;
        this.syncBoundaryWatchdog(group);

        const delta = this.playbackDelta(group);
        this.callbacks?.onPlaybackDelta(groupId, delta);
        return delta;
    }

    /**
     * Change track (next / previous / jump to index).
     * This triggers the ready gate: all members must report ready before
     * synchronised playback begins.
     */
    setTrack(
        groupId: string,
        userId: string,
        index: number,
        autoPlay: boolean = true,
    ): { snapshot: GroupSnapshot; waiting: boolean } {
        const group = this.requireGroup(groupId);
        this.requireControl(group, userId);
        this.ensureNoPendingTrackChange(group);
        this.clearBoundaryWatchdogTimer(group);

        const pb = group.playback;
        if (pb.queue.length === 0)
            throw new GroupError("INVALID", "Queue is empty");

        const newIndex = clampIndex(index, pb.queue.length);
        const trackChanged = newIndex !== pb.currentIndex;

        pb.currentIndex = newIndex;
        pb.positionMs = 0;
        pb.isPlaying = false;
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.lastActivity = Date.now();
        group.dirty = true;

        const connectedCount = this.connectedMemberCount(groupId);

        // If only one person is connected or track didn't change, skip the gate
        if (connectedCount <= 1 || !trackChanged) {
            this.clearReadyGateState(group);
            if (autoPlay) {
                pb.isPlaying = true;
                pb.lastPositionUpdate = Date.now();
                group.syncState = "playing";
            } else {
                group.syncState = "paused";
            }
            this.syncBoundaryWatchdog(group);
            this.broadcastState(group);
            return { snapshot: this.snapshot(group), waiting: false };
        }

        // Enter ready gate
        this.enterReadyGate(group);

        this.callbacks?.onWaiting(groupId, {
            trackId: currentTrackId(pb),
            currentIndex: pb.currentIndex,
        });

        // Also broadcast full state so clients know the new track info
        this.broadcastState(group);
        return { snapshot: this.snapshot(group), waiting: true };
    }

    next(
        groupId: string,
        userId: string,
    ): { snapshot: GroupSnapshot; waiting: boolean } {
        const group = this.requireGroup(groupId);
        const pb = group.playback;
        const nextIndex =
            pb.currentIndex + 1 < pb.queue.length ? pb.currentIndex + 1 : 0;
        return this.setTrack(groupId, userId, nextIndex, true);
    }

    previous(
        groupId: string,
        userId: string,
    ): { snapshot: GroupSnapshot; waiting: boolean } {
        const group = this.requireGroup(groupId);
        const pb = group.playback;

        // If past 3 seconds, restart current track instead
        const currentPos = computePosition(pb);
        if (currentPos > 3000 && pb.queue.length > 0) {
            return this.setTrack(groupId, userId, pb.currentIndex, true);
        }

        const prevIndex =
            pb.currentIndex > 0 ? pb.currentIndex - 1 : pb.queue.length - 1;
        return this.setTrack(groupId, userId, prevIndex, true);
    }

    /**
     * A member reports that it has buffered the current track and is ready.
     * Returns true if all connected members are now ready (triggers play).
     */
    reportReady(groupId: string, userId: string): boolean {
        const group = this.requireGroup(groupId);
        if (group.syncState !== "waiting") return false;

        group.readyUserIds.add(userId);
        const member = group.members.get(userId);
        if (member) member.isReady = true;
        return this.checkReadyGate(group);
    }

    setUnavailableIndices(
        groupId: string,
        userId: string,
        unavailableIndices: Iterable<number>,
    ): void {
        const group = this.groups.get(groupId);
        if (!group) return;
        const member = group.members.get(userId);
        if (!member) return;

        member.unavailableIndices = new Set(unavailableIndices);
        member.lastSeen = Date.now();

        if (group.syncState === "waiting") {
            this.checkReadyGate(group);
        }
    }

    // -----------------------------------------------------------------------
    // Queue operations
    // -----------------------------------------------------------------------

    modifyQueue(
        groupId: string,
        userId: string,
        action: QueueAction,
    ): QueueDelta {
        const group = this.requireGroup(groupId);
        this.requireQueueEdit(group, userId);

        const pb = group.playback;
        let queueChanged = false;

        switch (action.action) {
            case "add": {
                const acceptedItems = truncateQueueItemsToAvailableCapacity(
                    pb.queue.length,
                    action.items,
                );
                if (acceptedItems.length === 0) {
                    return this.queueDelta(group);
                }
                pb.queue.push(...acceptedItems);
                // If queue was empty and we just added tracks, set up the first track
                if (pb.queue.length === acceptedItems.length) {
                    pb.currentIndex = 0;
                    group.syncState = "paused";
                }
                queueChanged = true;
                break;
            }
            case "insert-next": {
                const acceptedItems = truncateQueueItemsToAvailableCapacity(
                    pb.queue.length,
                    action.items,
                );
                if (acceptedItems.length === 0) {
                    return this.queueDelta(group);
                }
                const insertAt = pb.currentIndex + 1;
                pb.queue.splice(insertAt, 0, ...acceptedItems);
                // If queue was empty before, set up the first track
                if (pb.queue.length === acceptedItems.length) {
                    pb.currentIndex = 0;
                    group.syncState = "paused";
                }
                queueChanged = true;
                break;
            }
            case "remove": {
                if (action.index < 0 || action.index >= pb.queue.length) {
                    throw new GroupError("INVALID", "Invalid queue index");
                }

                pb.queue.splice(action.index, 1);

                if (pb.queue.length === 0) {
                    pb.currentIndex = 0;
                    pb.isPlaying = false;
                    pb.positionMs = 0;
                    pb.lastPositionUpdate = Date.now();
                    group.syncState = "idle";
                } else if (action.index < pb.currentIndex) {
                    pb.currentIndex--;
                } else if (action.index === pb.currentIndex) {
                    // Current track was removed — clamp and reset position
                    pb.currentIndex = clampIndex(
                        pb.currentIndex,
                        pb.queue.length,
                    );
                    pb.positionMs = 0;
                    pb.lastPositionUpdate = Date.now();
                }
                queueChanged = true;
                break;
            }
            case "reorder": {
                throw new GroupError(
                    "NOT_ALLOWED",
                    "Queue reordering is disabled in Listen Together",
                );
            }
            case "clear": {
                pb.queue = [];
                pb.currentIndex = 0;
                pb.isPlaying = false;
                pb.positionMs = 0;
                pb.lastPositionUpdate = Date.now();
                group.syncState = "idle";
                queueChanged = true;
                break;
            }
        }

        if (!queueChanged) {
            return this.queueDelta(group);
        }

        pb.stateVersion++;
        group.lastActivity = Date.now();
        group.dirty = true;
        this.syncBoundaryWatchdog(group);

        const delta = this.queueDelta(group);
        this.callbacks?.onQueueDelta(groupId, delta);
        return delta;
    }

    // -----------------------------------------------------------------------
    // End group
    // -----------------------------------------------------------------------

    endGroup(groupId: string, userId: string): void {
        const group = this.requireGroup(groupId);
        const member = group.members.get(userId);
        if (!member?.isHost) {
            throw new GroupError(
                "NOT_ALLOWED",
                "Only the host can end the group",
            );
        }
        this.endGroupInternal(group, "Host ended the group");
    }

    /** Force-end without permission check (for cleanup). */
    forceEnd(groupId: string, reason: string): void {
        const group = this.groups.get(groupId);
        if (!group) return;
        this.endGroupInternal(group, reason);
    }

    // -----------------------------------------------------------------------
    // Snapshots
    // -----------------------------------------------------------------------

    snapshot(group: GroupState): GroupSnapshot {
        const pb = group.playback;
        const serverTime = Date.now();
        pb.lastAppliedSnapshotServerTime = advanceSnapshotWatermark(
            pb.lastAppliedSnapshotServerTime,
            serverTime,
        );
        return {
            id: group.id,
            name: group.name,
            joinCode: group.joinCode,
            groupType: group.groupType,
            visibility: group.visibility,
            isActive: true,
            hostUserId: group.hostUserId,
            syncState: group.syncState,
            readyDeadlineMs:
                group.syncState === "waiting" ? group.readyDeadlineMs : null,
            readyUserIds: Array.from(group.readyUserIds),
            playback: {
                queue: pb.queue,
                currentIndex: pb.currentIndex,
                isPlaying: pb.isPlaying,
                positionMs: computePosition(pb),
                serverTime,
                stateVersion: pb.stateVersion,
                trackId: currentTrackId(pb),
            },
            members: snapshotMembers(group.members),
        };
    }

    snapshotById(groupId: string): GroupSnapshot | undefined {
        const group = this.groups.get(groupId);
        if (!group) return undefined;
        return this.snapshot(group);
    }

    /** Return a snapshot only when playback is safe to publish to peers. */
    snapshotForPublication(groupId: string): GroupSnapshot | undefined {
        const group = this.groups.get(groupId);
        if (!group?.playbackAuthoritative) return undefined;
        return this.snapshot(group);
    }

    /**
     * Apply a remotely-produced snapshot (from another backend replica) to keep
     * this pod's in-memory state aligned without re-emitting socket callbacks.
     */
    applyExternalSnapshot(snapshot: GroupSnapshot): void {
        const existing = this.groups.get(snapshot.id);
        const now = Date.now();
        const existingReadyDeadlineMs = existing?.readyDeadlineMs ?? null;
        if (existing) {
            // Timers close over old group objects; drop and re-arm on replacement.
            this.clearReadyGateTimer(existing);
            this.clearBoundaryWatchdogTimer(existing);
        }

        const rawQueue = Array.isArray(snapshot.playback?.queue)
            ? snapshot.playback.queue
            : [];
        const incomingQueue =
            rawQueue.length > MAX_QUEUE_SIZE
                ? rawQueue.slice(0, MAX_QUEUE_SIZE)
                : rawQueue;
        const incomingIndex = clampIndex(
            snapshot.playback?.currentIndex ?? 0,
            incomingQueue.length,
        );
        const incomingPositionMs = Math.max(
            0,
            snapshot.playback?.positionMs ?? 0,
        );
        const incomingServerTime = Math.max(
            0,
            snapshot.playback?.serverTime ?? now,
        );
        const incomingStateVersion = Math.max(
            0,
            snapshot.playback?.stateVersion ?? 0,
        );
        const incomingIsPlaying = Boolean(snapshot.playback?.isPlaying);
        const incomingReadyDeadlineMs =
            typeof snapshot.readyDeadlineMs === "number" &&
            Number.isFinite(snapshot.readyDeadlineMs)
                ? Math.max(0, snapshot.readyDeadlineMs)
                : null;
        const applyIncomingPlayback = shouldApplyIncomingPlayback(
            existing,
            incomingStateVersion,
            incomingServerTime,
        );
        const readyUserIds = new Set<string>(
            Array.isArray(snapshot.readyUserIds)
                ? snapshot.readyUserIds.filter(
                      (userId): userId is string => typeof userId === "string",
                  )
                : [],
        );
        if (
            existing &&
            incomingStateVersion <= existing.playback.stateVersion
        ) {
            for (const userId of existing.readyUserIds) {
                readyUserIds.add(userId);
            }
        }

        const members = mergeSnapshotMembers(
            snapshot.members ?? [],
            existing?.members,
            readyUserIds,
            now,
        );
        reconcileHostFlags(members, snapshot.hostUserId);

        const existingPlayback = existing?.playback;
        const lastAppliedSnapshotServerTime = advanceSnapshotWatermark(
            existingPlayback?.lastAppliedSnapshotServerTime ?? 0,
            incomingServerTime,
        );
        const playback: GroupPlayback =
            applyIncomingPlayback || !existingPlayback
                ? {
                      queue: incomingQueue,
                      currentIndex: incomingIndex,
                      isPlaying: incomingIsPlaying,
                      positionMs: compensateSnapshotPosition(
                          incomingPositionMs,
                          incomingServerTime,
                          now,
                          incomingIsPlaying,
                      ),
                      lastPositionUpdate: now,
                      lastAppliedSnapshotServerTime,
                      stateVersion: incomingStateVersion,
                  }
                : {
                      queue: existingPlayback.queue,
                      currentIndex: existingPlayback.currentIndex,
                      isPlaying: existingPlayback.isPlaying,
                      positionMs: existingPlayback.positionMs,
                      lastPositionUpdate: existingPlayback.lastPositionUpdate,
                      lastAppliedSnapshotServerTime,
                      stateVersion: existingPlayback.stateVersion,
                  };

        const syncState: GroupSyncState =
            applyIncomingPlayback || !existing
                ? snapshot.syncState
                : existing.syncState;
        const readyDeadlineMs =
            syncState === "waiting"
                ? applyIncomingPlayback || !existing
                    ? (incomingReadyDeadlineMs ?? now + READY_GATE_TIMEOUT_MS)
                    : (existingReadyDeadlineMs ?? now + READY_GATE_TIMEOUT_MS)
                : null;

        const group: GroupState = {
            id: snapshot.id,
            name: snapshot.name,
            joinCode: snapshot.joinCode,
            groupType: snapshot.groupType,
            visibility: snapshot.visibility,
            hostUserId: snapshot.hostUserId,
            syncState,
            playback,
            members,
            readyUserIds,
            readyTimeout: null,
            readyDeadlineMs,
            boundaryTimeout: null,
            lastActivity: now,
            createdAt: existing?.createdAt ?? new Date(),
            dirty: false,
            playbackAuthoritative: true,
        };

        this.groups.set(snapshot.id, group);
        /* istanbul ignore next -- branch mapping can attribute non-waiting path to the same source line */
        if (group.syncState === "waiting") {
            this.rearmReadyGateFromDeadline(group, readyDeadlineMs ?? now);
        } else {
            this.clearReadyGateState(group);
            this.syncBoundaryWatchdog(group);
        }
    }

    /** Resolve a due boundary watchdog after the socket layer acquires its lock. */
    handleBoundaryWatchdog(
        groupId: string,
        expectedIndex: number,
        expectedStateVersion: number,
    ): boolean {
        const group = this.groups.get(groupId);
        if (!group) return false;

        const pb = group.playback;
        if (
            !pb.isPlaying ||
            pb.currentIndex !== expectedIndex ||
            pb.stateVersion !== expectedStateVersion
        ) {
            return false;
        }

        const durationMs = currentTrackDurationMs(pb);
        if (durationMs === null) return false;
        if (
            computeUnclampedPosition(pb) <
            durationMs + BOUNDARY_WATCHDOG_GRACE_MS
        ) {
            this.syncBoundaryWatchdog(group);
            return false;
        }

        this.clearBoundaryWatchdogTimer(group);
        if (pb.currentIndex + 1 < pb.queue.length) {
            this.setTrack(groupId, group.hostUserId, pb.currentIndex + 1, true);
            return true;
        }

        this.pauseAtBoundary(group, durationMs);
        return true;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private requireGroup(groupId: string): GroupState {
        const group = this.groups.get(groupId);
        if (!group) throw new GroupError("NOT_FOUND", "Group not found");
        return group;
    }

    private requireControl(group: GroupState, userId: string): void {
        const member = group.members.get(userId);
        if (!member)
            throw new GroupError("NOT_MEMBER", "Not a member of this group");
        if (group.hostUserId !== userId) {
            throw new GroupError(
                "NOT_ALLOWED",
                "Only the host can control playback",
            );
        }
    }

    private requireQueueEdit(group: GroupState, userId: string): void {
        const member = group.members.get(userId);
        if (!member)
            throw new GroupError("NOT_MEMBER", "Not a member of this group");
    }

    private playbackDelta(group: GroupState): PlaybackDelta {
        const pb = group.playback;
        return {
            isPlaying: pb.isPlaying,
            positionMs: computePosition(pb),
            serverTime: Date.now(),
            stateVersion: pb.stateVersion,
            currentIndex: pb.currentIndex,
            trackId: currentTrackId(pb),
        };
    }

    private queueDelta(group: GroupState): QueueDelta {
        const pb = group.playback;
        return {
            queue: pb.queue,
            currentIndex: pb.currentIndex,
            trackId: currentTrackId(pb),
            stateVersion: pb.stateVersion,
        };
    }

    private broadcastState(
        group: GroupState,
        options?: StatePublicationOptions,
    ): void {
        const snapshot = this.snapshot(group);
        if (options) {
            this.callbacks?.onGroupState(group.id, snapshot, options);
            return;
        }
        this.callbacks?.onGroupState(group.id, snapshot);
    }

    private publishPresence(
        group: GroupState,
        userId: string,
        isConnected: boolean,
    ): void {
        if (group.playbackAuthoritative) {
            this.broadcastState(group, { synchronize: false });
            return;
        }
        this.callbacks?.onMemberPresence(group.id, { userId, isConnected });
    }

    private checkReadyGate(group: GroupState): boolean {
        if (group.syncState !== "waiting") return false;

        // Count connected members (with at least one socket)
        const connectedUserIds = new Set<string>();
        for (const m of group.members.values()) {
            if (m.socketIds.size > 0) connectedUserIds.add(m.userId);
        }

        // Check if all connected members are ready
        for (const uid of connectedUserIds) {
            const member = group.members.get(uid);
            const currentIndex = group.playback.currentIndex;
            if (member?.unavailableIndices?.has(currentIndex)) {
                group.readyUserIds.add(uid);
                member.isReady = true;
                continue;
            }
            if (!group.readyUserIds.has(uid)) return false;
        }

        // All ready — start playback!
        log.debug(
            `Ready gate passed for group ${group.id}: all ${connectedUserIds.size} members ready`,
        );
        this.forcePlay(group);
        return true;
    }

    private clearReadyGateTimer(group: GroupState): void {
        if (group.readyTimeout) {
            clearTimeout(group.readyTimeout);
        }
        group.readyTimeout = null;
        group.readyDeadlineMs = null;
    }

    private clearReadyGateState(group: GroupState): void {
        this.clearReadyGateTimer(group);
        group.readyUserIds.clear();
        for (const member of group.members.values()) {
            member.isReady = false;
        }
    }

    private clearBoundaryWatchdogTimer(group: GroupState): void {
        if (group.boundaryTimeout) {
            clearTimeout(group.boundaryTimeout);
        }
        group.boundaryTimeout = null;
    }

    private pauseAtBoundary(group: GroupState, durationMs: number): void {
        const now = Date.now();
        group.playback.positionMs = durationMs;
        group.playback.isPlaying = false;
        group.playback.lastPositionUpdate = now;
        group.playback.stateVersion++;
        group.syncState = "paused";
        group.lastActivity = now;
        group.dirty = true;
        this.broadcastState(group);
    }

    private syncBoundaryWatchdog(group: GroupState): void {
        this.clearBoundaryWatchdogTimer(group);
        if (!group.playback.isPlaying) return;

        const durationMs = currentTrackDurationMs(group.playback);
        if (durationMs === null) return;
        const waitMs = Math.max(
            0,
            durationMs +
                BOUNDARY_WATCHDOG_GRACE_MS -
                computeUnclampedPosition(group.playback),
        );
        const currentIndex = group.playback.currentIndex;
        const stateVersion = group.playback.stateVersion;
        const boundaryTimeout = setTimeout(() => {
            group.boundaryTimeout = null;
            if (this.groups.get(group.id) !== group) return;
            if (this.callbacks?.onBoundaryWatchdog) {
                this.callbacks.onBoundaryWatchdog(group.id, {
                    currentIndex,
                    stateVersion,
                });
                return;
            }
            this.handleBoundaryWatchdog(group.id, currentIndex, stateVersion);
        }, waitMs);
        group.boundaryTimeout = boundaryTimeout;
        if (typeof boundaryTimeout.unref === "function") {
            boundaryTimeout.unref();
        }
    }

    private ensureNoPendingTrackChange(group: GroupState): void {
        if (group.syncState === "waiting") {
            throw new GroupError(
                "CONFLICT",
                "Track change already in progress",
            );
        }
    }

    private playbackDeltaIfWaiting(group: GroupState): PlaybackDelta | null {
        // Keep ready-gate deterministic: ignore non-track controls while waiting.
        if (group.syncState !== "waiting") return null;
        return this.playbackDelta(group);
    }

    private armReadyGateTimer(group: GroupState, deadlineMs: number): void {
        this.clearReadyGateTimer(group);

        const now = Date.now();
        const safeDeadlineMs = Math.max(now, deadlineMs);
        const waitMs = Math.max(0, safeDeadlineMs - now);
        group.readyDeadlineMs = safeDeadlineMs;
        const readyTimeout = setTimeout(() => {
            group.readyTimeout = null;
            group.readyDeadlineMs = null;
            if (group.syncState === "waiting") {
                this.forcePlay(group);
            }
        }, waitMs);
        group.readyTimeout = readyTimeout;
        // Keep the gate timer referenced so process liveness cannot skip waiting-state resolution.
        if (typeof readyTimeout.ref === "function") {
            readyTimeout.ref();
        }
    }

    private enterReadyGate(group: GroupState): void {
        this.clearBoundaryWatchdogTimer(group);
        group.syncState = "waiting";
        group.readyUserIds.clear();
        for (const member of group.members.values()) {
            member.isReady = false;
        }
        this.armReadyGateTimer(group, Date.now() + READY_GATE_TIMEOUT_MS);
    }

    private rearmReadyGateFromDeadline(
        group: GroupState,
        deadlineMs: number,
    ): void {
        if (deadlineMs <= Date.now()) {
            this.forcePlay(group);
            return;
        }
        this.armReadyGateTimer(group, deadlineMs);
    }

    private forcePlay(group: GroupState): void {
        this.clearReadyGateState(group);

        const pb = group.playback;
        pb.isPlaying = true;
        pb.positionMs = 0;
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.syncState = "playing";
        group.dirty = true;
        this.syncBoundaryWatchdog(group);

        this.callbacks?.onPlayAt(group.id, {
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: pb.stateVersion,
        });

        // Also broadcast full state
        this.broadcastState(group);
    }

    private endGroupInternal(group: GroupState, reason: string): void {
        this.clearReadyGateState(group);
        this.clearBoundaryWatchdogTimer(group);

        group.playback.isPlaying = false;
        group.syncState = "idle";

        log.info(`Group ${group.id} ended: ${reason}`);
        this.callbacks?.onGroupEnded(group.id, reason);
        // Don't remove from memory yet — the service layer handles DB cleanup
        // and then calls manager.remove()
    }

    // -----------------------------------------------------------------------
    // Stale member cleanup
    // -----------------------------------------------------------------------

    /** Remove members who have no sockets and haven't been seen recently. */
    cleanupStaleMembers(groupId: string): string[] {
        const group = this.groups.get(groupId);
        if (!group) return [];

        const now = Date.now();
        const stale: string[] = [];

        for (const [userId, member] of group.members) {
            if (
                member.socketIds.size === 0 &&
                now - member.lastSeen > STALE_MEMBER_MS
            ) {
                stale.push(userId);
            }
        }

        if (stale.length > 0) {
            log.debug(
                `Cleaning up ${stale.length} stale members from group ${groupId}`,
            );
        }
        for (const userId of stale) {
            this.removeMember(groupId, userId);
        }

        return stale;
    }
}

// Export singleton
export const groupManager = new GroupManager();
