import crypto from "crypto";
import fs from "fs/promises";
import { logger as rootLogger } from "../../utils/logger";
import {
    acquireRestoreClient,
    releaseRestoreClient,
    type RestoreClientHandle,
} from "./restoreClient";
import {
    createRestoreExecutionState,
    type StartRestoreJobOptions,
} from "./restoreJobTypes";
import { runRestorePhases } from "./restorePhases";
import { handleRestoreFailure } from "./restoreRecovery";
import { releaseRestoreUpload } from "./restoreUploads";
import { setRestoreStatus } from "./restoreStatus";
export {
    getRestoreStatus,
    isRestoreJobActive,
    setRestoreStatus,
} from "./restoreStatus";

const logger = rootLogger.child("BackupRestore");

async function releaseRestoreFiles(
    options: StartRestoreJobOptions,
    replayDir: string | null,
): Promise<void> {
    await fs.unlink(options.filePath).catch(() => undefined);
    if (replayDir) {
        await fs
            .rm(replayDir, { recursive: true, force: true })
            .catch(() => undefined);
    }
    await releaseRestoreUpload(options.uploadId).catch(() => undefined);
}

async function settleWorkAfterRace(
    work: Promise<void>,
    error: unknown,
): Promise<{ completed: boolean; failure: unknown }> {
    try {
        await work;
        return { completed: true, failure: error };
    } catch (workFailure) {
        return { completed: false, failure: workFailure ?? error };
    }
}

async function executeRestoreJob(
    handle: RestoreClientHandle,
    restoreId: string,
    options: StartRestoreJobOptions,
): Promise<void> {
    const state = createRestoreExecutionState();
    const controller = new AbortController();
    const work = runRestorePhases(
        handle.client,
        restoreId,
        options,
        state,
        controller.signal,
        handle.getConnectionError,
    );
    try {
        await Promise.race([
            work,
            handle.connectionFailure.then((error) => {
                controller.abort(error);
                throw error;
            }),
        ]);
    } catch (error) {
        controller.abort(error);
        const settled = await settleWorkAfterRace(work, error);
        if (!settled.completed) {
            await handleRestoreFailure(
                restoreId,
                options,
                state,
                settled.failure,
                handle,
            );
        }
    } finally {
        await releaseRestoreClient(handle);
        await releaseRestoreFiles(options, state.replayDir);
    }
}

async function acquireOrDiscardUpload(
    options: StartRestoreJobOptions,
): Promise<RestoreClientHandle> {
    try {
        return await acquireRestoreClient();
    } catch (error) {
        await fs.unlink(options.filePath).catch(() => undefined);
        await releaseRestoreUpload(options.uploadId).catch(() => undefined);
        throw error;
    }
}

async function startDetachedExecution(
    handle: RestoreClientHandle,
    restoreId: string,
    options: StartRestoreJobOptions,
): Promise<void> {
    await releaseRestoreUpload(options.uploadId);
    await setRestoreStatus({
        restoreId,
        state: "validating",
        progress: null,
        error: null,
        summary: null,
    });
    void executeRestoreJob(handle, restoreId, options).catch((error) =>
        logger.error("Detached restore job failed", error),
    );
}

/** Start a detached restore whose failures are reported only through status. */
export async function startRestoreJob(
    options: StartRestoreJobOptions,
): Promise<string> {
    const restoreId = crypto.randomUUID();
    const handle = await acquireOrDiscardUpload(options);
    try {
        await startDetachedExecution(handle, restoreId, options);
        return restoreId;
    } catch (error) {
        await releaseRestoreClient(handle);
        await releaseRestoreFiles(options, null);
        throw error;
    }
}
