import { prisma } from "../utils/db";
import type { Prisma } from "@prisma/client";
import { GroupError } from "./listenTogetherGroupError";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import { withSyncGroupMembershipFence } from "./listenTogetherMembershipFence";

async function commitGroupEnd(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
    trackCleanupPublication: boolean,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    const group = await tx.syncGroup.findUnique({
        where: { id: groupId },
        select: {
            hostUserId: true,
            isActive: true,
            cleanupPublicationPending: true,
        },
    });
    signal?.throwIfAborted();
    if (!group || (!group.isActive && !trackCleanupPublication)) {
        throw new GroupError("NOT_FOUND", "Group not found");
    }
    if (group.hostUserId !== userId) {
        throw new GroupError("NOT_ALLOWED", "Only the host can end the group");
    }
    if (!group.isActive) {
        if (group.cleanupPublicationPending) return;
        await tx.syncGroup.update({
            where: { id: groupId },
            data: { cleanupPublicationPending: true },
        });
        signal?.throwIfAborted();
        return;
    }
    const now = new Date();
    await tx.syncGroup.update({
        where: { id: groupId },
        data: {
            isActive: false,
            endedAt: now,
            isPlaying: false,
            stateUpdatedAt: now,
            cleanupPublicationPending: trackCleanupPublication,
        },
    });
    signal?.throwIfAborted();
    await tx.syncGroupMember.updateMany({
        where: { syncGroupId: groupId, leftAt: null },
        data: { leftAt: now, isHost: false },
    });
    signal?.throwIfAborted();
}

/** Commit a group end; cleanup may reconcile an already-inactive group. */
export async function endGroupInDb(
    groupId: string,
    userId: string,
    fence: GroupMutationFence,
    trackCleanupPublication: boolean = false,
    signal?: AbortSignal,
): Promise<void> {
    await prisma.$transaction((tx) =>
        withSyncGroupMembershipFence(
            tx,
            groupId,
            fence,
            () =>
                commitGroupEnd(
                    tx,
                    groupId,
                    userId,
                    trackCleanupPublication,
                    signal,
                ),
            signal,
        ),
    );
}
