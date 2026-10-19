import type { RestoreStatus } from "@/lib/api/backup";
import {
    chunkErrorCode,
    isFreshInstallIntact,
    isRestoreRunning,
    readApiErrorStatus,
    restoreErrorMessage,
} from "./backupRestoreModel";

const GENERIC_FAILURE =
    "The restore didn't finish. Check the server logs, then try again.";

/** Where the restore page is in its flow. */
export type RestoreFlow =
    | { kind: "checking" }
    | { kind: "form"; error: string | null }
    | { kind: "passphrase"; error: string }
    | { kind: "uploading"; sentBytes: number; totalBytes: number }
    | { kind: "otherUpload"; expiresAt: string | null }
    | { kind: "starting" }
    | { kind: "restoring"; status: RestoreStatus | null }
    | { kind: "complete"; status: RestoreStatus }
    | { kind: "failed"; message: string; freshInstallIntact: boolean };

function failedFlow(status: RestoreStatus): RestoreFlow {
    const code = status.error?.code;
    return {
        kind: "failed",
        message: restoreErrorMessage(
            code,
            status.error?.message || GENERIC_FAILURE,
        ),
        freshInstallIntact: isFreshInstallIntact(code),
    };
}

/**
 * Map a status snapshot to the flow step it implies. A finished restore
 * whose server is available again (its database was wiped since) shows the
 * form; an upload this page didn't start shows when it expires.
 */
export function flowFromStatus(status: RestoreStatus): RestoreFlow {
    if (status.state === "complete") {
        if (status.available && !status.restartRequired) {
            return { kind: "form", error: null };
        }
        return { kind: "complete", status };
    }
    if (status.state === "failed") {
        return failedFlow(status);
    }
    if (status.state === "uploading") {
        return {
            kind: "otherUpload",
            expiresAt: status.upload?.expiresAt ?? null,
        };
    }
    if (isRestoreRunning(status.state)) {
        return { kind: "restoring", status };
    }
    return { kind: "form", error: null };
}

/**
 * Map a failed start or upload to the flow step that lets the user recover.
 * A rejected passphrase, or a request the server refused without a code,
 * keeps the uploaded file so only the passphrase is retyped.
 */
export function flowFromStartError(
    error: unknown,
    uploadKept: boolean,
): RestoreFlow {
    const code = chunkErrorCode(error);
    const fallback = error instanceof Error ? error.message : GENERIC_FAILURE;
    const message = restoreErrorMessage(code, fallback || GENERIC_FAILURE);
    const passphraseRejected =
        code === "BACKUP_PASSPHRASE_INVALID" ||
        (code === undefined && readApiErrorStatus(error) === 400);
    if (uploadKept && passphraseRejected) {
        return { kind: "passphrase", error: message };
    }
    return { kind: "form", error: message };
}
