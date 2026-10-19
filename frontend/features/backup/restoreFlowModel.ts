import type { RestoreStatus } from "@/lib/api/backup";
import {
    isRestoreRunning,
    readApiErrorCode,
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
    | { kind: "starting" }
    | { kind: "restoring"; status: RestoreStatus | null }
    | { kind: "complete"; status: RestoreStatus }
    | { kind: "failed"; message: string; freshInstallIntact: boolean };

/** Map a status snapshot to the flow step it implies. */
export function flowFromStatus(status: RestoreStatus): RestoreFlow {
    if (status.state === "complete") {
        return { kind: "complete", status };
    }
    if (status.state === "failed") {
        const message = restoreErrorMessage(
            status.error?.code,
            status.error?.message || GENERIC_FAILURE,
        );
        return {
            kind: "failed",
            message,
            freshInstallIntact: status.error?.code !== "RESTORE_CLEANUP_FAILED",
        };
    }
    if (isRestoreRunning(status.state)) {
        return { kind: "restoring", status };
    }
    return { kind: "form", error: null };
}

/** Map a failed start or upload to the flow step that lets the user recover. */
export function flowFromStartError(
    error: unknown,
    uploadKept: boolean,
): RestoreFlow {
    const code = readApiErrorCode(error);
    const fallback = error instanceof Error ? error.message : GENERIC_FAILURE;
    const message = restoreErrorMessage(code, fallback || GENERIC_FAILURE);
    if (uploadKept && code === "BACKUP_PASSPHRASE_INVALID") {
        return { kind: "passphrase", error: message };
    }
    return { kind: "form", error: message };
}
