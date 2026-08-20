import {
    groupManager,
    type GroupSnapshot,
    type PersistedGroupMember,
} from "./listenTogetherManager";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
import {
    enqueueGroupEndedPublication,
    enqueueGroupMembershipPublication,
    enqueueGroupSnapshotPublication,
} from "./listenTogetherCallbacks";

/** Capture the authoritative playback base while the caller holds the group lock. */
export async function captureGroupPublicationBase(
    groupId: string,
): Promise<GroupSnapshot | null> {
    const storedSnapshot = await listenTogetherStateStore.getSnapshot(groupId);
    if (storedSnapshot) {
        return storedSnapshot;
    }
    return groupManager.snapshotById(groupId) ?? null;
}

function clonePlayback(
    playback: GroupSnapshot["playback"],
): GroupSnapshot["playback"] {
    return {
        ...playback,
        queue: Array.isArray(playback.queue) ? [...playback.queue] : [],
    };
}

function parseSnapshotJoinedAt(value: string): Date {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
}

/** Overlay committed membership and host state without reading periodic DB playback. */
export function overlayCommittedMembership(
    captured: GroupSnapshot,
    memberships: PersistedGroupMember[],
    hostUserId: string,
): GroupSnapshot {
    const capturedMembers = new Map(
        captured.members.map((member) => [member.userId, member]),
    );
    const members = memberships.map((membership) => ({
        userId: membership.userId,
        username: membership.username,
        isHost: membership.userId === hostUserId,
        joinedAt:
            membership.joinedAt instanceof Date
                ? membership.joinedAt.toISOString()
                : new Date(0).toISOString(),
        isConnected:
            capturedMembers.get(membership.userId)?.isConnected ?? false,
    }));
    return {
        ...captured,
        hostUserId,
        playback: clonePlayback(captured.playback),
        members,
    };
}

/** Overlay one committed join onto the captured membership set. */
export function overlayCommittedJoin(
    captured: GroupSnapshot,
    member: PersistedGroupMember,
    hostUserId: string,
): GroupSnapshot {
    const memberships = captured.members
        .filter((capturedMember) => capturedMember.userId !== member.userId)
        .map((capturedMember) => ({
            userId: capturedMember.userId,
            username: capturedMember.username,
            isHost: capturedMember.userId === hostUserId,
            joinedAt: parseSnapshotJoinedAt(capturedMember.joinedAt),
        }));
    memberships.push(member);
    return overlayCommittedMembership(captured, memberships, hostUserId);
}

/** Replace local memory only from a captured-and-overlaid authoritative snapshot. */
export function hydrateFromCapturedSnapshot(snapshot: GroupSnapshot): void {
    groupManager.applyExternalSnapshot(snapshot);
}

/** Hydrate and queue one committed join, or emit membership-only after eviction. */
export async function publishCommittedJoin(
    groupId: string,
    captured: GroupSnapshot | null,
    member: PersistedGroupMember,
    hostUserId: string,
): Promise<GroupSnapshot | null> {
    const membership = {
        type: "joined" as const,
        member: { userId: member.userId, username: member.username },
    };
    if (!captured) {
        await enqueueGroupMembershipPublication(groupId, membership);
        return null;
    }

    const snapshot = overlayCommittedJoin(captured, member, hostUserId);
    hydrateFromCapturedSnapshot(snapshot);
    await enqueueGroupSnapshotPublication(groupId, snapshot, membership);
    return snapshot;
}

interface CommittedDeparturePublication {
    memberships: PersistedGroupMember[];
    hostUserId: string;
    newHostUserId?: string;
    newHostUsername?: string;
}

/** Hydrate and queue one committed departure, or emit membership-only after eviction. */
export async function publishCommittedDeparture(
    groupId: string,
    userId: string,
    captured: GroupSnapshot | null,
    committed: CommittedDeparturePublication,
): Promise<void> {
    const departedMember = captured?.members.find(
        (member) => member.userId === userId,
    );
    const membership = {
        type: "left" as const,
        member: {
            userId,
            username: departedMember?.username ?? userId,
            newHostUserId: committed.newHostUserId,
            newHostUsername: committed.newHostUsername,
        },
    };
    if (!captured) {
        await enqueueGroupMembershipPublication(groupId, membership);
        return;
    }

    const snapshot = overlayCommittedMembership(
        captured,
        committed.memberships,
        committed.hostUserId,
    );
    hydrateFromCapturedSnapshot(snapshot);
    await enqueueGroupSnapshotPublication(groupId, snapshot, membership);
}

/** Hydrate from the capture, remove local state, and queue one ended publication. */
export async function publishCommittedEnd(
    groupId: string,
    captured: GroupSnapshot | null,
    reason: string,
): Promise<void> {
    if (captured) {
        hydrateFromCapturedSnapshot(captured);
    }
    groupManager.remove(groupId);
    await enqueueGroupEndedPublication(groupId, reason);
}
