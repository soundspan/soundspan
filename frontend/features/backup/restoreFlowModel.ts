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
    | { kind: "unavailable" }
    | { kind: "reconnecting" }
    | { kind: "starting" }
    | { kind: "restoring"; status: RestoreStatus | null }
    | { kind: "complete"; status: RestoreStatus }
    | { kind: "failed"; message: string; freshInstallIntact: boolean };

/** Flow steps that keep following the server's status. */
export const POLLING_FLOW_KINDS: ReadonlySet<RestoreFlow["kind"]> = new Set([
    "otherUpload",
    "unavailable",
    "reconnecting",
    "restoring",
]);

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
 * form; an upload this page didn't start shows when it expires; a server
 * that can't take a restore right now is followed until it can.
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
    return status.available
        ? { kind: "form", error: null }
        : { kind: "unavailable" };
}

/** How the page recovers from a failed upload or start. */
export type StartErrorOutcome =
    | { kind: "passphrase"; error: string }
    | { kind: "form"; error: string }
    | { kind: "recheck" };

/**
 * Decide how to recover from a failed upload or start. A rejected
 * passphrase on the start request (or a start the server refused without a
 * code) keeps the uploaded file so only the passphrase is retyped. A start
 * that failed without a clear answer (network error, timeout, 5xx) may have
 * started the restore anyway, so the page re-reads the status first.
 */
export function classifyStartError(
    error: unknown,
    fromStart: boolean,
): StartErrorOutcome {
    const code = chunkErrorCode(error);
    const status = readApiErrorStatus(error);
    const fallback = error instanceof Error ? error.message : GENERIC_FAILURE;
    const message = restoreErrorMessage(code, fallback || GENERIC_FAILURE);
    if (!fromStart) return { kind: "form", error: message };
    if (
        code === "BACKUP_PASSPHRASE_INVALID" ||
        (code === undefined && status === 400)
    ) {
        return { kind: "passphrase", error: message };
    }
    if (code === undefined && (status === undefined || status >= 500)) {
        return { kind: "recheck" };
    }
    return { kind: "form", error: message };
}
