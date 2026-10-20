import type { Client } from "pg";
import { config } from "../../config";
import { resolveAppVersion } from "../../config/appVersion";
import { getPepperFingerprint } from "../../utils/apiKeyHash";
import { logger as rootLogger } from "../../utils/logger";
import { deployCurrentMigrations } from "./restoreMigrationReplay";
import {
    reencryptRestoredCredentials,
    type ReencryptSummary,
} from "./restoreReencrypt";
import { markRestartRequired, markRestoreComplete } from "./restartRequired";
import { setRestoreStatus, setTerminalRestoreStatus } from "./restoreStatus";
import type {
    RestoreExecutionState,
    StartRestoreJobOptions,
} from "./restoreJobTypes";
import type { RestoreSummary } from "./restoreStatus";

const logger = rootLogger.child("BackupRestore");

function combineCredentialResults(
    state: RestoreExecutionState,
    secondPass: ReencryptSummary,
): ReencryptSummary {
    return {
        credentialsReencrypted:
            state.firstPass.credentialsReencrypted +
            secondPass.credentialsReencrypted,
        credentialsUndecryptable:
            state.firstPass.credentialsUndecryptable +
            secondPass.credentialsUndecryptable,
    };
}

function buildSummary(
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
    credentials: ReencryptSummary,
): RestoreSummary {
    if (!state.prepared) throw new Error("Restore was not prepared");
    const { validated, compatibility } = state.prepared;
    return {
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
}

async function migrateAndReencrypt(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
): Promise<{ credentials: ReencryptSummary; migratingWrittenAt: number }> {
    if (!state.currentKey) throw new Error("Restore key was not prepared");
    const earlyMarkerAt = Date.now();
    await markRestartRequired(earlyMarkerAt, restoreId);
    const migratingWrittenAt = await setRestoreStatus(
        {
            restoreId,
            state: "migrating",
            progress: state.progress,
            error: null,
            summary: null,
        },
        earlyMarkerAt,
    );
    await deployCurrentMigrations(config.databaseUrl);
    const secondPass = await reencryptRestoredCredentials(
        client,
        options.backupKey,
        state.currentKey,
        new Set(state.firstPass.processedColumns),
    );
    return {
        credentials: combineCredentialResults(state, secondPass),
        migratingWrittenAt,
    };
}

async function publishCompleteStatus(
    restoreId: string,
    summary: RestoreSummary,
): Promise<void> {
    await setTerminalRestoreStatus({
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

async function publishCompletionMarker(
    completedAt: number,
    restoreId: string,
): Promise<void> {
    try {
        await markRestoreComplete(completedAt, restoreId);
    } catch (error) {
        logger.warn("Could not publish restore completion marker", error);
    }
}

/** Finish migrations, credential rotation, restart fencing, and status. */
export async function finishCommittedRestore(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
): Promise<void> {
    const completion = await migrateAndReencrypt(
        client,
        restoreId,
        options,
        state,
    );
    const summary = buildSummary(options, state, completion.credentials);
    await publishCompletionMarker(
        Math.max(Date.now(), completion.migratingWrittenAt + 1),
        restoreId,
    );
    await publishCompleteStatus(restoreId, summary);
}
