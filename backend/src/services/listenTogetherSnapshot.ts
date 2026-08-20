import type {
    GroupMember,
    GroupSnapshot,
    GroupState,
} from "./listenTogetherManager";

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
