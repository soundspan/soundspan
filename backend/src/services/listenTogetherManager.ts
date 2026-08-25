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
import type {
    GroupMember,
    GroupPlayback,
    GroupSnapshot,
    GroupState,
    ManagerCallbacks,
    PersistedGroupMember,
    PlaybackDelta,
    QueueAction,
    QueueDelta,
    ShutdownPauseResult,
    StatePublicationOptions,
    SyncQueueItem,
} from "./listenTogetherTypes";
import { logger } from "../utils/logger";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import { GroupError } from "./listenTogetherGroupError";
import { buildExternalGroup } from "./listenTogetherExternalSnapshot";
import {
    computePosition,
    computeUnclampedPosition,
    currentTrackDurationMs,
    currentTrackId,
} from "./listenTogetherPlaybackPosition";
import {
    applyReadyGatePlayback,
    armReadyGateTimer,
    clearReadyGateState,
    clearReadyGateTimer,
    connectedMemberCount as countConnectedMembers,
    isExpectedReadyGate,
    readyConnectedMemberCount,
    resetReadyGateVotes,
} from "./listenTogetherReadyGate";
import {
    confirmGroupPublication,
    invalidateGroupPersistence,
    isGroupPersistenceEligible,
} from "./listenTogetherPersistenceState";
import {
    applyExactCommittedMembership,
    createGroupSnapshot,
    reconcileHostFlags,
    selectHostSuccessor,
} from "./listenTogetherSnapshot";

const log = logger.child("ListenTogetherManager");

export { GroupError } from "./listenTogetherGroupError";

interface HydratedGroupOptions {
    name: string;
    joinCode: string;
    groupType: "host-follower" | "collaborative";
    visibility: "public" | "private";
    hostUserId: string;
    membershipVersion?: number;
    queue: SyncQueueItem[];
    currentIndex: number;
    isPlaying: boolean;
    currentTimeMs: number;
    stateVersion: number;
    createdAt: Date;
    members: PersistedGroupMember[];
}

interface CreatedGroupOptions {
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

function addQueueItems(
    group: GroupState,
    items: SyncQueueItem[],
    insertNext: boolean,
): boolean {
    const playback = group.playback;
    const acceptedItems = truncateQueueItemsToAvailableCapacity(
        playback.queue.length,
        items,
    );
    if (acceptedItems.length === 0) return false;
    if (insertNext) {
        playback.queue.splice(playback.currentIndex + 1, 0, ...acceptedItems);
    } else {
        playback.queue.push(...acceptedItems);
    }
    if (playback.queue.length === acceptedItems.length) {
        playback.currentIndex = 0;
        group.syncState = "paused";
    }
    return true;
}

function removeQueueItem(group: GroupState, index: number): void {
    const playback = group.playback;
    if (index < 0 || index >= playback.queue.length) {
        throw new GroupError("INVALID", "Invalid queue index");
    }
    playback.queue.splice(index, 1);
    if (playback.queue.length === 0) {
        playback.currentIndex = 0;
        playback.isPlaying = false;
        playback.positionMs = 0;
        playback.lastPositionUpdate = Date.now();
        group.syncState = "idle";
        return;
    }
    if (index < playback.currentIndex) {
        playback.currentIndex -= 1;
        return;
    }
    if (index !== playback.currentIndex) return;
    playback.currentIndex = clampIndex(
        playback.currentIndex,
        playback.queue.length,
    );
    playback.positionMs = 0;
    playback.lastPositionUpdate = Date.now();
}

function clearQueue(group: GroupState): void {
    group.playback.queue = [];
    group.playback.currentIndex = 0;
    group.playback.isPlaying = false;
    group.playback.positionMs = 0;
    group.playback.lastPositionUpdate = Date.now();
    group.syncState = "idle";
}

function applyQueueAction(group: GroupState, action: QueueAction): boolean {
    switch (action.action) {
        case "add":
            return addQueueItems(group, action.items, false);
        case "insert-next":
            return addQueueItems(group, action.items, true);
        case "remove":
            removeQueueItem(group, action.index);
            return true;
        case "reorder":
            throw new GroupError(
                "NOT_ALLOWED",
                "Queue reordering is disabled in Listen Together",
            );
        case "clear":
            clearQueue(group);
            return true;
    }
}

function restoreMembers(
    members: PersistedGroupMember[],
    now: number,
): Map<string, GroupMember> {
    return new Map(
        members.map((member) => [
            member.userId,
            {
                userId: member.userId,
                username: member.username,
                isHost: member.isHost,
                joinedAt: member.joinedAt,
                socketIds: new Set<string>(),
                isReady: false,
                unavailableIndices: new Set<number>(),
                lastSeen: now,
            },
        ]),
    );
}

function buildHydratedGroup(
    id: string,
    opts: HydratedGroupOptions,
    queue: SyncQueueItem[],
    now: number,
): GroupState {
    return {
        id,
        name: opts.name,
        joinCode: opts.joinCode,
        groupType: opts.groupType,
        visibility: opts.visibility,
        hostUserId: opts.hostUserId,
        membershipVersion: Math.max(0, opts.membershipVersion ?? 0),
        syncState: opts.isPlaying
            ? "playing"
            : queue.length > 0
              ? "paused"
              : "idle",
        playback: {
            queue,
            currentIndex: clampIndex(opts.currentIndex, queue.length),
            isPlaying: false,
            positionMs: opts.currentTimeMs,
            lastPositionUpdate: now,
            lastAppliedSnapshotServerTime: 0,
            stateVersion: opts.stateVersion,
        },
        members: restoreMembers(opts.members, now),
        readyUserIds: new Set(),
        readyTimeout: null,
        readyDeadlineMs: null,
        boundaryTimeout: null,
        lastActivity: now,
        createdAt: opts.createdAt,
        dirty: false,
        playbackAuthoritative: false,
        persistenceValid: true,
        normalizedFromPlaying: opts.isPlaying,
        lastPublishedStateVersion: opts.stateVersion,
    };
}

function buildCreatedGroup(
    id: string,
    opts: CreatedGroupOptions,
    now: number,
): GroupState {
    const currentIndex = clampIndex(opts.currentIndex ?? 0, opts.queue.length);
    const maxTrackMs = (opts.queue[currentIndex]?.duration ?? 0) * 1000;
    const isPlaying = Boolean(opts.isPlaying && opts.queue.length > 0);
    const host: GroupMember = {
        userId: opts.hostUserId,
        username: opts.hostUsername,
        isHost: true,
        joinedAt: opts.createdAt,
        socketIds: new Set(),
        isReady: false,
        unavailableIndices: new Set(),
        lastSeen: now,
    };
    return {
        id,
        name: opts.name,
        joinCode: opts.joinCode,
        groupType: opts.groupType,
        visibility: opts.visibility,
        hostUserId: opts.hostUserId,
        membershipVersion: 0,
        syncState:
            opts.queue.length === 0 ? "idle" : isPlaying ? "playing" : "paused",
        playback: {
            queue: opts.queue,
            currentIndex,
            isPlaying,
            positionMs: clamp(opts.currentTimeMs ?? 0, 0, maxTrackMs),
            lastPositionUpdate: now,
            lastAppliedSnapshotServerTime: 0,
            stateVersion: 0,
        },
        members: new Map([[opts.hostUserId, host]]),
        readyUserIds: new Set(),
        readyTimeout: null,
        readyDeadlineMs: null,
        boundaryTimeout: null,
        lastActivity: now,
        createdAt: opts.createdAt,
        dirty: false,
        playbackAuthoritative: true,
        persistenceValid: true,
        normalizedFromPlaying: false,
        lastPublishedStateVersion: 0,
    };
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
    hydrate(id: string, opts: HydratedGroupOptions): GroupState {
        const queue =
            opts.queue.length > MAX_QUEUE_SIZE
                ? opts.queue.slice(0, MAX_QUEUE_SIZE)
                : opts.queue;
        const now = Date.now();
        const group = buildHydratedGroup(id, opts, queue, now);
        this.groups.set(id, group);
        log.debug(
            `Hydrated group ${id} with ${opts.members.length} members, queue=${queue.length}`,
        );
        return group;
    }

    /** Create a brand-new group (after DB row is created). */
    create(id: string, opts: CreatedGroupOptions): GroupState {
        const now = Date.now();
        const group = buildCreatedGroup(id, opts, now);
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
            clearReadyGateTimer(group);
            this.clearBoundaryWatchdogTimer(group);
        }
        this.groups.delete(groupId);
        log.debug(`Removed group ${groupId} from memory`);
    }

    /** Evict one poisoned local copy and make captured references unpersistable. */
    invalidate(groupId: string): void {
        const group = this.groups.get(groupId);
        if (!group) return;
        invalidateGroupPersistence(group);
        this.remove(groupId);
    }

    /** Get all in-memory group IDs (for persist loop). */
    allGroupIds(): string[] {
        return Array.from(this.groups.keys());
    }

    /** Get groups that need DB persistence. */
    dirtyGroups(): GroupState[] {
        return Array.from(this.groups.values()).filter(
            isGroupPersistenceEligible,
        );
    }

    /** Mark the current version safe for periodic PostgreSQL persistence. */
    markPublicationConfirmed(groupId: string): void {
        const group = this.groups.get(groupId);
        if (group) confirmGroupPublication(group);
    }

    /** Mark only the still-current captured object/version as persisted. */
    markClean(
        groupId: string,
        capturedGroup: GroupState,
        persistedStateVersion: number,
    ): void {
        const group = this.groups.get(groupId);
        if (
            group === capturedGroup &&
            group.persistenceValid &&
            group.playback.stateVersion === persistedStateVersion
        ) {
            group.dirty = false;
        }
    }

    // -----------------------------------------------------------------------
    // Socket connection tracking
    // -----------------------------------------------------------------------

    hasMember(groupId: string, userId: string): boolean {
        return this.groups.get(groupId)?.members.has(userId) ?? false;
    }

    addSocket(groupId: string, userId: string, socketId: string): boolean {
        const group = this.groups.get(groupId);
        if (!group) return false;
        const member = group.members.get(userId);
        if (!member) return false;
        const wasConnected = member.socketIds.size > 0;
        member.socketIds.add(socketId);
        member.lastSeen = Date.now();
        group.lastActivity = member.lastSeen;

        // Broadcast presence transition so member connection dots update in real time.
        if (!wasConnected && member.socketIds.size > 0) {
            this.publishPresence(group, userId, true);
        }
        return true;
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

    /** Drop revoked local membership without producing a new publication. */
    evictLocalMember(groupId: string, userId: string): void {
        const group = this.groups.get(groupId);
        const member = group?.members.get(userId);
        if (!group || !member) return;
        if (group.hostUserId === userId) {
            this.invalidate(groupId);
            return;
        }
        group.members.delete(userId);
        group.readyUserIds.delete(userId);
        group.lastActivity = Date.now();
    }

    /** How many sockets a user has in a group. */
    socketCount(groupId: string, userId: string): number {
        const member = this.groups.get(groupId)?.members.get(userId);
        return member?.socketIds.size ?? 0;
    }

    /** Total connected sockets in a group. */
    connectedMemberCount(groupId: string): number {
        const group = this.groups.get(groupId);
        return group ? countConnectedMembers(group) : 0;
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
        membershipVersion?: number,
    ): string[] {
        const group = this.requireGroup(groupId);
        if (
            membershipVersion !== undefined &&
            membershipVersion < group.membershipVersion
        ) {
            return [];
        }
        const revokedSocketIds = applyExactCommittedMembership(
            group,
            members,
            hostUserId,
            Date.now(),
        );
        if (membershipVersion !== undefined) {
            group.membershipVersion = Math.max(
                group.membershipVersion,
                membershipVersion,
            );
        }
        return revokedSocketIds;
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

    play(
        groupId: string,
        userId: string,
        fence?: GroupMutationFence,
    ): PlaybackDelta {
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
        this.callbacks?.onPlaybackDelta(groupId, delta, fence);
        return delta;
    }

    pause(
        groupId: string,
        userId: string,
        fence?: GroupMutationFence,
    ): PlaybackDelta {
        const group = this.requireGroup(groupId);
        this.requireControl(group, userId);
        const waitingDelta = this.playbackDeltaIfWaiting(group);
        if (waitingDelta) return waitingDelta;

        this.applyPauseTransition(group);

        const delta = this.playbackDelta(group);
        this.callbacks?.onPlaybackDelta(groupId, delta, fence);
        return delta;
    }

    seek(
        groupId: string,
        userId: string,
        positionMs: number,
        expectedStateVersion?: number,
        fence?: GroupMutationFence,
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
        this.callbacks?.onPlaybackDelta(groupId, delta, fence);
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
        fence?: GroupMutationFence,
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
            clearReadyGateState(group);
            if (autoPlay) {
                pb.isPlaying = true;
                pb.lastPositionUpdate = Date.now();
                group.syncState = "playing";
            } else {
                group.syncState = "paused";
            }
            this.syncBoundaryWatchdog(group);
            this.broadcastState(group, undefined, fence);
            return { snapshot: this.snapshot(group), waiting: false };
        }

        // Enter ready gate
        this.enterReadyGate(group);

        this.callbacks?.onWaiting(
            groupId,
            {
                trackId: currentTrackId(pb),
                currentIndex: pb.currentIndex,
            },
            fence,
        );

        // Also broadcast full state so clients know the new track info
        this.broadcastState(group, undefined, fence);
        return { snapshot: this.snapshot(group), waiting: true };
    }

    next(
        groupId: string,
        userId: string,
        fence?: GroupMutationFence,
    ): { snapshot: GroupSnapshot; waiting: boolean } {
        const group = this.requireGroup(groupId);
        const pb = group.playback;
        const nextIndex =
            pb.currentIndex + 1 < pb.queue.length ? pb.currentIndex + 1 : 0;
        return this.setTrack(groupId, userId, nextIndex, true, fence);
    }

    previous(
        groupId: string,
        userId: string,
        fence?: GroupMutationFence,
    ): { snapshot: GroupSnapshot; waiting: boolean } {
        const group = this.requireGroup(groupId);
        const pb = group.playback;

        // If past 3 seconds, restart current track instead
        const currentPos = computePosition(pb);
        if (currentPos > 3000 && pb.queue.length > 0) {
            return this.setTrack(groupId, userId, pb.currentIndex, true, fence);
        }

        const prevIndex =
            pb.currentIndex > 0 ? pb.currentIndex - 1 : pb.queue.length - 1;
        return this.setTrack(groupId, userId, prevIndex, true, fence);
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
        fence?: GroupMutationFence,
    ): QueueDelta {
        const group = this.requireGroup(groupId);
        this.requireQueueEdit(group, userId);

        if (!applyQueueAction(group, action)) return this.queueDelta(group);
        group.playback.stateVersion += 1;
        group.lastActivity = Date.now();
        group.dirty = true;
        this.syncBoundaryWatchdog(group);

        const delta = this.queueDelta(group);
        this.callbacks?.onQueueDelta(groupId, delta, fence);
        return delta;
    }

    /** Apply the normal pause state transition without manager fanout. */
    pauseForShutdown(groupId: string): ShutdownPauseResult | undefined {
        const group = this.groups.get(groupId);
        if (!group) return undefined;
        const paused = group.playback.isPlaying || group.normalizedFromPlaying;
        if (paused) this.applyPauseTransition(group);
        return { group, snapshot: this.snapshot(group), paused };
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
        return createGroupSnapshot(group, Date.now());
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
        if (existing) {
            clearReadyGateTimer(existing);
            this.clearBoundaryWatchdogTimer(existing);
        }
        const group = buildExternalGroup(
            snapshot,
            existing,
            now,
            MAX_QUEUE_SIZE,
            READY_GATE_TIMEOUT_MS,
        );
        this.groups.set(snapshot.id, group);
        /* istanbul ignore next -- branch mapping can attribute non-waiting path to the same source line */
        if (group.syncState === "waiting") {
            this.rearmReadyGateFromDeadline(
                group,
                group.readyDeadlineMs ?? now,
            );
        } else {
            clearReadyGateState(group);
            this.syncBoundaryWatchdog(group);
        }
    }

    /** Resolve a due boundary watchdog after the socket layer acquires its lock. */
    handleBoundaryWatchdog(
        groupId: string,
        expectedIndex: number,
        expectedStateVersion: number,
        fence?: GroupMutationFence,
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
            this.setTrack(
                groupId,
                group.hostUserId,
                pb.currentIndex + 1,
                true,
                fence,
            );
            return true;
        }

        this.pauseAtBoundary(group, durationMs, fence);
        return true;
    }

    /** Complete one still-current ready gate after the socket layer locks it. */
    handleReadyGateCompletion(
        groupId: string,
        expectedIndex: number,
        expectedStateVersion: number,
        fence?: GroupMutationFence,
    ): boolean {
        const group = this.groups.get(groupId);
        if (!isExpectedReadyGate(group, expectedIndex, expectedStateVersion))
            return false;
        this.forcePlay(group, fence);
        return true;
    }

    /** Re-arm one still-current ready gate after bounded lock contention. */
    rearmReadyGateCompletion(
        groupId: string,
        expectedIndex: number,
        expectedStateVersion: number,
        delayMs: number,
    ): boolean {
        const group = this.groups.get(groupId);
        if (!isExpectedReadyGate(group, expectedIndex, expectedStateVersion))
            return false;
        this.armReadyGateTimer(group, Date.now() + Math.max(1, delayMs));
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
        fence?: GroupMutationFence,
    ): void {
        const snapshot = this.snapshot(group);
        if (options) {
            if (fence) {
                this.callbacks?.onGroupState(
                    group.id,
                    snapshot,
                    options,
                    fence,
                );
                return;
            }
            this.callbacks?.onGroupState(group.id, snapshot, options);
            return;
        }
        if (fence) {
            this.callbacks?.onGroupState(group.id, snapshot, undefined, fence);
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
        const connectedCount = readyConnectedMemberCount(group);
        if (connectedCount === null) return false;
        log.debug(
            `Ready gate passed for group ${group.id}: all ${connectedCount} members ready`,
        );
        this.requestReadyGateCompletion(group);
        return true;
    }

    private requestReadyGateCompletion(group: GroupState): void {
        const data = {
            currentIndex: group.playback.currentIndex,
            stateVersion: group.playback.stateVersion,
        };
        if (this.callbacks) {
            this.callbacks.onReadyGateCompletion(group.id, data);
            return;
        }
        this.handleReadyGateCompletion(
            group.id,
            data.currentIndex,
            data.stateVersion,
        );
    }

    private clearBoundaryWatchdogTimer(group: GroupState): void {
        if (group.boundaryTimeout) {
            clearTimeout(group.boundaryTimeout);
        }
        group.boundaryTimeout = null;
    }

    private pauseAtBoundary(
        group: GroupState,
        durationMs: number,
        fence?: GroupMutationFence,
    ): void {
        const now = Date.now();
        group.playback.positionMs = durationMs;
        group.playback.isPlaying = false;
        group.playback.lastPositionUpdate = now;
        group.playback.stateVersion++;
        group.syncState = "paused";
        group.lastActivity = now;
        group.dirty = true;
        this.broadcastState(group, undefined, fence);
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

    private applyPauseTransition(group: GroupState): void {
        const now = Date.now();
        this.clearBoundaryWatchdogTimer(group);
        group.playback.positionMs = computePosition(group.playback);
        group.playback.isPlaying = false;
        group.playback.lastPositionUpdate = now;
        group.playback.stateVersion += 1;
        group.normalizedFromPlaying = false;
        group.syncState = group.playback.queue.length > 0 ? "paused" : "idle";
        group.lastActivity = now;
        group.dirty = true;
    }

    private armReadyGateTimer(group: GroupState, deadlineMs: number): void {
        armReadyGateTimer(group, deadlineMs, () => {
            if (group.syncState === "waiting")
                this.requestReadyGateCompletion(group);
        });
    }

    private enterReadyGate(group: GroupState): void {
        this.clearBoundaryWatchdogTimer(group);
        group.syncState = "waiting";
        resetReadyGateVotes(group);
        this.armReadyGateTimer(group, Date.now() + READY_GATE_TIMEOUT_MS);
    }

    private rearmReadyGateFromDeadline(
        group: GroupState,
        deadlineMs: number,
    ): void {
        if (deadlineMs <= Date.now()) {
            this.requestReadyGateCompletion(group);
            return;
        }
        this.armReadyGateTimer(group, deadlineMs);
    }

    private forcePlay(group: GroupState, fence?: GroupMutationFence): void {
        applyReadyGatePlayback(group, Date.now());
        const pb = group.playback;
        this.syncBoundaryWatchdog(group);

        this.callbacks?.onPlayAt(
            group.id,
            {
                positionMs: 0,
                serverTime: Date.now(),
                stateVersion: pb.stateVersion,
            },
            fence,
        );

        // Also broadcast full state
        this.broadcastState(group, undefined, fence);
    }

    private endGroupInternal(group: GroupState, reason: string): void {
        clearReadyGateState(group);
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
