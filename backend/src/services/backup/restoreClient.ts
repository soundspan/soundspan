import { Client } from "pg";
import { config } from "../../config";
import { logger as rootLogger } from "../../utils/logger";
import { RestoreError } from "./backupErrors";
import {
    invalidateRestoreLockCache,
    recordRestoreLockState,
    RESTORE_ADVISORY_LOCK,
} from "./restoreLock";

const logger = rootLogger.child("BackupRestore");
const RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const ORIGINAL_CLIENT_CLOSE_TIMEOUT_MS = 5_000;

/** Dedicated connection and liveness signals for one restore job. */
export interface RestoreClientHandle {
    client: Client;
    backendPid: number | null;
    backendStart: string | null;
    connectionFailure: Promise<Error>;
    detachClientError: () => void;
    getConnectionError: () => Error | null;
}

interface MonitoredClient {
    client: Client;
    detach: () => void;
    getError: () => Error | null;
    failure: Promise<Error>;
}

interface BackendIdentity {
    pid: number;
    start: string;
}

const clientCloses = new WeakMap<RestoreClientHandle, Promise<void>>();

function newRestoreClient(): Client {
    return new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 2 * 60 * 60 * 1000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 30_000,
    });
}

function monitorClient(client: Client, logErrors = false): MonitoredClient {
    let resolveFailure: (error: Error) => void = () => undefined;
    let connectionError: Error | null = null;
    const failure = new Promise<Error>((resolve) => {
        resolveFailure = resolve;
    });
    const onError = (error: Error): void => {
        connectionError = error;
        if (logErrors)
            logger.warn("Fresh restore database connection failed", error);
        resolveFailure(error);
    };
    client.on("error", onError);
    return {
        client,
        failure,
        detach: () => client.off("error", onError),
        getError: () => connectionError,
    };
}

function backendPid(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function backendStart(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** Connect and take the non-blocking restore lock for a new job. */
export async function acquireRestoreClient(): Promise<RestoreClientHandle> {
    const monitored = monitorClient(newRestoreClient());
    try {
        await monitored.client.connect();
        const result = await monitored.client.query<{
            acquired: boolean;
            backend_pid: number;
            backend_start: string;
        }>(
            `SELECT pg_try_advisory_lock($1) AS acquired,
                    pg_backend_pid() AS backend_pid,
                    (SELECT backend_start::text
                       FROM pg_stat_activity
                      WHERE pid = pg_backend_pid()) AS backend_start`,
            [RESTORE_ADVISORY_LOCK],
        );
        if (result.rows[0]?.acquired !== true) {
            throw new RestoreError(
                "RESTORE_IN_PROGRESS",
                "A restore is already in progress",
            );
        }
        recordRestoreLockState(true);
        return {
            client: monitored.client,
            backendPid: backendPid(result.rows[0]?.backend_pid),
            backendStart: backendStart(result.rows[0]?.backend_start),
            connectionFailure: monitored.failure,
            detachClientError: monitored.detach,
            getConnectionError: monitored.getError,
        };
    } catch (error) {
        await monitored.client.end().catch(() => undefined);
        monitored.detach();
        throw error;
    }
}

function waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, delayMs);
        timeout.unref();
    });
}

async function connectRecoveryClient(): Promise<MonitoredClient> {
    let lastError: unknown = new Error("Restore recovery connection failed");
    for (
        let attempt = 0;
        attempt <= RECOVERY_RETRY_DELAYS_MS.length;
        attempt += 1
    ) {
        const monitored = monitorClient(newRestoreClient(), true);
        try {
            await monitored.client.connect();
            return monitored;
        } catch (error) {
            lastError = error;
            monitored.detach();
            await monitored.client.end().catch(() => undefined);
            if (attempt < RECOVERY_RETRY_DELAYS_MS.length) {
                await waitForRetry(RECOVERY_RETRY_DELAYS_MS[attempt]!);
            }
        }
    }
    throw lastError;
}

async function retakeRestoreLock(
    client: Client,
    original: BackendIdentity | null,
): Promise<void> {
    if (original) {
        await client.query(
            `SELECT pg_terminate_backend(pid) AS terminated
               FROM pg_stat_activity
              WHERE pid = $1
                AND backend_start = $2::timestamptz
                AND pid <> pg_backend_pid()`,
            [original.pid, original.start],
        );
    }
    await client.query("SET lock_timeout = '30s'");
    try {
        await client.query("SELECT pg_advisory_lock($1)", [
            RESTORE_ADVISORY_LOCK,
        ]);
    } finally {
        await client.query("RESET lock_timeout");
    }
    recordRestoreLockState(true);
}

async function closeRestoreClient(
    handle: RestoreClientHandle,
    graceful: boolean,
): Promise<void> {
    let failure: unknown;
    try {
        const transaction = handle.client.getTransactionStatus();
        if (graceful && (transaction === "T" || transaction === "E")) {
            await handle.client.query("ROLLBACK");
        }
        if (graceful) {
            await handle.client.query("SELECT pg_advisory_unlock($1)", [
                RESTORE_ADVISORY_LOCK,
            ]);
        }
    } catch (error) {
        failure = error;
    }
    try {
        await handle.client.end();
    } catch (error) {
        failure ??= error;
    } finally {
        handle.detachClientError();
    }
    if (failure) throw failure;
}

function beginRestoreClientClose(
    handle: RestoreClientHandle,
    graceful: boolean,
): Promise<void> {
    const active = clientCloses.get(handle);
    if (active) return active;
    const close = closeRestoreClient(handle, graceful);
    clientCloses.set(handle, close);
    return close;
}

async function closeWithinRecoveryDeadline(
    close: Promise<void>,
): Promise<boolean> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
            () => reject(new Error("Original restore client close timed out")),
            ORIGINAL_CLIENT_CLOSE_TIMEOUT_MS,
        );
        timeoutId.unref();
    });
    try {
        await Promise.race([close, timeout]);
        return true;
    } catch (error) {
        logger.warn(
            "Original restore database connection did not close",
            error,
        );
        return false;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function prepareOriginalForRecovery(
    handle: RestoreClientHandle,
): Promise<BackendIdentity | null> {
    const connectionLost = handle.getConnectionError() !== null;
    const close = beginRestoreClientClose(handle, !connectionLost);
    const closed = await closeWithinRecoveryDeadline(close);
    invalidateRestoreLockCache();
    if (!connectionLost && closed) return null;
    if (handle.backendPid === null || handle.backendStart === null) return null;
    return { pid: handle.backendPid, start: handle.backendStart };
}

/** Run post-failure work on a retried fresh client that owns the restore lock. */
export async function withRecoveryRestoreClient<T>(
    original: RestoreClientHandle,
    work: (client: Client) => Promise<T>,
): Promise<T> {
    const terminationTarget = await prepareOriginalForRecovery(original);
    const monitored = await connectRecoveryClient();
    try {
        await retakeRestoreLock(monitored.client, terminationTarget);
        return await work(monitored.client);
    } finally {
        await monitored.client.end().catch(() => undefined);
        monitored.detach();
        invalidateRestoreLockCache();
    }
}

/** Release the original client and clear process-local lock knowledge. */
export async function releaseRestoreClient(
    handle: RestoreClientHandle,
): Promise<void> {
    const graceful = handle.getConnectionError() === null;
    await beginRestoreClientClose(handle, graceful).catch(() => undefined);
    invalidateRestoreLockCache();
}
