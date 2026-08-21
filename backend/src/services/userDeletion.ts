import { prisma } from "../utils/db";
import { acquireRoleGuardLock } from "../utils/advisoryLocks";
import type { Prisma } from "@prisma/client";

/**
 * Outcome of reserving a user for deletion: "reserved" sets the durable
 * pendingDeletionAt marker; "lastAdmin" refuses because no other functional
 * admin would remain; "notFound" means the user row does not exist.
 */
export type UserDeletionReservationResult =
    | "reserved"
    | "lastAdmin"
    | "notFound";

/**
 * Outcome of finalizing a reserved deletion: "deleted" removed the row;
 * "lastAdmin" refused (and cleared the marker exactly once); "notFound"
 * means the row was already gone or was never reserved.
 */
export type UserDeletionResult = "deleted" | "lastAdmin" | "notFound";

/** Load and run heavyweight cross-domain cleanup only after deletion is reserved. */
export async function cleanupReservedUserForDeletion(
    userId: string,
): Promise<void> {
    const { cleanupListenTogetherForUser } =
        await import("./listenTogetherUserCleanup");
    await cleanupListenTogetherForUser(userId);
}

function otherActiveAdminsWhere(userId: string) {
    return {
        role: "admin",
        id: { not: userId },
        pendingDeletionAt: null,
    } as const;
}

/** Reserve a user deletion while preserving at least one functional admin. */
export async function markUserPendingDeletion(
    userId: string,
): Promise<UserDeletionReservationResult> {
    return prisma.$transaction(async (tx) => {
        await acquireRoleGuardLock(tx);
        const target = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true, pendingDeletionAt: true },
        });
        if (!target) return "notFound";
        if (target.pendingDeletionAt) return "reserved";
        if (target.role === "admin") {
            const others = await tx.user.count({
                where: otherActiveAdminsWhere(userId),
            });
            if (others === 0) return "lastAdmin";
        }
        const reserved = await tx.user.updateMany({
            where: { id: userId, pendingDeletionAt: null },
            data: { pendingDeletionAt: new Date() },
        });
        if (reserved.count === 1) return "reserved";
        throw new Error(`Failed to reserve deletion for user ${userId}`);
    });
}

async function clearPendingDeletionMarker(
    userId: string,
    tx: Prisma.TransactionClient,
): Promise<void> {
    const cleared = await tx.user.updateMany({
        where: { id: userId, pendingDeletionAt: { not: null } },
        data: { pendingDeletionAt: null },
    });
    if (cleared.count !== 1) {
        throw new Error(`Failed to cancel deletion for user ${userId}`);
    }
}

/** Delete a reserved user or atomically restore a newly-last admin. */
export async function deleteMarkedUserWithRoleGuard(
    userId: string,
): Promise<UserDeletionResult> {
    return prisma.$transaction(async (tx) => {
        await acquireRoleGuardLock(tx);
        const target = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true, pendingDeletionAt: true },
        });
        if (!target) return "notFound";
        if (target.role === "admin") {
            const others = await tx.user.count({
                where: otherActiveAdminsWhere(userId),
            });
            if (others === 0) {
                if (target.pendingDeletionAt) {
                    await clearPendingDeletionMarker(userId, tx);
                }
                return "lastAdmin";
            }
        }
        const deleted = await tx.user.deleteMany({
            where: { id: userId, pendingDeletionAt: { not: null } },
        });
        return deleted.count === 1 ? "deleted" : "notFound";
    });
}
