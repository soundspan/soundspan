import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { Client } from "pg";
import { config } from "../../config";
import { resolveAppVersion } from "../../config/appVersion";
import { getSettingsEncryptionKey } from "../../utils/encryption";
import { getPepperFingerprint } from "../../utils/apiKeyHash";
import { logger as rootLogger } from "../../utils/logger";
import {
    validateBackupArchive,
    type ArchiveValidation,
} from "./backupArchiveReader";
import {
    BackupError,
    RestoreError,
    RestoreMigrationError,
} from "./backupErrors";
import { loadBackupData, type RestoreProgress } from "./restoreDataLoad";
import {
    evaluateRestoreCompatibility,
    readImageMigrations,
    type CompatibilityResult,
} from "./restoreCompatibility";
import {
    deployCurrentMigrations,
    replayBackupMigrations,
} from "./restoreMigrationReplay";
import {
    reencryptRestoredCredentials,
    type ReencryptSummary,
} from "./restoreReencrypt";
import { resetApplicationSchema } from "./restoreSchemaReset";
import {
    releaseRestoreUpload,
    restoreStagingDirectory,
} from "./restoreUploads";
import { markRestartRequired } from "./restartRequired";
import {
    invalidateRestoreLockCache,
    recordRestoreLockState,
    RESTORE_ADVISORY_LOCK,
} from "./restoreLock";
import {
    setRestoreStatus,
    type RestoreState,
    type RestoreSummary,
} from "./restoreStatus";
export {
    getRestoreStatus,
    isRestoreJobActive,
    setRestoreStatus,
} from "./restoreStatus";

const logger = rootLogger.child("BackupRestore");
const BACKEND_ROOT = path.resolve(__dirname, "../../..");
const PROGRESS_WRITE_INTERVAL_MS = 1_000;

interface StartJobOptions {
    uploadId: string;
    filePath: string;
    backupKey: string;
    backupPepperFingerprint: string | null;
    macKey: Buffer;
}

type CompatibleRestore = Extract<CompatibilityResult, { outcome: "ok" }>;
type CredentialResult = Awaited<
    ReturnType<typeof reencryptRestoredCredentials>
>;

interface PreparedRestore {
    validated: ArchiveValidation;
    compatibility: CompatibleRestore;
    imageMigrations: Awaited<ReturnType<typeof readImageMigrations>>;
}

interface RestoreExecutionState {
    prepared: PreparedRestore | null;
    progress: RestoreProgress | null;
    firstPass: CredentialResult;
    currentKey: string | null;
    resetStarted: boolean;
    loadCommitted: boolean;
    migrateStarted: boolean;
    replayDir: string | null;
}

function emptyCredentialResult(): CredentialResult {
    return {
        credentialsReencrypted: 0,
        credentialsUndecryptable: 0,
        processedColumns: [],
    };
}

function createExecutionState(): RestoreExecutionState {
    return {
        prepared: null,
        progress: null,
        firstPass: emptyCredentialResult(),
        currentKey: null,
        resetStarted: false,
        loadCommitted: false,
        migrateStarted: false,
        replayDir: null,
    };
}

async function cleanupFreshInstall(client: Client): Promise<void> {
    await resetApplicationSchema(client, { allowExistingUsers: true });
    await deployCurrentMigrations(config.databaseUrl);
}

function safeFailure(error: unknown): { code: string; message: string } {
    if (error instanceof BackupError) {
        return { code: error.code, message: error.clientMessage };
    }
    return {
        code: "RESTORE_FAILED",
        message:
            "The restore failed. The instance was reset to a fresh install.",
    };
}

async function updatePhase(
    restoreId: string,
    state: RestoreState,
    progress: RestoreProgress | null = null,
): Promise<void> {
    await setRestoreStatus({
        restoreId,
        state,
        progress,
        error: null,
        summary: null,
    });
}

async function prepareRestore(
    filePath: string,
    macKey: Buffer,
): Promise<{
    validated: ArchiveValidation;
    compatibility: CompatibleRestore;
    imageMigrations: Awaited<ReturnType<typeof readImageMigrations>>;
}> {
    const validated = await validateBackupArchive(filePath, macKey);
    const imageMigrations = await readImageMigrations(
        path.join(BACKEND_ROOT, "prisma", "migrations"),
    );
    const compatibility = evaluateRestoreCompatibility(
        validated.header.migrations,
        imageMigrations,
    );
    if (compatibility.outcome !== "ok") {
        throw new RestoreError(
            compatibility.outcome,
            "Backup migrations are incompatible with this image",
        );
    }
    if (compatibility.checksumWarnings.length > 0) {
        logger.warn("Backup migration checksums differ from the image", {
            migrations: compatibility.checksumWarnings,
        });
    }
    return { validated, compatibility, imageMigrations };
}

function initialProgress(validated: ArchiveValidation): RestoreProgress {
    return {
        completedTables: 0,
        totalTables: validated.header.tables.length,
        completedRows: 0,
        totalRows: validated.rows,
    };
}

async function reencryptBeforeCommit(
    client: Client,
    restoreId: string,
    options: StartJobOptions,
    currentKey: string,
): Promise<CredentialResult> {
    const admin = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
            SELECT 1 FROM public."User" WHERE role = 'admin'
        ) AS present
    `);
    if (admin.rows[0]?.present !== true) {
        throw new RestoreError(
            "BACKUP_HAS_NO_ADMIN",
            "This backup has no admin account.",
        );
    }
    await updatePhase(restoreId, "reencrypting");
    return reencryptRestoredCredentials(client, options.backupKey, currentKey);
}

async function loadRestoreData(
    client: Client,
    restoreId: string,
    options: StartJobOptions,
    state: RestoreExecutionState,
    signal: AbortSignal,
): Promise<void> {
    const prepared = state.prepared;
    const currentKey = state.currentKey;
    if (!prepared || !currentKey) throw new Error("Restore was not prepared");
    const progress = initialProgress(prepared.validated);
    state.progress = progress;
    const reportProgress = createProgressWriter(restoreId);
    await reportProgress(progress, true);
    await loadBackupData(
        client,
        options.filePath,
        prepared.validated.header,
        (latest) => {
            void reportProgress(latest).catch((error) =>
                logger.warn("Could not update restore progress", error),
            );
        },
        async (transactionClient) => {
            state.firstPass = await reencryptBeforeCommit(
                transactionClient,
                restoreId,
                options,
                currentKey,
            );
        },
        () => {
            state.loadCommitted = true;
        },
        signal,
    );
    state.progress = {
        completedTables: progress.totalTables,
        totalTables: progress.totalTables,
        completedRows: progress.totalRows,
        totalRows: progress.totalRows,
    };
    await reportProgress(state.progress, true);
}

function combineCredentials(
    firstPass: CredentialResult,
    secondPass: ReencryptSummary,
): ReencryptSummary {
    return {
        credentialsReencrypted:
            firstPass.credentialsReencrypted +
            secondPass.credentialsReencrypted,
        credentialsUndecryptable:
            firstPass.credentialsUndecryptable +
            secondPass.credentialsUndecryptable,
    };
}

async function migrateLoadedData(
    client: Client,
    restoreId: string,
    options: StartJobOptions,
    state: RestoreExecutionState,
    signal?: AbortSignal,
): Promise<ReencryptSummary> {
    if (!state.progress || !state.currentKey) {
        throw new Error("Restore data was not loaded");
    }
    await updatePhase(restoreId, "migrating", state.progress);
    state.migrateStarted = true;
    await deployCurrentMigrations(config.databaseUrl, signal);
    const secondPass = await reencryptRestoredCredentials(
        client,
        options.backupKey,
        state.currentKey,
        new Set(state.firstPass.processedColumns),
    );
    return combineCredentials(state.firstPass, secondPass);
}

function createProgressWriter(
    restoreId: string,
): (progress: RestoreProgress, force?: boolean) => Promise<void> {
    let wroteProgress = false;
    let lastWriteAt = 0;
    return async (progress, force = false) => {
        const now = Date.now();
        if (
            !force &&
            wroteProgress &&
            now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS
        ) {
            return;
        }
        await updatePhase(restoreId, "loading", progress);
        wroteProgress = true;
        lastWriteAt = now;
    };
}

async function finishRestore(
    restoreId: string,
    options: StartJobOptions,
    validated: ArchiveValidation,
    compatibility: CompatibleRestore,
    progress: RestoreProgress,
    credentials: ReencryptSummary,
): Promise<void> {
    const summary: RestoreSummary = {
        backupCreatedAt: validated.header.createdAt,
        backupAppVersion: validated.header.appVersion,
        appVersion: resolveAppVersion(),
        tables: validated.header.tables.length,
        rows: validated.rows,
        migrationsAppliedAfterLoad: compatibility.pendingAfterLoad,
        migrationChecksumWarnings: compatibility.checksumWarnings.length,
        credentialsReencrypted: credentials.credentialsReencrypted,
        credentialsUndecryptable: credentials.credentialsUndecryptable,
        apiKeysNeedReissue:
            options.backupPepperFingerprint !== getPepperFingerprint(),
    };
    try {
        await markRestartRequired();
    } catch (error) {
        logger.error(
            "Restore completed but restart-marker publication failed; restart soundspan before serving application traffic",
            error,
        );
    }
    await setRestoreStatus({
        restoreId,
        state: "complete",
        progress: {
            completedTables: summary.tables,
            totalTables: summary.tables,
            completedRows: summary.rows,
            totalRows: summary.rows,
        },
        error: null,
        summary,
    });
}

function newRestoreClient(): Client {
    return new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 2 * 60 * 60 * 1000,
    });
}

async function withFreshRestoreClient<T>(
    work: (client: Client) => Promise<T>,
): Promise<T> {
    const client = newRestoreClient();
    const onError = (error: Error): void => {
        logger.warn("Fresh restore database connection failed", error);
    };
    client.on("error", onError);
    try {
        await client.connect();
        return await work(client);
    } finally {
        client.off("error", onError);
        await client.end().catch(() => undefined);
    }
}

async function restoredDatabaseIsComplete(
    client: Client,
    state: RestoreExecutionState,
): Promise<boolean> {
    if (!state.prepared) return false;
    const applied = await client.query<{ migration_name: string }>(`
        SELECT migration_name
          FROM public._prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `);
    const appliedNames = new Set(applied.rows.map((row) => row.migration_name));
    const migrationsComplete = state.prepared.imageMigrations.every((entry) =>
        appliedNames.has(entry.name),
    );
    if (!migrationsComplete) return false;
    const users = await client.query<{ present: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM public."User") AS present
    `);
    return users.rows[0]?.present === true;
}

async function tryRecoverCommittedRestore(
    restoreId: string,
    options: StartJobOptions,
    state: RestoreExecutionState,
): Promise<boolean> {
    const prepared = state.prepared;
    const progress = state.progress;
    if (
        !state.loadCommitted ||
        !state.migrateStarted ||
        !prepared ||
        !progress ||
        !state.currentKey
    ) {
        return false;
    }
    try {
        return await withFreshRestoreClient(async (client) => {
            if (!(await restoredDatabaseIsComplete(client, state)))
                return false;
            const credentials = await migrateLoadedData(
                client,
                restoreId,
                options,
                state,
            );
            await finishRestore(
                restoreId,
                options,
                prepared.validated,
                prepared.compatibility,
                progress,
                credentials,
            );
            return true;
        });
    } catch (error) {
        logger.error("Restore recovery after connection loss failed", error);
        return false;
    }
}

async function handleRestoreFailure(
    restoreId: string,
    options: StartJobOptions,
    state: RestoreExecutionState,
    failure: unknown,
): Promise<void> {
    logger.error("Restore job failed", failure);
    if (failure instanceof RestoreMigrationError) {
        logger.error("Restore migration output", {
            outputTail: failure.outputTail,
        });
    }
    if (await tryRecoverCommittedRestore(restoreId, options, state)) return;
    let reportedFailure = safeFailure(failure);
    if (state.resetStarted) {
        try {
            await withFreshRestoreClient(cleanupFreshInstall);
            logger.info("Restore failure cleanup completed");
        } catch (cleanupFailure) {
            logger.error("Restore failure cleanup failed", cleanupFailure);
            reportedFailure = {
                code: "RESTORE_CLEANUP_FAILED",
                message:
                    "The restore failed and the database could not be reset to a fresh install. Check the server logs.",
            };
        }
    }
    await setRestoreStatus({
        restoreId,
        state: "failed",
        progress: null,
        error: reportedFailure,
        summary: null,
    }).catch((error) => logger.warn("Could not report restore failure", error));
}

async function releaseRestoreResources(
    client: Client,
    options: StartJobOptions,
    replayDir: string | null,
): Promise<void> {
    await client
        .query("SELECT pg_advisory_unlock($1)", [RESTORE_ADVISORY_LOCK])
        .catch(() => undefined);
    await client.end().catch(() => undefined);
    await fs.unlink(options.filePath).catch(() => undefined);
    if (replayDir) {
        await fs
            .rm(replayDir, { recursive: true, force: true })
            .catch(() => undefined);
    }
    await releaseRestoreUpload(options.uploadId).catch(() => undefined);
    invalidateRestoreLockCache();
}

function assertRestoreConnection(
    signal: AbortSignal,
    getConnectionError: () => Error | null,
): void {
    signal.throwIfAborted();
    const error = getConnectionError();
    if (error) throw error;
}

async function runRestorePhases(
    client: Client,
    restoreId: string,
    options: StartJobOptions,
    state: RestoreExecutionState,
    signal: AbortSignal,
    getConnectionError: () => Error | null,
): Promise<void> {
    state.prepared = await prepareRestore(options.filePath, options.macKey);
    assertRestoreConnection(signal, getConnectionError);
    state.replayDir = path.join(restoreStagingDirectory(), "migration-replay");
    await updatePhase(restoreId, "resetting");
    await resetApplicationSchema(client, {
        onCommitted: () => {
            state.resetStarted = true;
        },
    });
    assertRestoreConnection(signal, getConnectionError);
    await updatePhase(restoreId, "replaying");
    await replayBackupMigrations(
        restoreStagingDirectory(),
        state.prepared.compatibility.migrationsToReplay,
        config.databaseUrl,
        signal,
    );
    assertRestoreConnection(signal, getConnectionError);
    state.currentKey = getSettingsEncryptionKey();
    await loadRestoreData(client, restoreId, options, state, signal);
    assertRestoreConnection(signal, getConnectionError);
    const credentials = await migrateLoadedData(
        client,
        restoreId,
        options,
        state,
        signal,
    );
    assertRestoreConnection(signal, getConnectionError);
    if (!state.progress) throw new Error("Restore progress was not recorded");
    await finishRestore(
        restoreId,
        options,
        state.prepared.validated,
        state.prepared.compatibility,
        state.progress,
        credentials,
    );
}

async function executeRestoreJob(
    client: Client,
    restoreId: string,
    options: StartJobOptions,
    connectionFailure: Promise<Error>,
    detachClientError: () => void,
    getConnectionError: () => Error | null,
): Promise<void> {
    const state = createExecutionState();
    const controller = new AbortController();
    const work = runRestorePhases(
        client,
        restoreId,
        options,
        state,
        controller.signal,
        getConnectionError,
    );
    try {
        await Promise.race([
            work,
            connectionFailure.then((error) => {
                controller.abort(error);
                throw error;
            }),
        ]);
    } catch (error) {
        controller.abort(error);
        await work.catch(() => undefined);
        await handleRestoreFailure(restoreId, options, state, error);
    } finally {
        await releaseRestoreResources(client, options, state.replayDir);
        detachClientError();
    }
}

interface RestoreClientHandle {
    client: Client;
    connectionFailure: Promise<Error>;
    detachClientError: () => void;
    getConnectionError: () => Error | null;
}

async function acquireRestoreClient(): Promise<RestoreClientHandle> {
    const client = newRestoreClient();
    let resolveFailure: (error: Error) => void = () => undefined;
    let connectionError: Error | null = null;
    const connectionFailure = new Promise<Error>((resolve) => {
        resolveFailure = resolve;
    });
    const onError = (error: Error): void => {
        connectionError = error;
        resolveFailure(error);
    };
    client.on("error", onError);
    const detachClientError = (): void => {
        client.off("error", onError);
    };
    try {
        await client.connect();
        const result = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS acquired",
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
            client,
            connectionFailure,
            detachClientError,
            getConnectionError: () => connectionError,
        };
    } catch (error) {
        await client.end().catch(() => undefined);
        detachClientError();
        invalidateRestoreLockCache();
        throw error;
    }
}

/** Start a detached restore whose failures are reported only through status. */
export async function startRestoreJob(
    options: StartJobOptions,
): Promise<string> {
    const restoreId = crypto.randomUUID();
    let handle: RestoreClientHandle;
    try {
        handle = await acquireRestoreClient();
    } catch (error) {
        await fs.unlink(options.filePath).catch(() => undefined);
        await releaseRestoreUpload(options.uploadId).catch(() => undefined);
        throw error;
    }
    try {
        await setRestoreStatus({
            restoreId,
            state: "validating",
            progress: null,
            error: null,
            summary: null,
        });
        await releaseRestoreUpload(options.uploadId);
        void executeRestoreJob(
            handle.client,
            restoreId,
            options,
            handle.connectionFailure,
            handle.detachClientError,
            handle.getConnectionError,
        ).catch((error) => logger.error("Detached restore job failed", error));
        return restoreId;
    } catch (error) {
        await releaseRestoreResources(handle.client, options, null);
        handle.detachClientError();
        throw error;
    }
}
