import { redisClient } from "../../utils/redis";
import { z } from "zod";
import type { RestoreProgress } from "./restoreDataLoad";
import { isRestoreLockHeld } from "./restoreLock";

const STATUS_KEY = "restore:status";
const STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;
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
                message: z.string().max(1_000),
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
    await redisClient.set(STATUS_KEY, JSON.stringify(status), {
        EX: STATUS_TTL_SECONDS,
    });
}

export async function getRestoreStatus(): Promise<RestoreStatus> {
    try {
        const value = await redisClient.get(STATUS_KEY);
        if (!value) return idleStatus;
        const status = restoreStatusSchema.parse(JSON.parse(value) as unknown);
        if (!isRestoreJobActive(status) || (await isRestoreLockHeld())) {
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
    } catch {
        return idleStatus;
    }
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
