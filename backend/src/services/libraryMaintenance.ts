import crypto from "crypto";
import { config } from "../config";
import { logger } from "../utils/logger";
import { organizeSingles } from "../workers/organizeSingles";
import { scanQueue } from "../workers/queues";
import { isPlainObject } from "../utils/plainObject";

/** Stable queue job identifier for global library maintenance. */
export const LIBRARY_MAINTENANCE_JOB_ID = "library-global-maintenance";
const LIBRARY_MAINTENANCE_CLAIM_KEY =
    "library:maintenance:admission:library-global-maintenance";
const LIBRARY_MAINTENANCE_CLAIM_TTL_SECONDS = 6 * 60 * 60;
const LIBRARY_MAINTENANCE_COOLDOWN_SECONDS = 30;
const TERMINAL_LIBRARY_MAINTENANCE_STATES = new Set([
    "completed",
    "failed",
    "stuck",
]);
/** Scoped logger shared by maintenance orchestration and its route boundary. */
export const libraryMaintenanceLogger = logger.child("LibraryMaintenance");

interface AdmittedLibraryMaintenance {
    admitted: true;
    claimToken: string;
    cooldownKey: string;
    cooldownToken: string;
}

interface RejectedLibraryMaintenance {
    admitted: false;
    reason: "active" | "cooldown";
    jobId?: string;
}

type LibraryMaintenanceAdmission =
    | AdmittedLibraryMaintenance
    | RejectedLibraryMaintenance;

const releaseRedisClaim = async (key: string, token: string): Promise<void> => {
    try {
        await scanQueue.client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            key,
            token,
        );
    } catch (error) {
        libraryMaintenanceLogger.warn("Failed to release admission claim", {
            key,
            error,
        });
    }
};

const findPendingLibraryMaintenanceJob = async () => {
    const jobs = await scanQueue.getJobs(
        ["active", "waiting", "delayed", "paused"],
        0,
        0,
        true,
    );
    return jobs[0] ?? null;
};

const removeRetainedTerminalLibraryMaintenanceJob = async (): Promise<void> => {
    const job = await scanQueue.getJob(LIBRARY_MAINTENANCE_JOB_ID);
    if (!job) {
        return;
    }
    const state = await job.getState();
    if (!TERMINAL_LIBRARY_MAINTENANCE_STATES.has(state)) {
        return;
    }
    const currentState = await job.getState();
    if (!TERMINAL_LIBRARY_MAINTENANCE_STATES.has(currentState)) {
        return;
    }
    try {
        await job.remove();
    } catch (error) {
        throw error;
    }
};

/** Attempts to reserve the global library-maintenance slot for a user. */
export const admitLibraryMaintenance = async (
    userId: string,
): Promise<LibraryMaintenanceAdmission> => {
    const claimToken = crypto.randomUUID();
    const acquired = await scanQueue.client.set(
        LIBRARY_MAINTENANCE_CLAIM_KEY,
        claimToken,
        "EX",
        LIBRARY_MAINTENANCE_CLAIM_TTL_SECONDS,
        "NX",
    );
    if (acquired !== "OK") {
        return { admitted: false, reason: "active" };
    }

    try {
        const pendingJob = await findPendingLibraryMaintenanceJob();
        if (pendingJob) {
            await releaseRedisClaim(LIBRARY_MAINTENANCE_CLAIM_KEY, claimToken);
            return {
                admitted: false,
                reason: "active",
                jobId: String(pendingJob.id),
            };
        }
        const cooldownKey = `library:maintenance:cooldown:${userId}`;
        const cooldownToken = crypto.randomUUID();
        const cooldownAcquired = await scanQueue.client.set(
            cooldownKey,
            cooldownToken,
            "EX",
            LIBRARY_MAINTENANCE_COOLDOWN_SECONDS,
            "NX",
        );
        if (cooldownAcquired !== "OK") {
            await releaseRedisClaim(LIBRARY_MAINTENANCE_CLAIM_KEY, claimToken);
            return { admitted: false, reason: "cooldown" };
        }

        return {
            admitted: true,
            claimToken,
            cooldownKey,
            cooldownToken,
        };
    } catch (error) {
        await releaseRedisClaim(LIBRARY_MAINTENANCE_CLAIM_KEY, claimToken);
        throw error;
    }
};

/** Releases an admitted maintenance claim and optionally its cooldown. */
export const releaseLibraryMaintenanceAdmission = async (
    admission: AdmittedLibraryMaintenance,
    keepCooldown: boolean,
): Promise<void> => {
    await releaseRedisClaim(
        LIBRARY_MAINTENANCE_CLAIM_KEY,
        admission.claimToken,
    );
    if (!keepCooldown) {
        await releaseRedisClaim(admission.cooldownKey, admission.cooldownToken);
    }
};

/** Observes background organization completion and releases its admission. */
export const finishOrganizationInBackground = async (
    organization: Promise<void>,
    admission: AdmittedLibraryMaintenance,
): Promise<void> => {
    try {
        await organization;
    } catch (error) {
        libraryMaintenanceLogger.error("Manual organization failed", error);
    } finally {
        await releaseLibraryMaintenanceAdmission(admission, true);
    }
};

interface SanitizedScanResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksRemoved: number;
    failedCount: number;
    duration: number;
}

const toNonNegativeInteger = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;

/** Normalizes queue progress into an integer percentage from zero to 100. */
export const sanitizeScanProgress = (value: unknown): number => {
    let percent = value;
    if (isPlainObject(value)) {
        const fields = value;
        if (typeof fields.percent === "number") {
            percent = fields.percent;
        } else if (
            typeof fields.processed === "number" &&
            typeof fields.total === "number" &&
            fields.total > 0
        ) {
            percent = (fields.processed / fields.total) * 100;
        }
    }

    return Math.min(100, toNonNegativeInteger(percent));
};

/** Sanitizes a completed scan job result for the public status response. */
export const sanitizeScanResult = (
    value: unknown,
): SanitizedScanResult | null => {
    if (!isPlainObject(value)) {
        return null;
    }

    const fields = value;
    return {
        tracksAdded: toNonNegativeInteger(fields.tracksAdded),
        tracksUpdated: toNonNegativeInteger(fields.tracksUpdated),
        tracksRemoved: toNonNegativeInteger(fields.tracksRemoved),
        failedCount: Array.isArray(fields.errors) ? fields.errors.length : 0,
        duration: toNonNegativeInteger(fields.duration),
    };
};

const organizeBeforeLibraryScan = async (): Promise<void> => {
    try {
        libraryMaintenanceLogger.info(
            "Organizing downloads before library scan",
        );
        await organizeSingles();
        libraryMaintenanceLogger.info("Download organization complete");
    } catch (error) {
        libraryMaintenanceLogger.warn(
            "Download organization skipped before library scan",
            error,
        );
    }
};

/** Organizes pending downloads and enqueues an admitted library scan. */
export const startAdmittedLibraryScan = async (
    userId: string,
    admission: AdmittedLibraryMaintenance,
) => {
    let scanQueued = false;
    try {
        await organizeBeforeLibraryScan();
        await removeRetainedTerminalLibraryMaintenanceJob();
        const job = await scanQueue.add(
            "scan",
            { userId, musicPath: config.music.musicPath },
            {
                jobId: LIBRARY_MAINTENANCE_JOB_ID,
            },
        );
        scanQueued = true;
        return job;
    } finally {
        await releaseLibraryMaintenanceAdmission(admission, scanQueued);
    }
};
