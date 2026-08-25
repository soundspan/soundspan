import { prisma } from "../utils/db";
import type { Prisma } from "@prisma/client";
import type { PersistedGroupMember } from "./listenTogetherTypes";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import { withSyncGroupMembershipFence } from "./listenTogetherMembershipFence";
import { selectHostSuccessor } from "./listenTogetherSnapshot";

/** Durable result used to publish one committed departure. */
export type CommittedDeparture =
    | {
          status: "active";
          hostUserId: string;
          memberships: PersistedGroupMember[];
          newHostUserId?: string;
          newHostUsername?: string;
      }
    | { status: "ended" | "already-ended" };

/** Leave one membership and ensure cleanup can retry an already-left row. */
export async function commitMemberDeparture(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
    leftAt: Date,
    trackCleanupPublication: boolean,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    const departure = await tx.syncGroupMember.updateMany({
        where: { syncGroupId: groupId, userId, leftAt: null },
        data: {
            leftAt,
            isHost: false,
            ...(trackCleanupPublication
                ? { cleanupPublicationPending: true }
                : {}),
        },
    });
    signal?.throwIfAborted();
    if (!trackCleanupPublication || departure.count !== 0) return;
    const tracked = await tx.syncGroupMember.updateMany({
        where: { syncGroupId: groupId, userId },
        data: { isHost: false, cleanupPublicationPending: true },
    });
    signal?.throwIfAborted();
    if (tracked.count !== 1) {
        throw new Error(
            `Membership cleanup record missing for ${userId} in ${groupId}`,
        );
    }
}

/** Load the active durable member set used by joins and departures. */
export async function loadPersistedMemberships(
    tx: Prisma.TransactionClient,
    groupId: string,
    signal?: AbortSignal,
): Promise<PersistedGroupMember[]> {
    signal?.throwIfAborted();
    const memberships = await tx.syncGroupMember.findMany({
        where: { syncGroupId: groupId, leftAt: null },
        select: {
            userId: true,
            joinedAt: true,
            user: { select: { username: true, displayName: true } },
        },
    });
    signal?.throwIfAborted();
    return (memberships ?? []).map((membership) => ({
        userId: membership.userId,
        username:
            membership.user.displayName?.trim() || membership.user.username,
        isHost: false,
        joinedAt: membership.joinedAt,
    }));
}

async function persistHostTransfer(
    tx: Prisma.TransactionClient,
    groupId: string,
    candidates: PersistedGroupMember[],
    signal?: AbortSignal,
): Promise<CommittedDeparture> {
    signal?.throwIfAborted();
    const successor = selectHostSuccessor(candidates);
    if (!successor) {
        throw new Error(`Active group ${groupId} has no host successor`);
    }
    await tx.syncGroup.update({
        where: { id: groupId },
        data: { hostUserId: successor.userId },
    });
    signal?.throwIfAborted();
    await tx.syncGroupMember.updateMany({
        where: { syncGroupId: groupId, leftAt: null },
        data: { isHost: false },
    });
    signal?.throwIfAborted();
    await tx.syncGroupMember.updateMany({
        where: {
            syncGroupId: groupId,
            userId: successor.userId,
            leftAt: null,
        },
        data: { isHost: true },
    });
    signal?.throwIfAborted();
    return {
        status: "active",
        hostUserId: successor.userId,
        memberships: candidates.map((candidate) => ({
            ...candidate,
            isHost: candidate.userId === successor.userId,
        })),
        newHostUserId: successor.userId,
        newHostUsername: successor.username,
    };
}

async function commitDepartureTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    groupId: string,
    now: Date,
    trackCleanupPublication: boolean,
    signal?: AbortSignal,
): Promise<CommittedDeparture> {
    await commitMemberDeparture(
        tx,
        groupId,
        userId,
        now,
        trackCleanupPublication,
        signal,
    );
    signal?.throwIfAborted();
    const group = await tx.syncGroup.findUnique({
        where: { id: groupId },
        select: { hostUserId: true, isActive: true },
    });
    signal?.throwIfAborted();
    if (!group?.isActive) return { status: "already-ended" };
    const candidates = await loadPersistedMemberships(tx, groupId, signal);
    if (candidates.length === 0) {
        await tx.syncGroup.update({
            where: { id: groupId },
            data: {
                isActive: false,
                endedAt: now,
                isPlaying: false,
                stateUpdatedAt: now,
            },
        });
        signal?.throwIfAborted();
        return { status: "ended" };
    }
    if (group.hostUserId === userId) {
        return persistHostTransfer(tx, groupId, candidates, signal);
    }
    return {
        status: "active",
        hostUserId: group.hostUserId,
        memberships: candidates.map((candidate) => ({
            ...candidate,
            isHost: candidate.userId === group.hostUserId,
        })),
    };
}

/** Commit a departure behind the durable group membership fence. */
export function commitGroupDeparture(
    userId: string,
    groupId: string,
    fence: GroupMutationFence,
    trackCleanupPublication: boolean = false,
    signal?: AbortSignal,
): Promise<CommittedDeparture> {
    const now = new Date();
    return prisma.$transaction((tx) =>
        withSyncGroupMembershipFence(
            tx,
            groupId,
            fence,
            () =>
                commitDepartureTransaction(
                    tx,
                    userId,
                    groupId,
                    now,
                    trackCleanupPublication,
                    signal,
                ),
            signal,
        ),
    );
}
