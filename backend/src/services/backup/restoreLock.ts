import { Client } from "pg";
import { config } from "../../config";
import { logger as rootLogger } from "../../utils/logger";

const logger = rootLogger.child("BackupRestore");
export const RESTORE_ADVISORY_LOCK = 5_331_001_002;
const RESTORE_LOCK_HIGH_BITS = 1;
const RESTORE_LOCK_LOW_BITS = 1_036_033_706;
const PROBE_CACHE_MS = 2_000;
const STALE_FALLBACK_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_000;
const WARNING_INTERVAL_MS = 60_000;

interface LockProbeCache {
    checkedAt: number;
    held: boolean;
}

let cachedProbe: LockProbeCache | null = null;
let activeProbe: Promise<boolean> | null = null;
let lastWarningAt = Number.NEGATIVE_INFINITY;
let ownedByProcess = false;

function fallbackAfterFailure(now: number, error: unknown): boolean {
    if (now - lastWarningAt >= WARNING_INTERVAL_MS) {
        lastWarningAt = now;
        logger.warn("Could not probe the restore advisory lock", error);
    }
    if (cachedProbe && now - cachedProbe.checkedAt < STALE_FALLBACK_MS) {
        return cachedProbe.held;
    }
    return false;
}

async function queryRestoreLock(
    now: number,
): Promise<{ held: boolean; fresh: boolean }> {
    const client = new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: PROBE_TIMEOUT_MS,
        query_timeout: PROBE_TIMEOUT_MS,
    });
    let connectionError: Error | null = null;
    const onError = (error: Error): void => {
        connectionError = error;
    };
    client.on("error", onError);
    try {
        await client.connect();
        const result = await client.query<{ held: boolean }>(`
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
        `);
        if (connectionError) throw connectionError;
        return { held: result.rows[0]?.held === true, fresh: true };
    } catch (error) {
        return { held: fallbackAfterFailure(now, error), fresh: false };
    } finally {
        await client.end().catch(() => undefined);
        client.off("error", onError);
    }
}

/** Record a lock state already established by this process. */
export function recordRestoreLockState(held: boolean, now = Date.now()): void {
    ownedByProcess = held;
    cachedProbe = { checkedAt: now, held };
}

/** Clear cached liveness after releasing the dedicated restore connection. */
export function invalidateRestoreLockCache(): void {
    ownedByProcess = false;
    cachedProbe = null;
}

/** Check pg_locks for the granted bigint restore lock without application reads. */
export async function isRestoreLockHeld(now = Date.now()): Promise<boolean> {
    if (ownedByProcess) return true;
    if (cachedProbe && now - cachedProbe.checkedAt < PROBE_CACHE_MS) {
        return cachedProbe.held;
    }
    if (activeProbe) return activeProbe;
    activeProbe = queryRestoreLock(now).then((result) => {
        if (result.fresh) cachedProbe = { checkedAt: now, held: result.held };
        return result.held;
    });
    try {
        return await activeProbe;
    } finally {
        activeProbe = null;
    }
}
