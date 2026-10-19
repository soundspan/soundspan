import type { Response } from "express";
import { isRestoreLockHeld } from "../services/backup/restoreLock";
import { prisma } from "../utils/db";
import { sendRouteError } from "../utils/routeErrorResponse";

/** Require the pre-onboarding database state used by anonymous restore routes. */
export async function requireFreshInstall(res: Response): Promise<boolean> {
    try {
        if ((await prisma.user.count()) === 0) return true;
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "P2021"
        ) {
            return true;
        }
        throw error;
    }
    sendRouteError(res, 403, "Restore is unavailable after setup", {
        code: "RESTORE_UNAVAILABLE",
    });
    return false;
}

/** Prevent a second upload from starting while a restore job owns the database. */
export async function requireNoRestoreJob(res: Response): Promise<boolean> {
    if (!(await isRestoreLockHeld())) return true;
    sendRouteError(res, 409, "A restore is already in progress", {
        code: "RESTORE_IN_PROGRESS",
    });
    return false;
}
