import { prisma } from "../../utils/db";
import { logger as rootLogger } from "../../utils/logger";

const logger = rootLogger.child("BackupRestore");
export const RESTORE_ADVISORY_LOCK = 5_331_001_002;
const RESTORE_LOCK_HIGH_BITS = 1;
const RESTORE_LOCK_LOW_BITS = 1_036_033_706;
const PROBE_CACHE_MS = 2_000;

interface LockProbeCache {
    checkedAt: number;
    held: boolean;
}

let cachedProbe: LockProbeCache | null = null;
let activeProbe: Promise<boolean> | null = null;

async function queryRestoreLock(): Promise<boolean> {
    try {
        const rows = await prisma.$queryRaw<Array<{ held: boolean }>>`
            SELECT EXISTS (
                SELECT 1
                  FROM pg_locks
                 WHERE locktype = 'advisory'
                   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                   AND classid = ${RESTORE_LOCK_HIGH_BITS}::oid
                   AND objid = ${RESTORE_LOCK_LOW_BITS}::oid
                   AND objsubid = 1
                   AND granted
            ) AS held
        `;
        return rows[0]?.held === true;
    } catch (error) {
        logger.warn("Could not probe the restore advisory lock", error);
        return false;
    }
}

/** Record a lock state already established by this process. */
export function recordRestoreLockState(held: boolean, now = Date.now()): void {
    cachedProbe = { checkedAt: now, held };
}

/** Clear cached liveness after releasing the dedicated restore connection. */
export function invalidateRestoreLockCache(): void {
    cachedProbe = null;
}

/** Check pg_locks for the granted bigint restore lock without taking a lock. */
export async function isRestoreLockHeld(now = Date.now()): Promise<boolean> {
    if (cachedProbe && now - cachedProbe.checkedAt < PROBE_CACHE_MS) {
        return cachedProbe.held;
    }
    if (activeProbe) return activeProbe;
    activeProbe = queryRestoreLock().then((held) => {
        cachedProbe = { checkedAt: now, held };
        return held;
    });
    try {
        return await activeProbe;
    } finally {
        activeProbe = null;
    }
}
