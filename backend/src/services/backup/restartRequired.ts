import type { NextFunction, Request, Response } from "express";
import { redisClient } from "../../utils/redis";
import { logger as rootLogger } from "../../utils/logger";
import { sendRouteError } from "../../utils/routeErrorResponse";
import { getRestoreStatus, isRestoreJobActive } from "./restoreStatus";

const logger = rootLogger.child("BackupRestore");
const RESTART_KEY = "restore:restart-required";
const PROCESS_STARTED_AT = Date.now();
const CACHE_MS = 5_000;
const WARN_INTERVAL_MS = 60_000;
let cachedAt = 0;
let cachedValue = false;
let lastWarningAt = 0;

export interface RestoreBarrier {
    code: "RESTORE_IN_PROGRESS" | "RESTART_REQUIRED";
    message: string;
}

export async function markRestartRequired(
    completedAt = Date.now(),
): Promise<void> {
    await redisClient.set(RESTART_KEY, String(completedAt));
    cachedAt = 0;
}

/** Check whether another completed restore requires this process to restart. */
export async function isRestartRequired(now = Date.now()): Promise<boolean> {
    if (now - cachedAt < CACHE_MS) return cachedValue;
    try {
        const value = await redisClient.get(RESTART_KEY);
        const completedAt = Number(value ?? 0);
        cachedValue =
            Number.isFinite(completedAt) && completedAt > PROCESS_STARTED_AT;
        cachedAt = now;
        return cachedValue;
    } catch (error) {
        cachedValue = false;
        cachedAt = now;
        if (now - lastWarningAt >= WARN_INTERVAL_MS) {
            lastWarningAt = now;
            logger.warn("Could not read the restore restart marker", error);
        }
        return false;
    }
}

function isHealthPath(path: string): boolean {
    return (
        path === "/health" ||
        path === "/api/health" ||
        path.startsWith("/health/") ||
        path.startsWith("/api/health/")
    );
}

function isApplicationPath(path: string): boolean {
    return path.startsWith("/api/") || path.startsWith("/rest/");
}

function isRestorePath(path: string): boolean {
    return path === "/api/restore" || path.startsWith("/api/restore/");
}

/** Return the process-wide barrier that protects application data access. */
export async function getRestoreBarrier(): Promise<RestoreBarrier | null> {
    if (isRestoreJobActive(await getRestoreStatus())) {
        return {
            code: "RESTORE_IN_PROGRESS",
            message: "A restore is in progress.",
        };
    }
    if (await isRestartRequired()) {
        return {
            code: "RESTART_REQUIRED",
            message: "Restart soundspan to finish the restore.",
        };
    }
    return null;
}

/** Block application requests while restore runs and until restart completes. */
export async function requireNoPendingRestart(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    if (!isApplicationPath(req.path) || isHealthPath(req.path)) {
        next();
        return;
    }
    if (req.path === "/api/restore/status") {
        next();
        return;
    }
    const barrier = await getRestoreBarrier();
    if (
        !barrier ||
        (isRestorePath(req.path) && barrier.code === "RESTORE_IN_PROGRESS")
    ) {
        next();
        return;
    }
    sendRouteError(res, 503, barrier.message, {
        code: barrier.code,
    });
}
