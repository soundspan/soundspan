import { redisClient } from "../../utils/redis";
import { z } from "zod";
import type { RestoreProgress } from "./restoreDataLoad";
import { isRestoreLockHeld } from "./restoreLock";
import { RestoreError } from "./backupErrors";
import { logger as rootLogger } from "../../utils/logger";
import { readRestartMarker } from "./restartRequired";

const logger = rootLogger.child("BackupRestore");
const STATUS_KEY = "restore:status";
const STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATUS_READ_TIMEOUT_MS = 250;
const TERMINAL_WRITE_ATTEMPTS = 3;
const TERMINAL_RETRY_DELAY_MS = 500;
const progressSchema = z
    .object({
        completedTables: z.number().int().safe().nonnegative(),
        totalTables: z.number().int().safe().nonnegative(),
        completedRows: z.number().int().safe().nonnegative(),
        totalRows: z.number().int().safe().nonnegative(),
    })
    .strict();
const summarySchema = z
    .object({
        backupCreatedAt: z.string().datetime(),
        backupAppVersion: z.string().max(256),
        appVersion: z.string().max(256),
        tables: z.number().int().safe().nonnegative(),
        rows: z.number().int().safe().nonnegative(),
        migrationsAppliedAfterLoad: z.number().int().safe().nonnegative(),
        migrationChecksumWarnings: z
            .number()
            .int()
            .safe()
            .nonnegative()
            .default(0),
        credentialsReencrypted: z.number().int().safe().nonnegative(),
        credentialsUndecryptable: z.number().int().safe().nonnegative(),
        apiKeysNeedReissue: z.boolean(),
    })
    .strict();
const restoreStatusSchema = z
    .object({
        restoreId: z.string().uuid().optional(),
        state: z.enum([
            "idle",
            "uploading",
            "validating",
            "resetting",
            "replaying",
            "loading",
            "migrating",
            "reencrypting",
            "complete",
            "failed",
        ]),
        progress: progressSchema.nullable(),
        error: z
            .object({
                code: z.string().max(100),
                message: z.string().max(100_000),
            })
            .strict()
            .nullable(),
        summary: summarySchema.nullable(),
    })
    .strict();
const storedRestoreStatusSchema = restoreStatusSchema.extend({
    writtenAt: z.number().int().safe().nonnegative().optional(),
});

export type RestoreState =
    | "idle"
    | "uploading"
    | "validating"
    | "resetting"
    | "replaying"
    | "loading"
    | "migrating"
    | "reencrypting"
    | "complete"
    | "failed";

export interface RestoreSummary {
    backupCreatedAt: string;
    backupAppVersion: string;
    appVersion: string;
    tables: number;
    rows: number;
    migrationsAppliedAfterLoad: number;
    migrationChecksumWarnings: number;
    credentialsReencrypted: number;
    credentialsUndecryptable: number;
    apiKeysNeedReissue: boolean;
}

export interface RestoreStatus {
    restoreId?: string;
    state: RestoreState;
    progress: RestoreProgress | null;
    error: { code: string; message: string } | null;
    summary: RestoreSummary | null;
}

const idleStatus: RestoreStatus = {
    state: "idle",
    progress: null,
    error: null,
    summary: null,
};

async function persistRestoreStatus(status: RestoreStatus): Promise<void> {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error("Restore status write timed out")),
                STATUS_READ_TIMEOUT_MS,
            );
            timeoutId.unref();
        });
        await Promise.race([
            redisClient.set(
                STATUS_KEY,
                JSON.stringify({
                    ...sanitizeStatus(status),
                    writtenAt: Date.now(),
                }),
                { EX: STATUS_TTL_SECONDS },
            ),
            timeout,
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function setRestoreStatus(status: RestoreStatus): Promise<void> {
    await persistRestoreStatus(status).catch((error) => {
        logger.warn("Could not persist restore status", error);
    });
}

function waitForTerminalRetry(): Promise<void> {
    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, TERMINAL_RETRY_DELAY_MS);
        timeout.unref();
    });
}

/** Persist a terminal state with bounded retries before giving up. */
export async function setTerminalRestoreStatus(
    status: RestoreStatus,
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < TERMINAL_WRITE_ATTEMPTS; attempt += 1) {
        try {
            await persistRestoreStatus(status);
            return;
        } catch (error) {
            lastError = error;
            if (attempt + 1 < TERMINAL_WRITE_ATTEMPTS) {
                await waitForTerminalRetry();
            }
        }
    }
    logger.warn("Could not persist terminal restore status", lastError);
}

async function readStatusValue(): Promise<string | null> {
    try {
        if (!redisClient.isReady) throw new Error("Redis is not ready");
        let timeoutId: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error("Restore status read timed out")),
                STATUS_READ_TIMEOUT_MS,
            );
            timeoutId.unref();
        });
        const result = await Promise.race([
            redisClient.sendCommand(["GET", STATUS_KEY], {
                timeout: STATUS_READ_TIMEOUT_MS,
            }),
            timeout,
        ]).finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
        });
        return typeof result === "string" ? result : null;
    } catch (cause) {
        throw new RestoreError(
            "RESTORE_STATUS_UNAVAILABLE",
            "Restore status is temporarily unavailable",
            { cause },
        );
    }
}

function interruptedStatus(status: RestoreStatus): RestoreStatus {
    return {
        restoreId: status.restoreId,
        state: "failed",
        progress: null,
        error: {
            code: "RESTORE_INTERRUPTED",
            message:
                "The restore stopped before it finished. Check the server logs, then reset the database and restore again.",
        },
        summary: null,
    };
}

async function effectiveStoredStatus(
    stored: z.infer<typeof storedRestoreStatusSchema>,
    knownLockHeld: boolean | undefined,
): Promise<RestoreStatus> {
    const { writtenAt, ...rawStatus } = stored;
    const status = sanitizeStatus(rawStatus);
    if (!isRestoreJobActive(status)) return status;
    const lockHeld =
        knownLockHeld === true ||
        (knownLockHeld === undefined && (await isRestoreLockHeld()));
    if (lockHeld) return status;
    if (
        writtenAt !== undefined &&
        (await readRestartMarker(true)) > writtenAt
    ) {
        return { ...status, state: "complete", error: null };
    }
    return interruptedStatus(status);
}

export async function getRestoreStatus(
    knownLockHeld?: boolean,
): Promise<RestoreStatus> {
    const value = await readStatusValue();
    try {
        if (!value) return idleStatus;
        const stored = storedRestoreStatusSchema.parse(
            JSON.parse(value) as unknown,
        );
        return await effectiveStoredStatus(stored, knownLockHeld);
    } catch (error) {
        if (error instanceof RestoreError) throw error;
        return idleStatus;
    }
}

function sanitizeMessage(message: string): string {
    return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function sanitizeStatus(status: RestoreStatus): RestoreStatus {
    if (!status.error) return status;
    return {
        ...status,
        error: {
            code: status.error.code.slice(0, 100),
            message: sanitizeMessage(status.error.message),
        },
    };
}

export function isRestoreJobActive(status: RestoreStatus): boolean {
    return [
        "validating",
        "resetting",
        "replaying",
        "loading",
        "migrating",
        "reencrypting",
    ].includes(status.state);
}
