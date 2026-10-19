import type { RestoreStatus } from "@/lib/api/backup";
import {
    RESTORE_FINISH_INCOMPLETE,
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
    | { kind: "reconnecting"; statusUnavailable: boolean }
    | { kind: "starting" }
    | { kind: "restoring"; status: RestoreStatus | null }
    | { kind: "complete"; status: RestoreStatus }
    | { kind: "restoredIncomplete"; message: string }
    | {
          kind: "failed";
          message: string;
          freshInstallIntact: boolean;
          canRestoreAgain: boolean;
      };

/** Flow steps that keep following the server's status. */
export const POLLING_FLOW_KINDS: ReadonlySet<RestoreFlow["kind"]> = new Set([
    "otherUpload",
    "unavailable",
    "reconnecting",
    "restoring",
]);

/**
 * A failure is shown with its message. Another restore may start when the
 * failure left a fresh install, or when the server is available again (no
 * account exists, for example because the database was reset since): a new
 * restore resets the schema itself.
 */
function failedFlow(status: RestoreStatus): RestoreFlow {
    const code = status.error?.code;
    if (code === RESTORE_FINISH_INCOMPLETE) {
        return {
            kind: "restoredIncomplete",
            message: restoreErrorMessage(code, status.error?.message ?? ""),
        };
    }
    const freshInstallIntact = isFreshInstallIntact(code);
    return {
        kind: "failed",
        message: restoreErrorMessage(
            code,
            status.error?.message || GENERIC_FAILURE,
        ),
        freshInstallIntact,
        canRestoreAgain: freshInstallIntact || status.available,
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

/** Proxy answers that say nothing about whether the server got the request. */
const UNCLEAR_PROXY_CODES: ReadonlySet<string> = new Set([
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_UNAVAILABLE",
    "API_PROXY_UNAVAILABLE",
]);

function isUnclearAnswer(code: string | undefined, status: number | undefined) {
    if (code !== undefined) {
        return UNCLEAR_PROXY_CODES.has(code) || code === "RESTORE_IN_PROGRESS";
    }
    return status === undefined || status === 408 || status >= 500;
}

const RATE_LIMITED =
    "Too many restore attempts. Wait a minute, then type the passphrase again.";

/**
 * Decide how to recover from a failed upload or start. A rejected
 * passphrase on the start request (or a start the server refused without a
 * code, or a rate limit) keeps the uploaded file so only the passphrase is
 * retyped. A start that failed without a clear answer (network error,
 * timeout, 5xx, a proxy's own error, or "a restore is in progress") may have
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
    if (status === 429) return { kind: "passphrase", error: RATE_LIMITED };
    if (isUnclearAnswer(code, status)) return { kind: "recheck" };
    return { kind: "form", error: message };
}
