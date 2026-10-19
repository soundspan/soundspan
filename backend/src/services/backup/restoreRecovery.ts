import type { Client } from "pg";
import { config } from "../../config";
import { logger as rootLogger } from "../../utils/logger";
import { BackupError, RestoreMigrationError } from "./backupErrors";
import { finishCommittedRestore } from "./restoreCompletion";
import {
    withRecoveryRestoreClient,
    type RestoreClientHandle,
} from "./restoreClient";
import { deployCurrentMigrations } from "./restoreMigrationReplay";
import { markRestartRequired } from "./restartRequired";
import { resetApplicationSchema } from "./restoreSchemaReset";
import { setTerminalRestoreStatus } from "./restoreStatus";
import type {
    RestoreExecutionState,
    StartRestoreJobOptions,
} from "./restoreJobTypes";

const logger = rootLogger.child("BackupRestore");
const FINISH_INCOMPLETE_MESSAGE =
    "Your data was restored, but the last steps didn't finish. Restart soundspan; startup applies any remaining database changes. Check stored service connections afterwards.";

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

function logFailure(failure: unknown): void {
    logger.error("Restore job failed", failure);
    if (failure instanceof RestoreMigrationError) {
        logger.error("Restore migration output", {
            outputTail: failure.outputTail,
        });
    }
}

async function reportFailure(
    restoreId: string,
    error: { code: string; message: string },
): Promise<void> {
    await setTerminalRestoreStatus({
        restoreId,
        state: "failed",
        progress: null,
        error,
        summary: null,
    });
}

async function committedUserExists(client: Client): Promise<boolean> {
    const users = await client.query<{ present: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM public."User") AS present
    `);
    return users.rows[0]?.present === true;
}

async function loadWasCommitted(
    client: Client,
    state: RestoreExecutionState,
): Promise<boolean> {
    if (!state.loadCommitted) return false;
    if (state.loadCommitConfirmed) return true;
    return committedUserExists(client);
}

async function cleanupFreshInstall(client: Client): Promise<void> {
    await resetApplicationSchema(client, { allowExistingUsers: true });
    await deployCurrentMigrations(config.databaseUrl);
}

async function reportCleanupResult(
    client: Client,
    restoreId: string,
    failure: unknown,
    markIfCleanupFails: boolean,
): Promise<void> {
    let reported = safeFailure(failure);
    try {
        await cleanupFreshInstall(client);
        logger.info("Restore failure cleanup completed");
    } catch (cleanupFailure) {
        logger.error("Restore failure cleanup failed", cleanupFailure);
        reported = {
            code: "RESTORE_CLEANUP_FAILED",
            message:
                "The restore failed and the database could not be reset to a fresh install. Check the server logs.",
        };
        if (markIfCleanupFails) {
            await markRestartAfterIncompleteFinish(restoreId);
        }
    }
    await reportFailure(restoreId, reported);
}

async function markRestartAfterIncompleteFinish(
    restoreId: string,
): Promise<void> {
    try {
        await markRestartRequired(Date.now(), restoreId);
    } catch (markerFailure) {
        logger.error(
            "Restore finish failed and restart-marker publication also failed",
            markerFailure,
        );
    }
}

async function finishPreservingData(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
): Promise<void> {
    try {
        await finishCommittedRestore(client, restoreId, options, state);
    } catch (finishFailure) {
        logger.error("Restore post-commit finishing failed", finishFailure);
        await markRestartAfterIncompleteFinish(restoreId);
        await reportFailure(restoreId, {
            code: "RESTORE_FINISH_INCOMPLETE",
            message: FINISH_INCOMPLETE_MESSAGE,
        });
    }
}

async function recoverWithLock(
    client: Client,
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
    failure: unknown,
): Promise<void> {
    if (await loadWasCommitted(client, state)) {
        await finishPreservingData(client, restoreId, options, state);
        return;
    }
    await reportCleanupResult(client, restoreId, failure, state.loadCommitted);
}

/** Recover a failed restore without ever resetting a committed data load. */
export async function handleRestoreFailure(
    restoreId: string,
    options: StartRestoreJobOptions,
    state: RestoreExecutionState,
    failure: unknown,
    originalClient: RestoreClientHandle,
): Promise<void> {
    logFailure(failure);
    if (!state.resetStarted && !state.loadCommitted) {
        await reportFailure(restoreId, safeFailure(failure));
        return;
    }
    try {
        await withRecoveryRestoreClient(originalClient, (client) =>
            recoverWithLock(client, restoreId, options, state, failure),
        );
    } catch (recoveryFailure) {
        logger.error("Restore failure recovery failed", recoveryFailure);
        if (state.loadCommitted) {
            await markRestartAfterIncompleteFinish(restoreId);
        }
        await reportFailure(restoreId, {
            code: state.loadCommitted
                ? "RESTORE_FINISH_INCOMPLETE"
                : "RESTORE_CLEANUP_FAILED",
            message: state.loadCommitted
                ? FINISH_INCOMPLETE_MESSAGE
                : "The restore failed and the database could not be reset to a fresh install. Check the server logs.",
        });
    }
}
