import { redisClient } from "../../utils/redis";
import { z } from "zod";
import type { RestoreProgress } from "./restoreDataLoad";
import { isRestoreLockHeld } from "./restoreLock";
import { RestoreError } from "./backupErrors";
import { logger as rootLogger } from "../../utils/logger";

const logger = rootLogger.child("BackupRestore");
const STATUS_KEY = "restore:status";
const STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATUS_READ_TIMEOUT_MS = 250;
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

export async function setRestoreStatus(status: RestoreStatus): Promise<void> {
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
                JSON.stringify(sanitizeStatus(status)),
                { EX: STATUS_TTL_SECONDS },
            ),
            timeout,
        ]);
    } catch (error) {
        logger.warn("Could not persist restore status", error);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function getRestoreStatus(
    knownLockHeld?: boolean,
): Promise<RestoreStatus> {
    let value: string | null;
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
        value = typeof result === "string" ? result : null;
    } catch (cause) {
        throw new RestoreError(
            "RESTORE_STATUS_UNAVAILABLE",
            "Restore status is temporarily unavailable",
            { cause },
        );
    }
    try {
        if (!value) return idleStatus;
        const status = sanitizeStatus(
            restoreStatusSchema.parse(JSON.parse(value) as unknown),
        );
        if (
            !isRestoreJobActive(status) ||
            knownLockHeld === true ||
            (knownLockHeld === undefined && (await isRestoreLockHeld()))
        ) {
            return status;
        }
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
