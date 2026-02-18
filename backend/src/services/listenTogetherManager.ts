/**
 * In-memory group state manager for Listen Together.
 *
 * This is the "hot path" — play, pause, seek, next, prev, queue mutations all
 * happen here with zero database calls.  PostgreSQL is only touched on
 * create / join / leave / discover (cold path) and via periodic persistence.
 *
 * Design references: Jellyfin SyncPlay, Syncplay, Synctube.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncQueueItem {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
}

export interface GroupMember {
    userId: string;
    username: string;
    isHost: boolean;
    joinedAt: Date;
    socketIds: Set<string>;
    isReady: boolean;
    lastSeen: number; // Date.now()
}

export interface GroupPlayback {
    queue: SyncQueueItem[];
    currentIndex: number;
    isPlaying: boolean;
    /** Track position (ms) at the moment captured by `lastPositionUpdate`. */
    positionMs: number;
    /** Date.now() when `positionMs` was last written. */
    lastPositionUpdate: number;
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
    lastActivity: number; // Date.now()
    createdAt: Date;
    /** True when in-memory state has diverged from DB and needs persisting. */
    dirty: boolean;
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
    | { action: "remove"; index: number }
    | { action: "reorder"; fromIndex: number; toIndex: number }
    | { action: "clear" };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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

/** Compute the "live" position in ms, accounting for elapsed time. */
function computePosition(pb: GroupPlayback): number {
    if (!pb.isPlaying) return pb.positionMs;
    const elapsed = Date.now() - pb.lastPositionUpdate;
    return pb.positionMs + Math.max(elapsed, 0);
}

function currentTrackId(pb: GroupPlayback): string | null {
    return pb.queue[pb.currentIndex]?.id ?? null;
}

/**
 * Determine whether incoming playback payload should overwrite local playback.
 *
 * Rules:
 * - higher stateVersion always wins
 * - lower stateVersion is stale
 * - equal stateVersion uses serverTime as tie-breaker to prevent time rewind
 */
function shouldApplyIncomingPlayback(
    existing: GroupState | undefined,
    incomingStateVersion: number,
    incomingServerTime: number
): boolean {
    if (!existing) return true;

    const currentStateVersion = existing.playback.stateVersion;
    if (incomingStateVersion > currentStateVersion) return true;
    if (incomingStateVersion < currentStateVersion) return false;

    return incomingServerTime >= existing.playback.lastPositionUpdate;
}

/** Max time to wait for all members to report ready (ms). */
const READY_GATE_TIMEOUT_MS = 8_000;

/** How long before a member with no sockets is considered stale (ms). */
const STALE_MEMBER_MS = 60_000;

// ---------------------------------------------------------------------------
// GroupManager singleton
// ---------------------------------------------------------------------------

/**
 * Callback interface so the manager can notify the socket layer without
 * depending on Socket.IO directly.
 */
export interface ManagerCallbacks {
    onGroupState(groupId: string, snapshot: GroupSnapshot): void;
    onPlaybackDelta(groupId: string, delta: PlaybackDelta): void;
    onQueueDelta(groupId: string, delta: QueueDelta): void;
    onWaiting(groupId: string, data: { trackId: string | null; currentIndex: number }): void;
    onPlayAt(groupId: string, data: { positionMs: number; serverTime: number; stateVersion: number }): void;
    onMemberJoined(groupId: string, member: { userId: string; username: string }): void;
    onMemberLeft(groupId: string, data: { userId: string; username: string; newHostUserId?: string; newHostUsername?: string }): void;
    onGroupEnded(groupId: string, reason: string): void;
}

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
            members: Array<{ userId: string; username: string; isHost: boolean; joinedAt: Date }>;
        },
    ): GroupState {
        const safeIndex = clampIndex(opts.currentIndex, opts.queue.length);
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
            syncState: opts.isPlaying ? "playing" : opts.queue.length > 0 ? "paused" : "idle",
            playback: {
                queue: opts.queue,
                currentIndex: safeIndex,
                isPlaying: false, // Always start paused after hydration (no one is connected yet)
                positionMs: opts.currentTimeMs,
                lastPositionUpdate: now,
                stateVersion: opts.stateVersion,
            },
            members,
            readyUserIds: new Set(),
            readyTimeout: null,
            lastActivity: now,
            createdAt: opts.createdAt,
            dirty: false,
        };

        this.groups.set(id, group);
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
        const initialIsPlaying = Boolean(opts.isPlaying && opts.queue.length > 0);

        const members = new Map<string, GroupMember>();
        members.set(opts.hostUserId, {
            userId: opts.hostUserId,
            username: opts.hostUsername,
            isHost: true,
            joinedAt: opts.createdAt,
            socketIds: new Set(),
            isReady: false,
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
                stateVersion: 0,
            },
            members,
            readyUserIds: new Set(),
            readyTimeout: null,
            lastActivity: now,
            createdAt: opts.createdAt,
            dirty: false,
        };

        this.groups.set(id, group);
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
        if (group?.readyTimeout) clearTimeout(group.readyTimeout);
        this.groups.delete(groupId);
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
            this.broadcastState(group);
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
            this.broadcastState(group);

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

    addMember(groupId: string, userId: string, username: string): GroupSnapshot {
        const group = this.requireGroup(groupId);

        // If already a member, just update
        const existing = group.members.get(userId);
        if (existing) {
            existing.lastSeen = Date.now();
            this.broadcastState(group);
            return this.snapshot(group);
        }

        group.members.set(userId, {
            userId,
            username,
            isHost: false,
            joinedAt: new Date(),
            socketIds: new Set(),
            isReady: false,
            lastSeen: Date.now(),
        });

        group.lastActivity = Date.now();
        group.dirty = true;

        this.callbacks?.onMemberJoined(groupId, { userId, username });
        this.broadcastState(group);
        return this.snapshot(group);
    }

    removeMember(groupId: string, userId: string): { ended: boolean; newHostUserId?: string; newHostUsername?: string } {
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
            // Auto-disband
            this.endGroupInternal(group, "All members left");
            return { ended: true };
        }

        let newHostUserId: string | undefined;
        let newHostUsername: string | undefined;

        if (wasHost) {
            // Transfer host: alphabetical by username, then by join order
            const candidates = Array.from(group.members.values()).sort((a, b) => {
                const nameComp = a.username.localeCompare(b.username, undefined, {
                    sensitivity: "accent",
                });
                if (nameComp !== 0) return nameComp;
                return a.joinedAt.getTime() - b.joinedAt.getTime();
            });

            const nextHost = candidates[0];
            if (nextHost) {
                // Demote all, promote new host
                for (const m of group.members.values()) m.isHost = false;
                nextHost.isHost = true;
                group.hostUserId = nextHost.userId;
                newHostUserId = nextHost.userId;
                newHostUsername = nextHost.username;
            }
        }

        this.callbacks?.onMemberLeft(groupId, { userId, username, newHostUserId, newHostUsername });
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

        const pb = group.playback;
        if (pb.queue.length === 0) throw new GroupError("INVALID", "Queue is empty");

        pb.isPlaying = true;
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.syncState = "playing";
        group.lastActivity = Date.now();
        group.dirty = true;

        const delta = this.playbackDelta(group);
        this.callbacks?.onPlaybackDelta(groupId, delta);
        return delta;
    }

    pause(groupId: string, userId: string): PlaybackDelta {
        const group = this.requireGroup(groupId);
        this.requireControl(group, userId);

        const pb = group.playback;
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

    seek(groupId: string, userId: string, positionMs: number): PlaybackDelta {
        const group = this.requireGroup(groupId);
        this.requireControl(group, userId);

        const pb = group.playback;
        const track = pb.queue[pb.currentIndex];
        const maxMs = track ? track.duration * 1000 : 0;

        pb.positionMs = clamp(positionMs, 0, maxMs);
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.lastActivity = Date.now();
        group.dirty = true;

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
        if (group.syncState === "waiting") {
            throw new GroupError(
                "CONFLICT",
                "Track change already in progress"
            );
        }

        const pb = group.playback;
        if (pb.queue.length === 0) throw new GroupError("INVALID", "Queue is empty");

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
            if (autoPlay) {
                pb.isPlaying = true;
                pb.lastPositionUpdate = Date.now();
                group.syncState = "playing";
            } else {
                group.syncState = "paused";
            }
            this.broadcastState(group);
            return { snapshot: this.snapshot(group), waiting: false };
        }

        // Enter ready gate
        group.syncState = "waiting";
        group.readyUserIds.clear();

        // Clear any existing timeout
        if (group.readyTimeout) clearTimeout(group.readyTimeout);

        // Set timeout: if not everyone is ready in time, start anyway
        group.readyTimeout = setTimeout(() => {
            group.readyTimeout = null;
            if (group.syncState === "waiting") {
                this.forcePlay(group);
            }
        }, READY_GATE_TIMEOUT_MS);

        this.callbacks?.onWaiting(groupId, {
            trackId: currentTrackId(pb),
            currentIndex: pb.currentIndex,
        });

        // Also broadcast full state so clients know the new track info
        this.broadcastState(group);
        return { snapshot: this.snapshot(group), waiting: true };
    }

    next(groupId: string, userId: string): { snapshot: GroupSnapshot; waiting: boolean } {
        const group = this.requireGroup(groupId);
        const pb = group.playback;
        const nextIndex = pb.currentIndex + 1 < pb.queue.length ? pb.currentIndex + 1 : 0;
        return this.setTrack(groupId, userId, nextIndex, true);
    }

    previous(groupId: string, userId: string): { snapshot: GroupSnapshot; waiting: boolean } {
        const group = this.requireGroup(groupId);
        const pb = group.playback;

        // If past 3 seconds, restart current track instead
        const currentPos = computePosition(pb);
        if (currentPos > 3000 && pb.queue.length > 0) {
            return this.setTrack(groupId, userId, pb.currentIndex, true);
        }

        const prevIndex = pb.currentIndex > 0 ? pb.currentIndex - 1 : pb.queue.length - 1;
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
        return this.checkReadyGate(group);
    }

    // -----------------------------------------------------------------------
    // Queue operations
    // -----------------------------------------------------------------------

    modifyQueue(groupId: string, userId: string, action: QueueAction): QueueDelta {
        const group = this.requireGroup(groupId);
        this.requireQueueEdit(group, userId);

        const pb = group.playback;

        switch (action.action) {
            case "add": {
                pb.queue.push(...action.items);
                // If queue was empty and we just added tracks, set up the first track
                if (pb.queue.length === action.items.length) {
                    pb.currentIndex = 0;
                    group.syncState = "paused";
                }
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
                    pb.currentIndex = clampIndex(pb.currentIndex, pb.queue.length);
                    pb.positionMs = 0;
                    pb.lastPositionUpdate = Date.now();
                }
                break;
            }
            case "reorder": {
                throw new GroupError("NOT_ALLOWED", "Queue reordering is disabled in Listen Together");
            }
            case "clear": {
                pb.queue = [];
                pb.currentIndex = 0;
                pb.isPlaying = false;
                pb.positionMs = 0;
                pb.lastPositionUpdate = Date.now();
                group.syncState = "idle";
                break;
            }
        }

        pb.stateVersion++;
        group.lastActivity = Date.now();
        group.dirty = true;

        const delta: QueueDelta = {
            queue: pb.queue,
            currentIndex: pb.currentIndex,
            trackId: currentTrackId(pb),
            stateVersion: pb.stateVersion,
        };

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
            throw new GroupError("NOT_ALLOWED", "Only the host can end the group");
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
        return {
            id: group.id,
            name: group.name,
            joinCode: group.joinCode,
            groupType: group.groupType,
            visibility: group.visibility,
            isActive: true,
            hostUserId: group.hostUserId,
            syncState: group.syncState,
            playback: {
                queue: pb.queue,
                currentIndex: pb.currentIndex,
                isPlaying: pb.isPlaying,
                positionMs: computePosition(pb),
                serverTime: Date.now(),
                stateVersion: pb.stateVersion,
                trackId: currentTrackId(pb),
            },
            members: Array.from(group.members.values())
                .sort((a, b) => {
                    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
                    return a.joinedAt.getTime() - b.joinedAt.getTime();
                })
                .map((m) => ({
                    userId: m.userId,
                    username: m.username,
                    isHost: m.isHost,
                    joinedAt: m.joinedAt.toISOString(),
                    isConnected: m.socketIds.size > 0,
                })),
        };
    }

    snapshotById(groupId: string): GroupSnapshot | undefined {
        const group = this.groups.get(groupId);
        if (!group) return undefined;
        return this.snapshot(group);
    }

    /**
     * Apply a remotely-produced snapshot (from another backend replica) to keep
     * this pod's in-memory state aligned without re-emitting socket callbacks.
     */
    applyExternalSnapshot(snapshot: GroupSnapshot): void {
        const existing = this.groups.get(snapshot.id);
        const now = Date.now();

        const incomingQueue = Array.isArray(snapshot.playback?.queue)
            ? snapshot.playback.queue
            : [];
        const incomingIndex = clampIndex(
            snapshot.playback?.currentIndex ?? 0,
            incomingQueue.length
        );
        const incomingPositionMs = Math.max(0, snapshot.playback?.positionMs ?? 0);
        const incomingServerTime = Math.max(0, snapshot.playback?.serverTime ?? now);
        const incomingStateVersion = Math.max(0, snapshot.playback?.stateVersion ?? 0);
        const incomingIsPlaying = Boolean(snapshot.playback?.isPlaying);
        const applyIncomingPlayback = shouldApplyIncomingPlayback(
            existing,
            incomingStateVersion,
            incomingServerTime
        );

        const members = new Map<string, GroupMember>();
        for (const member of snapshot.members ?? []) {
            const existingMember = existing?.members.get(member.userId);
            members.set(member.userId, {
                userId: member.userId,
                username: member.username,
                isHost: Boolean(member.isHost),
                joinedAt: new Date(member.joinedAt),
                // Preserve local socket presence for users connected to this pod.
                socketIds: existingMember?.socketIds ?? new Set<string>(),
                isReady: false,
                lastSeen: now,
            });
        }

        const existingPlayback = existing?.playback;
        const playback: GroupPlayback = applyIncomingPlayback || !existingPlayback
            ? {
                  queue: incomingQueue,
                  currentIndex: incomingIndex,
                  isPlaying: incomingIsPlaying,
                  positionMs: incomingPositionMs,
                  // Preserve server-relative elapsed playback behavior.
                  lastPositionUpdate:
                      incomingIsPlaying && incomingServerTime > 0
                          ? incomingServerTime
                          : now,
                  stateVersion: incomingStateVersion,
              }
            : {
                  queue: existingPlayback.queue,
                  currentIndex: existingPlayback.currentIndex,
                  isPlaying: existingPlayback.isPlaying,
                  positionMs: existingPlayback.positionMs,
                  lastPositionUpdate: existingPlayback.lastPositionUpdate,
                  stateVersion: existingPlayback.stateVersion,
              };

        const syncState: GroupSyncState =
            applyIncomingPlayback || !existing
                ? snapshot.syncState
                : existing.syncState;

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
            readyUserIds: new Set<string>(),
            readyTimeout: existing?.readyTimeout ?? null,
            lastActivity: now,
            createdAt: existing?.createdAt ?? new Date(),
            dirty: false,
        };

        this.groups.set(snapshot.id, group);
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
        if (!member) throw new GroupError("NOT_MEMBER", "Not a member of this group");
        if (group.hostUserId !== userId) {
            throw new GroupError("NOT_ALLOWED", "Only the host can control playback");
        }
    }

    private requireQueueEdit(group: GroupState, userId: string): void {
        const member = group.members.get(userId);
        if (!member) throw new GroupError("NOT_MEMBER", "Not a member of this group");
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

    private broadcastState(group: GroupState): void {
        this.callbacks?.onGroupState(group.id, this.snapshot(group));
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
            if (!group.readyUserIds.has(uid)) return false;
        }

        // All ready — start playback!
        this.forcePlay(group);
        return true;
    }

    private forcePlay(group: GroupState): void {
        if (group.readyTimeout) {
            clearTimeout(group.readyTimeout);
            group.readyTimeout = null;
        }

        const pb = group.playback;
        pb.isPlaying = true;
        pb.positionMs = 0;
        pb.lastPositionUpdate = Date.now();
        pb.stateVersion++;
        group.syncState = "playing";
        group.readyUserIds.clear();
        group.dirty = true;

        this.callbacks?.onPlayAt(group.id, {
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: pb.stateVersion,
        });

        // Also broadcast full state
        this.broadcastState(group);
    }

    private endGroupInternal(group: GroupState, reason: string): void {
        if (group.readyTimeout) {
            clearTimeout(group.readyTimeout);
            group.readyTimeout = null;
        }

        group.playback.isPlaying = false;
        group.syncState = "idle";

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
            if (member.socketIds.size === 0 && now - member.lastSeen > STALE_MEMBER_MS) {
                stale.push(userId);
            }
        }

        for (const userId of stale) {
            this.removeMember(groupId, userId);
        }

        return stale;
    }
}

// Export singleton
export const groupManager = new GroupManager();
