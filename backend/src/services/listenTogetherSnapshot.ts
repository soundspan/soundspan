import type {
    GroupMember,
    GroupSnapshot,
    GroupState,
} from "./listenTogetherManager";
import {
    computePosition,
    currentTrackId,
} from "./listenTogetherPlaybackPosition";

/** Authoritative active membership loaded from the database. */
export interface PersistedGroupMember {
    userId: string;
    username: string;
    isHost: boolean;
    joinedAt: Date;
}

/** Bounds snapshot-age compensation so clock skew cannot add more than 2 seconds. */
const SNAPSHOT_POSITION_COMPENSATION_MAX_MS = 2_000;

interface HostSuccessorCandidate {
    username: string;
    joinedAt: Date;
}

/** Pick the next host by display name, then original join order. */
export function selectHostSuccessor<T extends HostSuccessorCandidate>(
    members: Iterable<T>,
): T | undefined {
    return Array.from(members).sort((a, b) => {
        const nameComparison = a.username.localeCompare(b.username, undefined, {
            sensitivity: "accent",
        });
        if (nameComparison !== 0) return nameComparison;
        return a.joinedAt.getTime() - b.joinedAt.getTime();
    })[0];
}

/** Make the persisted host identity the only host among the supplied members. */
export function reconcileHostFlags(
    members: Map<string, GroupMember>,
    hostUserId: string,
): void {
    for (const member of members.values()) {
        member.isHost = member.userId === hostUserId;
    }
}

/** Replace local membership with the committed database membership set. */
export function reconcileCommittedMembers(
    group: GroupState,
    persistedMembers: PersistedGroupMember[],
    hostUserId: string,
    now: number,
): void {
    const members = new Map<string, GroupMember>();
    for (const persisted of persistedMembers) {
        const existing = group.members.get(persisted.userId);
        members.set(persisted.userId, {
            ...persisted,
            isHost: persisted.userId === hostUserId,
            socketIds: existing?.socketIds ?? new Set<string>(),
            isReady: group.readyUserIds.has(persisted.userId),
            unavailableIndices:
                existing?.unavailableIndices ?? new Set<number>(),
            lastSeen: existing?.lastSeen ?? now,
        });
    }
    group.hostUserId = hostUserId;
    group.members = members;
    group.readyUserIds = new Set(
        Array.from(group.readyUserIds).filter((userId) => members.has(userId)),
    );
    group.lastActivity = now;
}

/** Apply exact snapshot membership and return sockets owned by omitted members. */
export function applyExactCommittedMembership(
    group: GroupState,
    members: GroupSnapshot["members"],
    hostUserId: string,
    now: number,
): string[] {
    const committedUserIds = new Set(members.map((member) => member.userId));
    const revokedSocketIds = Array.from(group.members.values())
        .filter((member) => !committedUserIds.has(member.userId))
        .flatMap((member) => Array.from(member.socketIds));
    const persistedMembers = members.map((member) => {
        const joinedAt = new Date(member.joinedAt);
        return {
            userId: member.userId,
            username: member.username,
            isHost: member.userId === hostUserId,
            joinedAt: Number.isFinite(joinedAt.getTime())
                ? joinedAt
                : new Date(0),
        };
    });
    reconcileCommittedMembers(group, persistedMembers, hostUserId, now);
    return revokedSocketIds;
}

/** Serialize members in stable host-then-join order. */
export function snapshotMembers(
    members: Map<string, GroupMember>,
): GroupSnapshot["members"] {
    return Array.from(members.values())
        .sort((a, b) => {
            if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
            return a.joinedAt.getTime() - b.joinedAt.getTime();
        })
        .map((member) => ({
            userId: member.userId,
            username: member.username,
            isHost: member.isHost,
            joinedAt: member.joinedAt.toISOString(),
            isConnected: member.socketIds.size > 0,
        }));
}

/** Advance a snapshot time watermark without allowing clock-domain rewind. */
export function advanceSnapshotWatermark(
    current: number,
    incoming: number,
): number {
    return Math.max(current, incoming);
}

/** Serialize one in-memory group and advance its producer-time watermark. */
export function createGroupSnapshot(
    group: GroupState,
    serverTime: number,
): GroupSnapshot {
    const playback = group.playback;
    playback.lastAppliedSnapshotServerTime = advanceSnapshotWatermark(
        playback.lastAppliedSnapshotServerTime,
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
        membershipVersion: group.membershipVersion,
        syncState: group.syncState,
        readyDeadlineMs:
            group.syncState === "waiting" ? group.readyDeadlineMs : null,
        readyUserIds: Array.from(group.readyUserIds),
        playback: {
            queue: playback.queue,
            currentIndex: playback.currentIndex,
            isPlaying: playback.isPlaying,
            positionMs: computePosition(playback),
            serverTime,
            stateVersion: playback.stateVersion,
            trackId: currentTrackId(playback),
        },
        members: snapshotMembers(group.members),
    };
}

/** Merge snapshot membership while retaining members connected to this pod. */
export function mergeSnapshotMembers(
    snapshotMembers: GroupSnapshot["members"],
    existingMembers: Map<string, GroupMember> | undefined,
    readyUserIds: Set<string>,
    now: number,
): Map<string, GroupMember> {
    const members = new Map<string, GroupMember>();
    for (const member of snapshotMembers) {
        const existingMember = existingMembers?.get(member.userId);
        members.set(member.userId, {
            userId: member.userId,
            username: member.username,
            isHost: Boolean(member.isHost),
            joinedAt: new Date(member.joinedAt),
            socketIds: existingMember?.socketIds ?? new Set<string>(),
            isReady: readyUserIds.has(member.userId),
            unavailableIndices: new Set(),
            lastSeen: now,
        });
    }

    for (const member of existingMembers?.values() ?? []) {
        if (members.has(member.userId) || member.socketIds.size === 0) continue;
        member.lastSeen = now;
        members.set(member.userId, member);
    }
    return members;
}

/** Add bounded snapshot age to a playing position without adopting its clock. */
export function compensateSnapshotPosition(
    positionMs: number,
    serverTime: number,
    now: number,
    isPlaying: boolean,
): number {
    if (!isPlaying || serverTime <= 0) return positionMs;
    const snapshotAgeMs = Math.min(
        Math.max(now - serverTime, 0),
        SNAPSHOT_POSITION_COMPENSATION_MAX_MS,
    );
    return positionMs + snapshotAgeMs;
}

/** Decide whether incoming playback is newer than local playback state. */
export function shouldApplyIncomingPlayback(
    existing: GroupState | undefined,
    incomingStateVersion: number,
    incomingServerTime: number,
): boolean {
    if (!existing) return true;

    const currentStateVersion = existing.playback.stateVersion;
    if (incomingStateVersion > currentStateVersion) return true;
    if (incomingStateVersion < currentStateVersion) return false;

    // Keep the tie-breaker in the producer clock domain; lastPositionUpdate is local-only.
    return (
        incomingServerTime >= existing.playback.lastAppliedSnapshotServerTime
    );
}
