import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import type { SyncQueueItem } from "./listenTogetherQueueItem";

export type { SyncQueueItem } from "./listenTogetherQueueItem";

export interface GroupMember {
    userId: string;
    username: string;
    isHost: boolean;
    joinedAt: Date;
    socketIds: Set<string>;
    isReady: boolean;
    unavailableIndices?: Set<number>;
    lastSeen: number;
}

export interface PersistedGroupMember {
    userId: string;
    username: string;
    isHost: boolean;
    joinedAt: Date;
}

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
    /** Highest membership authority applied to this in-memory group. */
    membershipVersion: number;
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
    lastActivity: number;
    createdAt: Date;
    /** True when in-memory state has diverged from DB and needs persisting. */
    dirty: boolean;
    /** True when playback came from a live or shared authoritative snapshot. */
    playbackAuthoritative: boolean;
    /** False after fencing invalidates this object for periodic persistence. */
    persistenceValid: boolean;
    /** DB hydration converted a persisted playing row into a safe local pause. */
    normalizedFromPlaying: boolean;
    /** Highest state version whose complete publication pipeline succeeded. */
    lastPublishedStateVersion: number;
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
    /** Optional for snapshots produced before membership fencing was deployed. */
    membershipVersion?: number;
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

/** Captured result of applying the normal pause transition for shutdown. */
export interface ShutdownPauseResult {
    group: GroupState;
    snapshot: GroupSnapshot;
    paused: boolean;
}

export type QueueAction =
    | { action: "add"; items: SyncQueueItem[] }
    | { action: "insert-next"; items: SyncQueueItem[] }
    | { action: "remove"; index: number }
    | { action: "reorder"; fromIndex: number; toIndex: number }
    | { action: "clear" };

/** Controls whether a manager callback must also synchronize cluster state. */
export interface StatePublicationOptions {
    synchronize?: boolean;
}

/** Socket-facing callbacks emitted by the in-memory group manager. */
export interface ManagerCallbacks {
    onGroupState(
        groupId: string,
        snapshot: GroupSnapshot,
        options?: StatePublicationOptions,
        fence?: GroupMutationFence,
    ): void | Promise<void>;
    onPlaybackDelta(
        groupId: string,
        delta: PlaybackDelta,
        fence?: GroupMutationFence,
    ): void;
    onQueueDelta(
        groupId: string,
        delta: QueueDelta,
        fence?: GroupMutationFence,
    ): void;
    onWaiting(
        groupId: string,
        data: { trackId: string | null; currentIndex: number },
        fence?: GroupMutationFence,
    ): void;
    onPlayAt(
        groupId: string,
        data: { positionMs: number; serverTime: number; stateVersion: number },
        fence?: GroupMutationFence,
    ): void;
    onMemberJoined(
        groupId: string,
        member: { userId: string; username: string },
    ): void;
    onMemberPresence(
        groupId: string,
        member: { userId: string; isConnected: boolean },
    ): void;
    onMemberLeft(
        groupId: string,
        data: {
            userId: string;
            username: string;
            newHostUserId?: string;
            newHostUsername?: string;
        },
    ): void;
    onGroupEnded(
        groupId: string,
        reason: string,
        options?: StatePublicationOptions,
    ): void | Promise<void>;
    onBoundaryWatchdog?(
        groupId: string,
        data: { currentIndex: number; stateVersion: number },
    ): void;
    onReadyGateCompletion(
        groupId: string,
        data: { currentIndex: number; stateVersion: number },
    ): void;
}
