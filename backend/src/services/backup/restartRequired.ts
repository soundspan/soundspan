import type { NextFunction, Request, Response } from "express";
import { redisClient } from "../../utils/redis";
import { logger as rootLogger } from "../../utils/logger";
import { sendRouteError } from "../../utils/routeErrorResponse";
import { consumeRestoreLockRelease, isRestoreLockHeld } from "./restoreLock";

const logger = rootLogger.child("BackupRestore");
const RESTART_KEY = "restore:restart-required";
const PROCESS_STARTED_AT = Date.now();
const CACHE_MS = 1_500;
const REDIS_TIMEOUT_MS = 250;
const REDIS_WRITE_TIMEOUT_MS = 1_000;
const REDIS_WRITE_ATTEMPTS = 5;
const WARN_INTERVAL_MS = 60_000;
let cachedAt = 0;
let cachedCompletedAt = 0;
let markedByProcess = false;
let lastWarningAt = 0;
let activeRead: Promise<boolean> | null = null;

export interface RestoreBarrier {
    code: "RESTORE_IN_PROGRESS" | "RESTART_REQUIRED";
    message: string;
}

export async function markRestartRequired(
    completedAt = Date.now(),
): Promise<void> {
    markedByProcess = true;
    cachedCompletedAt = completedAt;
    cachedAt = completedAt;
    let lastError: unknown = new Error("Restart marker write failed");
    for (let attempt = 0; attempt < REDIS_WRITE_ATTEMPTS; attempt += 1) {
        let timeoutId: NodeJS.Timeout | undefined;
        try {
            const timeout = new Promise<never>((_resolve, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error("Restart marker write timed out")),
                    REDIS_WRITE_TIMEOUT_MS,
                );
                timeoutId.unref();
            });
            await Promise.race([
                redisClient.set(RESTART_KEY, String(completedAt)),
                timeout,
            ]);
            return;
        } catch (error) {
            lastError = error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }
    throw lastError;
}

/** Check whether another completed restore requires this process to restart. */
export async function isRestartRequired(now = Date.now()): Promise<boolean> {
    if (markedByProcess) return true;
    return (await readRestartMarker(false, now)) > PROCESS_STARTED_AT;
}

/** Read the last completed-restore marker, optionally bypassing its cache. */
export async function readRestartMarker(
    force = false,
    now = Date.now(),
): Promise<number> {
    if (!force && now - cachedAt < CACHE_MS) return cachedCompletedAt;
    if (!redisClient.isReady) return 0;
    if (activeRead) return (await activeRead) ? cachedCompletedAt : 0;
    activeRead = readRestartRequired(now);
    try {
        await activeRead;
        return cachedCompletedAt;
    } finally {
        activeRead = null;
    }
}

async function readRestartRequired(now: number): Promise<boolean> {
    try {
        let timeoutId: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error("Redis restart-marker read timed out")),
                REDIS_TIMEOUT_MS,
            );
            timeoutId.unref();
        });
        const value = await Promise.race([
            redisClient.sendCommand(["GET", RESTART_KEY], {
                timeout: REDIS_TIMEOUT_MS,
            }),
            timeout,
        ]).finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
        });
        const completedAt = Number(value ?? 0);
        cachedCompletedAt = Number.isFinite(completedAt) ? completedAt : 0;
        cachedAt = now;
        return cachedCompletedAt > PROCESS_STARTED_AT;
    } catch (error) {
        cachedCompletedAt = 0;
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
    if (await isRestartRequired()) {
        return {
            code: "RESTART_REQUIRED",
            message: "Restart soundspan to finish the restore.",
        };
    }
    if (await isRestoreLockHeld()) {
        return {
            code: "RESTORE_IN_PROGRESS",
            message: "A restore is in progress.",
        };
    }
    if (
        consumeRestoreLockRelease() &&
        (await readRestartMarker(true)) > PROCESS_STARTED_AT
    ) {
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
    const normalizedPath = req.path.toLowerCase();
    if (!isApplicationPath(normalizedPath) || isHealthPath(normalizedPath)) {
        next();
        return;
    }
    if (normalizedPath === "/api/restore/status") {
        next();
        return;
    }
    const barrier = await getRestoreBarrier();
    if (
        !barrier ||
        (isRestorePath(normalizedPath) &&
            barrier.code === "RESTORE_IN_PROGRESS")
    ) {
        next();
        return;
    }
    sendRouteError(res, 503, barrier.message, {
        code: barrier.code,
    });
}
