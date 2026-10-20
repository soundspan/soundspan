import type { ArchiveValidation } from "./backupArchiveReader";
import type { CompatibilityResult } from "./restoreCompatibility";
import type { RestoreProgress } from "./restoreDataLoad";
import type { reencryptRestoredCredentials } from "./restoreReencrypt";

/** Inputs retained for the lifetime of one detached restore job. */
export interface StartRestoreJobOptions {
    uploadId: string;
    filePath: string;
    backupKey: string;
    backupPepperFingerprint: string | null;
    macKey: Buffer;
}

/** Successful compatibility result retained by restore execution. */
export type CompatibleRestore = Extract<CompatibilityResult, { outcome: "ok" }>;
/** Detailed first-pass credential rotation result retained for completion. */
export type CredentialResult = Awaited<
    ReturnType<typeof reencryptRestoredCredentials>
>;

/** Validated archive and migration compatibility retained across recovery. */
export interface PreparedRestore {
    validated: ArchiveValidation;
    compatibility: CompatibleRestore;
}

/** Mutable phase facts needed to choose destructive or preserving recovery. */
export interface RestoreExecutionState {
    prepared: PreparedRestore | null;
    progress: RestoreProgress | null;
    firstPass: CredentialResult;
    currentKey: string | null;
    resetStarted: boolean;
    loadCommitted: boolean;
    loadCommitConfirmed: boolean;
    replayDir: string | null;
}

/** Create an isolated execution state for one restore attempt. */
export function createRestoreExecutionState(): RestoreExecutionState {
    return {
        prepared: null,
        progress: null,
        firstPass: {
            credentialsReencrypted: 0,
            credentialsUndecryptable: 0,
            processedColumns: [],
        },
        currentKey: null,
        resetStarted: false,
        loadCommitted: false,
        loadCommitConfirmed: false,
        replayDir: null,
    };
}
