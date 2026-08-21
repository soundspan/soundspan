import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { GroupError } from "./listenTogetherManager";

/** Fence a create or membership write against administrative deletion. */
export async function requireMembershipEligibleUser(
    tx: Prisma.TransactionClient,
    userId: string,
): Promise<void> {
    const eligible = await tx.user.updateMany({
        where: { id: userId, pendingDeletionAt: null },
        data: { pendingDeletionAt: null },
    });
    if (eligible.count === 1) return;
    throw new GroupError("NOT_ALLOWED", "User deletion is pending");
}

/** Reject reconnect publication after administrative deletion is marked. */
export async function assertUserNotPendingDeletion(
    userId: string,
): Promise<void> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { pendingDeletionAt: true },
    });
    if (user && user.pendingDeletionAt === null) return;
    throw new GroupError("NOT_ALLOWED", "User deletion is pending");
}
