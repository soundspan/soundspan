import type { Response } from "express";
import {
    getRestoreStatus,
    isRestoreJobActive,
} from "../services/backup/restoreJob";
import { prisma } from "../utils/db";
import { sendRouteError } from "../utils/routeErrorResponse";

/** Require the pre-onboarding database state used by anonymous restore routes. */
export async function requireFreshInstall(res: Response): Promise<boolean> {
    if ((await prisma.user.count()) === 0) return true;
    sendRouteError(res, 403, "Restore is unavailable after setup", {
        code: "RESTORE_UNAVAILABLE",
    });
    return false;
}

/** Prevent a second upload from starting while a restore job owns the database. */
export async function requireNoRestoreJob(res: Response): Promise<boolean> {
    if (!isRestoreJobActive(await getRestoreStatus())) return true;
    sendRouteError(res, 409, "A restore is already in progress", {
        code: "RESTORE_IN_PROGRESS",
    });
    return false;
}
