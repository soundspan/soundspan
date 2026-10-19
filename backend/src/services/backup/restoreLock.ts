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

interface ProbeConnection {
    client: Client;
    error: Error | null;
    closing: boolean;
    onError: (error: Error) => void;
}

let cachedProbe: LockProbeCache | null = null;
let lastSuccessfulProbe: LockProbeCache | null = null;
let activeProbe: Promise<boolean> | null = null;
let activeConnect: Promise<ProbeConnection> | null = null;
let probeConnection: ProbeConnection | null = null;
let reconnectAfter = 0;
let lastWarningAt = Number.NEGATIVE_INFINITY;
let ownedByProcess = false;
let previouslyReportedHeld = false;
let releaseObserved = false;

function fallbackAfterFailure(now: number, error: unknown): boolean {
    if (now - lastWarningAt >= WARNING_INTERVAL_MS) {
        lastWarningAt = now;
        logger.warn("Could not probe the restore advisory lock", error);
    }
    if (
        lastSuccessfulProbe &&
        now - lastSuccessfulProbe.checkedAt < STALE_FALLBACK_MS
    ) {
        return lastSuccessfulProbe.held;
    }
    return false;
}

async function discardProbeConnection(
    connection: ProbeConnection,
    now: number,
): Promise<void> {
    if (connection.closing) return;
    connection.closing = true;
    if (probeConnection === connection) probeConnection = null;
    reconnectAfter = Math.max(reconnectAfter, now + PROBE_CACHE_MS);
    await connection.client.end().catch(() => undefined);
    connection.client.off("error", connection.onError);
}

async function connectProbe(now: number): Promise<ProbeConnection> {
    if (probeConnection && !probeConnection.error) return probeConnection;
    if (activeConnect) return activeConnect;
    if (now < reconnectAfter)
        throw new Error("Restore lock probe is backing off");
    const client = new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: PROBE_TIMEOUT_MS,
        query_timeout: PROBE_TIMEOUT_MS,
    });
    const connection: ProbeConnection = {
        client,
        error: null,
        closing: false,
        onError: () => undefined,
    };
    connection.onError = (error: Error): void => {
        connection.error = error;
        void discardProbeConnection(connection, Date.now());
    };
    client.on("error", connection.onError);
    activeConnect = client
        .connect()
        .then(() => {
            if (connection.error || connection.closing) {
                throw (
                    connection.error ?? new Error("Restore lock probe closed")
                );
            }
            probeConnection = connection;
            return connection;
        })
        .catch(async (error: unknown) => {
            await discardProbeConnection(connection, now);
            throw error;
        });
    try {
        return await activeConnect;
    } finally {
        activeConnect = null;
    }
}

async function queryRestoreLock(
    now: number,
): Promise<{ held: boolean; fresh: boolean }> {
    let connection: ProbeConnection | null = null;
    try {
        connection = await connectProbe(now);
        const result = await connection.client.query<{ held: boolean }>(`
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
        if (connection.error) throw connection.error;
        const held = result.rows[0]?.held === true;
        lastSuccessfulProbe = { checkedAt: now, held };
        return { held, fresh: true };
    } catch (error) {
        if (connection) await discardProbeConnection(connection, now);
        return { held: fallbackAfterFailure(now, error), fresh: false };
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
    lastSuccessfulProbe = null;
}

function recordReportedResult(held: boolean): boolean {
    if (previouslyReportedHeld && !held) releaseObserved = true;
    previouslyReportedHeld = held;
    return held;
}

/** Consume one observed transition from a held restore lock to no lock. */
export function consumeRestoreLockRelease(): boolean {
    const observed = releaseObserved;
    releaseObserved = false;
    return observed;
}

/** Check pg_locks for the granted bigint restore lock without application reads. */
export async function isRestoreLockHeld(now = Date.now()): Promise<boolean> {
    if (ownedByProcess) return recordReportedResult(true);
    if (cachedProbe && now - cachedProbe.checkedAt < PROBE_CACHE_MS) {
        return recordReportedResult(cachedProbe.held);
    }
    if (activeProbe) return recordReportedResult(await activeProbe);
    activeProbe = queryRestoreLock(now).then((result) => {
        cachedProbe = { checkedAt: now, held: result.held };
        return result.held;
    });
    try {
        return recordReportedResult(await activeProbe);
    } finally {
        activeProbe = null;
    }
}
