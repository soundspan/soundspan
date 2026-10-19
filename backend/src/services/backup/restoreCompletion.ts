import type { Client } from "pg";
import { config } from "../../config";
import { resolveAppVersion } from "../../config/appVersion";
import { getPepperFingerprint } from "../../utils/apiKeyHash";
import { deployCurrentMigrations } from "./restoreMigrationReplay";
import {
    reencryptRestoredCredentials,
    type ReencryptSummary,
} from "./restoreReencrypt";
import { markRestartRequired } from "./restartRequired";
import { setRestoreStatus, setTerminalRestoreStatus } from "./restoreStatus";
import type {
    RestoreExecutionState,
    StartRestoreJobOptions,
} from "./restoreJobTypes";
import type { RestoreSummary } from "./restoreStatus";

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
    signal?: AbortSignal,
): Promise<ReencryptSummary> {
    if (!state.currentKey) throw new Error("Restore key was not prepared");
    await setRestoreStatus({
        restoreId,
        state: "migrating",
        progress: state.progress,
        error: null,
        summary: null,
    });
    await deployCurrentMigrations(config.databaseUrl, signal);
    const secondPass = await reencryptRestoredCredentials(
        client,
        options.backupKey,
        state.currentKey,
        new Set(state.firstPass.processedColumns),
    );
    return combineCredentialResults(state, secondPass);
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

/** Finish migrations, credential rotation, restart fencing, and status. */
export async function finishCommittedRestore(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
    signal?: AbortSignal,
): Promise<void> {
    const credentials = await migrateAndReencrypt(
        client,
        restoreId,
        options,
        state,
        signal,
    );
    const summary = buildSummary(options, state, credentials);
    await markRestartRequired();
    await publishCompleteStatus(restoreId, summary);
}
