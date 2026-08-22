import crypto from "crypto";
import type { Prisma } from "@prisma/client";

type AdvisoryLockTransaction = Pick<Prisma.TransactionClient, "$executeRaw">;

// First signed 64 bits of SHA-256("oidc-role-sync").
const ROLE_GUARD_LOCK_KEY = 8_025_773_003_692_380_079n;

/** Namespaces for per-user transaction locks owned by authentication flows. */
export const USER_LOCK_NAMESPACES = {
    identityUnlink: "identity-unlink",
    appPasswordCreate: "app-password-create",
    federationPairingCodeCreate: "federation-pairing-code-create",
} as const;

type UserLockNamespace =
    (typeof USER_LOCK_NAMESPACES)[keyof typeof USER_LOCK_NAMESPACES];

function userScopedLockKey(
    namespace: UserLockNamespace,
    userId: string,
): bigint {
    return crypto
        .createHash("sha256")
        .update(namespace)
        .update("\0")
        .update(userId)
        .digest()
        .readBigInt64BE(0);
}

/** Acquires the shared transaction lock for last-admin role guards. */
export async function acquireRoleGuardLock(
    tx: AdvisoryLockTransaction,
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROLE_GUARD_LOCK_KEY})`;
}

/** Acquires a namespaced per-user transaction lock for credential mutations. */
export async function acquireUserScopedLock(
    tx: AdvisoryLockTransaction,
    namespace: UserLockNamespace,
    userId: string,
): Promise<void> {
    const lockKey = userScopedLockKey(namespace, userId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
}
