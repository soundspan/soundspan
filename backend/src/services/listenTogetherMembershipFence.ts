import type { Prisma } from "@prisma/client";
import { GroupError } from "./listenTogetherGroupError";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";

function staleMembershipFence(): GroupError {
    return new GroupError(
        "CONFLICT",
        "Group coordination lease expired. Please retry.",
    );
}

async function assertMembershipFenceCurrent(
    fence: GroupMutationFence,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    if (fence.isFenced()) throw staleMembershipFence();
    await fence.assertCurrent?.();
    signal?.throwIfAborted();
    if (fence.isFenced()) throw staleMembershipFence();
}

/** Advance the durable membership fence before changing existing group membership. */
export async function advanceSyncGroupMembershipFence(
    tx: Prisma.TransactionClient,
    groupId: string,
    fence: GroupMutationFence,
    signal?: AbortSignal,
): Promise<void> {
    await assertMembershipFenceCurrent(fence, signal);
    if (!fence.requiresMembershipFence) {
        // Fully local mode has one process and no concurrent lease holder. Its
        // counter may reset after restart, so a durable guard would self-block.
        return;
    }
    const advanced = await tx.syncGroup.updateMany({
        where: {
            id: groupId,
            membershipFence: { lt: BigInt(fence.fencingToken) },
        },
        data: { membershipFence: BigInt(fence.fencingToken) },
    });
    signal?.throwIfAborted();
    if (advanced.count === 1) return;
    throw staleMembershipFence();
}

/** Run membership writes between lease validation and a rollback-triggering check. */
export async function withSyncGroupMembershipFence<T>(
    tx: Prisma.TransactionClient,
    groupId: string,
    fence: GroupMutationFence,
    operation: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    await advanceSyncGroupMembershipFence(tx, groupId, fence, signal);
    signal?.throwIfAborted();
    const result = await operation();
    signal?.throwIfAborted();
    await assertMembershipFenceCurrent(fence, signal);
    return result;
}
