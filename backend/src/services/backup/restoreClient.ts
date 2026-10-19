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

/** Dedicated connection and liveness signals for one restore job. */
export interface RestoreClientHandle {
    client: Client;
    backendPid: number | null;
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

function newRestoreClient(): Client {
    return new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 2 * 60 * 60 * 1000,
        keepAlive: true,
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

/** Connect and take the non-blocking restore lock for a new job. */
export async function acquireRestoreClient(): Promise<RestoreClientHandle> {
    const monitored = monitorClient(newRestoreClient());
    try {
        await monitored.client.connect();
        const result = await monitored.client.query<{
            acquired: boolean;
            backend_pid: number;
        }>(
            "SELECT pg_try_advisory_lock($1) AS acquired, pg_backend_pid() AS backend_pid",
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
            connectionFailure: monitored.failure,
            detachClientError: monitored.detach,
            getConnectionError: monitored.getError,
        };
    } catch (error) {
        monitored.detach();
        await monitored.client.end().catch(() => undefined);
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
    originalBackendPid: number | null,
): Promise<void> {
    if (originalBackendPid !== null) {
        await client.query("SELECT pg_terminate_backend($1) AS terminated", [
            originalBackendPid,
        ]);
    }
    await client.query("SET lock_timeout = '30s'");
    await client.query("SELECT pg_advisory_lock($1)", [RESTORE_ADVISORY_LOCK]);
    recordRestoreLockState(true);
}

/** Run post-failure work on a retried fresh client that owns the restore lock. */
export async function withRecoveryRestoreClient<T>(
    originalBackendPid: number | null,
    work: (client: Client) => Promise<T>,
): Promise<T> {
    const monitored = await connectRecoveryClient();
    try {
        await retakeRestoreLock(monitored.client, originalBackendPid);
        return await work(monitored.client);
    } finally {
        monitored.detach();
        await monitored.client.end().catch(() => undefined);
    }
}

/** Release the original client and clear process-local lock knowledge. */
export async function releaseRestoreClient(
    handle: RestoreClientHandle,
): Promise<void> {
    handle.detachClientError();
    await handle.client
        .query("SELECT pg_advisory_unlock($1)", [RESTORE_ADVISORY_LOCK])
        .catch(() => undefined);
    await handle.client.end().catch(() => undefined);
    invalidateRestoreLockCache();
}
