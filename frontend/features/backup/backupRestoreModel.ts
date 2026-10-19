import type { RestoreState, RestoreStatus } from "@/lib/api/backup";

/** Shortest passphrase the server accepts for a backup. */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;
/** Longest passphrase the server accepts for a backup. */
export const MAX_BACKUP_PASSPHRASE_LENGTH = 1024;
/** File extension of backups downloaded from the Admin page. */
export const BACKUP_FILE_EXTENSION = ".soundspan-backup";
/** How often one chunk is retried before the upload gives up. */
export const MAX_CHUNK_ATTEMPTS = 3;
/** How often the restore page asks the server for progress. */
export const RESTORE_STATUS_POLL_MS = 2000;

const RUNNING_STATES: ReadonlySet<RestoreState> = new Set([
    "uploading",
    "validating",
    "resetting",
    "replaying",
    "loading",
    "migrating",
    "reencrypting",
]);

const PHASE_LABELS: Record<RestoreState, string> = {
    idle: "Waiting for a backup",
    uploading: "Uploading the backup",
    validating: "Checking the backup file",
    resetting: "Clearing the empty database",
    replaying: "Preparing the database for the backup's version",
    loading: "Restoring your data",
    migrating: "Upgrading the restored data to this version",
    reencrypting: "Re-protecting stored passwords and service connections",
    complete: "Restore complete",
    failed: "Restore failed",
};

const ERROR_MESSAGES: Record<string, string> = {
    RESTORE_UNAVAILABLE:
        "This server already has an account, so it can't be restored over. Restore into a fresh install.",
    RESTORE_IN_PROGRESS:
        "Another restore is already running on this server. Wait for it to finish, then reload this page.",
    BACKUP_TOO_LARGE: "This file is larger than a backup can be.",
    INSUFFICIENT_STORAGE:
        "The server doesn't have enough free disk space to receive this backup.",
    RESTORE_UPLOAD_NOT_FOUND:
        "The upload expired or was cancelled. Start the restore again.",
    RESTORE_UPLOAD_WRONG_REPLICA:
        "Part of the upload reached a different backend replica. Run a single backend replica while you restore, then try again.",
    RESTORE_CHUNK_OUT_OF_ORDER:
        "The upload got out of step with the server. Start the restore again.",
    RESTORE_CHUNK_SIZE:
        "The upload got out of step with the server. Start the restore again.",
    RESTORE_INCOMPLETE_UPLOAD:
        "The server didn't receive the whole file. Start the restore again.",
    BACKUP_FORMAT_INVALID: `This file isn't a complete ${BACKUP_FILE_EXTENSION} backup.`,
    BACKUP_PASSPHRASE_INVALID:
        "That passphrase doesn't match this backup. Check it and try again.",
    BACKUP_NEWER_THAN_APP:
        "This backup comes from a newer version. Update this server to that version or later, then restore.",
    BACKUP_MIGRATION_CHECKSUM_MISMATCH:
        "This backup comes from a build whose database changes differ from this version's. Restore it into the same release it came from.",
};

/** Explain why a passphrase can't be used, or return null when it can. */
export function validateBackupPassphrase(
    passphrase: string,
    confirmation?: string,
): string | null {
    if (passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
        return `Use at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters.`;
    }
    if (passphrase.length > MAX_BACKUP_PASSPHRASE_LENGTH) {
        return `Use at most ${MAX_BACKUP_PASSPHRASE_LENGTH} characters.`;
    }
    if (confirmation !== undefined && confirmation !== passphrase) {
        return "The passphrases don't match.";
    }
    return null;
}

/** Byte range `[start, end)` of chunk `index` in a file of `fileSize` bytes. */
export function chunkRange(
    index: number,
    chunkSize: number,
    fileSize: number,
): { start: number; end: number } {
    const start = index * chunkSize;
    return { start, end: Math.min(start + chunkSize, fileSize) };
}

/** True while the server is still working on a restore. */
export function isRestoreRunning(state: RestoreState): boolean {
    return RUNNING_STATES.has(state);
}

/**
 * True when the first-run page must show the restore instead of account
 * creation: a restore is running, or it finished and waits for a restart.
 */
export function restoreHoldsFirstRun(status: RestoreStatus): boolean {
    return (
        isRestoreRunning(status.state) ||
        (status.state === "complete" && status.restartRequired)
    );
}

/** Plain-language label for a restore phase. */
export function restorePhaseLabel(state: RestoreState): string {
    return PHASE_LABELS[state];
}

/** Plain-language message for a restore or upload error code. */
export function restoreErrorMessage(
    code: string | undefined,
    fallback: string,
): string {
    if (code && ERROR_MESSAGES[code]) {
        return ERROR_MESSAGES[code];
    }
    return fallback;
}

/** Percent of rows restored so far, or null before the load phase starts. */
export function restoreProgressPercent(
    progress: RestoreStatus["progress"],
): number | null {
    if (!progress || progress.totalRows <= 0) {
        return null;
    }
    const ratio = progress.completedRows / progress.totalRows;
    return Math.max(0, Math.min(100, Math.floor(ratio * 100)));
}

/** Read the error code a failed API call carries, if any. */
export function readApiErrorCode(error: unknown): string | undefined {
    if (!(error instanceof Error) || !("data" in error)) {
        return undefined;
    }
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && "code" in data) {
        const code = (data as { code?: unknown }).code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}

/** Read the HTTP status a failed API call carries, if any. */
export function readApiErrorStatus(error: unknown): number | undefined {
    if (!(error instanceof Error) || !("status" in error)) {
        return undefined;
    }
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
}

/**
 * A failed chunk is worth retrying only for network failures and transient
 * server answers; contract errors (wrong replica, out of order, expired)
 * never fix themselves.
 */
export function isRetryableChunkError(error: unknown): boolean {
    const status = readApiErrorStatus(error);
    if (status === undefined) {
        return !(error instanceof DOMException && error.name === "AbortError");
    }
    return status === 429 || status === 502 || status === 503 || status === 504;
}
