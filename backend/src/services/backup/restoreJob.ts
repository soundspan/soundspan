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

type CompatibleRestore = Extract<CompatibilityResult, { outcome: "ok" }>;

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
    return { validated, compatibility };
}

function initialProgress(validated: ArchiveValidation): RestoreProgress {
    return {
        completedTables: 0,
        totalTables: validated.header.tables.length,
        completedRows: 0,
        totalRows: validated.rows,
    };
}

async function loadAndMigrate(
    client: Client,
    restoreId: string,
    filePath: string,
    validated: ArchiveValidation,
    options: StartJobOptions,
    currentKey: string,
): Promise<{ progress: RestoreProgress; credentials: ReencryptSummary }> {
    const progress = initialProgress(validated);
    const reportProgress = createProgressWriter(restoreId);
    await reportProgress(progress, true);
    let firstPass: Awaited<ReturnType<typeof reencryptRestoredCredentials>> = {
        credentialsReencrypted: 0,
        credentialsUndecryptable: 0,
        processedColumns: [],
    };
    await loadBackupData(
        client,
        filePath,
        validated.header,
        async (latest) => {
            await reportProgress(latest).catch((error) =>
                logger.warn("Could not update restore progress", error),
            );
        },
        async (transactionClient) => {
            const admin = await transactionClient.query<{ present: boolean }>(
                `SELECT EXISTS (
                    SELECT 1 FROM public."User" WHERE role = 'admin'
                ) AS present`,
            );
            if (admin.rows[0]?.present !== true) {
                throw new RestoreError(
                    "BACKUP_HAS_NO_ADMIN",
                    "This backup has no admin account.",
                );
            }
            await updatePhase(restoreId, "reencrypting");
            firstPass = await reencryptRestoredCredentials(
                transactionClient,
                options.backupKey,
                currentKey,
            );
        },
    );
    const completeProgress: RestoreProgress = {
        completedTables: progress.totalTables,
        totalTables: progress.totalTables,
        completedRows: progress.totalRows,
        totalRows: progress.totalRows,
    };
    await reportProgress(completeProgress, true);
    await updatePhase(restoreId, "migrating", completeProgress);
    await deployCurrentMigrations(config.databaseUrl);
    const secondPass = await reencryptRestoredCredentials(
        client,
        options.backupKey,
        currentKey,
        new Set(firstPass.processedColumns),
    );
    return {
        progress: completeProgress,
        credentials: {
            credentialsReencrypted:
                firstPass.credentialsReencrypted +
                secondPass.credentialsReencrypted,
            credentialsUndecryptable:
                firstPass.credentialsUndecryptable +
                secondPass.credentialsUndecryptable,
        },
    };
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
    await markRestartRequired();
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

async function handleRestoreFailure(
    client: Client,
    restoreId: string,
    resetStarted: boolean,
    failure: unknown,
): Promise<void> {
    logger.error("Restore job failed", failure);
    if (failure instanceof RestoreMigrationError) {
        logger.error("Restore migration output", {
            outputTail: failure.outputTail,
        });
    }
    let reportedFailure = safeFailure(failure);
    if (resetStarted) {
        try {
            await cleanupFreshInstall(client);
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
    });
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

async function executeRestoreJob(
    client: Client,
    restoreId: string,
    options: StartJobOptions,
    connectionFailure: Promise<Error>,
    detachClientError: () => void,
    getConnectionError: () => Error | null,
): Promise<void> {
    let resetStarted = false;
    let replayDir: string | null = null;
    try {
        await Promise.race([
            (async () => {
                const { validated, compatibility } = await prepareRestore(
                    options.filePath,
                    options.macKey,
                );
                const assertConnected = (): void => {
                    const error = getConnectionError();
                    if (error) throw error;
                };
                assertConnected();
                replayDir = path.join(
                    restoreStagingDirectory(),
                    "migration-replay",
                );
                await updatePhase(restoreId, "resetting");
                await resetApplicationSchema(client);
                assertConnected();
                resetStarted = true;
                await updatePhase(restoreId, "replaying");
                await replayBackupMigrations(
                    restoreStagingDirectory(),
                    compatibility.migrationsToReplay,
                    config.databaseUrl,
                );
                assertConnected();
                const currentKey = getSettingsEncryptionKey();
                const loaded = await loadAndMigrate(
                    client,
                    restoreId,
                    options.filePath,
                    validated,
                    options,
                    currentKey,
                );
                assertConnected();
                await finishRestore(
                    restoreId,
                    options,
                    validated,
                    compatibility,
                    loaded.progress,
                    loaded.credentials,
                );
            })(),
            connectionFailure.then((error) => {
                throw error;
            }),
        ]);
    } catch (error) {
        await handleRestoreFailure(client, restoreId, resetStarted, error);
    } finally {
        await releaseRestoreResources(client, options, replayDir);
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
    const client = new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 2 * 60 * 60 * 1000,
    });
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
