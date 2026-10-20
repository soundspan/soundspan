import path from "path";
import type { Client } from "pg";
import { config } from "../../config";
import { getSettingsEncryptionKey } from "../../utils/encryption";
import { logger as rootLogger } from "../../utils/logger";
import {
    validateBackupArchive,
    type ArchiveValidation,
} from "./backupArchiveReader";
import { RestoreError } from "./backupErrors";
import {
    evaluateRestoreCompatibility,
    readImageMigrations,
} from "./restoreCompatibility";
import { finishCommittedRestore } from "./restoreCompletion";
import { loadBackupData, type RestoreProgress } from "./restoreDataLoad";
import { replayBackupMigrations } from "./restoreMigrationReplay";
import { reencryptRestoredCredentials } from "./restoreReencrypt";
import { resetApplicationSchema } from "./restoreSchemaReset";
import { restoreStagingDirectory } from "./restoreUploads";
import { setRestoreStatus, type RestoreState } from "./restoreStatus";
import type {
    CompatibleRestore,
    CredentialResult,
    RestoreExecutionState,
    StartRestoreJobOptions,
} from "./restoreJobTypes";

const logger = rootLogger.child("BackupRestore");
const BACKEND_ROOT = path.resolve(__dirname, "../../..");
const PROGRESS_WRITE_INTERVAL_MS = 1_000;

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
    signal: AbortSignal,
): Promise<{ validated: ArchiveValidation; compatibility: CompatibleRestore }> {
    const validated = await validateBackupArchive(filePath, macKey, signal);
    const image = await readImageMigrations(
        path.join(BACKEND_ROOT, "prisma", "migrations"),
    );
    const compatibility = evaluateRestoreCompatibility(
        validated.header.migrations,
        image,
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

function finalProgress(validated: ArchiveValidation): RestoreProgress {
    return {
        completedTables: validated.header.tables.length,
        totalTables: validated.header.tables.length,
        completedRows: validated.rows,
        totalRows: validated.rows,
    };
}

interface ProgressWriter {
    report: (progress: RestoreProgress) => void;
    flush: (progress: RestoreProgress) => Promise<void>;
}

function createProgressWriter(restoreId: string): ProgressWriter {
    let wroteProgress = false;
    let lastWriteAt = 0;
    let writes = Promise.resolve();
    const enqueue = (progress: RestoreProgress): void => {
        writes = writes.then(() => updatePhase(restoreId, "loading", progress));
        void writes.catch((error) =>
            logger.warn("Could not update restore progress", error),
        );
    };
    return {
        report(progress) {
            const now = Date.now();
            if (wroteProgress && now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS)
                return;
            wroteProgress = true;
            lastWriteAt = now;
            enqueue(progress);
        },
        async flush(progress) {
            wroteProgress = true;
            lastWriteAt = Date.now();
            enqueue(progress);
            await writes;
        },
    };
}

async function reencryptBeforeCommit(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
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
    return reencryptRestoredCredentials(client, options.backupKey, currentKey);
}

async function loadRestoreData(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
    signal: AbortSignal,
): Promise<void> {
    if (!state.prepared || !state.currentKey)
        throw new Error("Restore was not prepared");
    const prepared = state.prepared;
    const currentKey = state.currentKey;
    const writer = createProgressWriter(restoreId);
    state.progress = initialProgress(prepared.validated);
    await writer.flush(state.progress);
    await loadBackupData(
        client,
        options.filePath,
        prepared.validated.header,
        writer.report,
        async (transactionClient) => {
            state.progress = finalProgress(prepared.validated);
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
    state.loadCommitConfirmed = true;
    state.progress = finalProgress(prepared.validated);
    await writer.flush(state.progress);
    await updatePhase(restoreId, "reencrypting", state.progress);
}

function assertRestoreConnection(
    signal: AbortSignal,
    getConnectionError: () => Error | null,
): void {
    signal.throwIfAborted();
    const error = getConnectionError();
    if (error) throw error;
}

async function resetAndReplay(
    client: Client,
    restoreId: string,
    state: RestoreExecutionState,
    signal: AbortSignal,
): Promise<void> {
    if (!state.prepared) throw new Error("Restore was not prepared");
    state.replayDir = path.join(restoreStagingDirectory(), "migration-replay");
    await updatePhase(restoreId, "resetting");
    await resetApplicationSchema(client, {
        onCommitStarting: () => {
            state.resetStarted = true;
        },
    });
    signal.throwIfAborted();
    await updatePhase(restoreId, "replaying");
    await replayBackupMigrations(
        restoreStagingDirectory(),
        state.prepared.compatibility.migrationsToReplay,
        config.databaseUrl,
        signal,
    );
}

/** Run validation, reset, replay, load, and normal completion in order. */
export async function runRestorePhases(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
    signal: AbortSignal,
    getConnectionError: () => Error | null,
): Promise<void> {
    state.prepared = await prepareRestore(
        options.filePath,
        options.macKey,
        signal,
    );
    assertRestoreConnection(signal, getConnectionError);
    await resetAndReplay(client, restoreId, state, signal);
    assertRestoreConnection(signal, getConnectionError);
    state.currentKey = getSettingsEncryptionKey();
    await loadRestoreData(client, restoreId, options, state, signal);
    assertRestoreConnection(signal, getConnectionError);
    await finishCommittedRestore(client, restoreId, options, state);
}
