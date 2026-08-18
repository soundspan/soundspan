import { type Request, type Response } from "express";
import { config } from "../../config";
import { BRAND_SLUG } from "../../config/brand";
import { scanQueue } from "../../workers/queues";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import { getRequestContext } from "./shared";

/**
 * Executes handlePing.
 */
export function handlePing(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(res, { ping: {} }, format, callback);
}

/**
 * Executes handleGetLicense.
 */
export function handleGetLicense(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(
        res,
        {
            license: {
                valid: true,
                email: `self-hosted@${BRAND_SLUG}.local`,
            },
        },
        format,
        callback,
    );
}
/**
 * Executes handleGetOpenSubsonicExtensions.
 */
export function handleGetOpenSubsonicExtensions(
    req: Request,
    res: Response,
): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(
        res,
        {
            openSubsonicExtensions: [
                { name: "apiKeyAuthentication", versions: [1] },
                { name: "formPost", versions: [1] },
                { name: "songLyrics", versions: [1] },
                { name: "transcodeOffset", versions: [1] },
                { name: "songPlayedDate", versions: [1] },
                { name: "albumPlayedDate", versions: [1] },
            ],
        },
        format,
        callback,
    );
}

/**
 * Returns empty podcast responses until podcast feeds are supported.
 */
export function handleGetPodcasts(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(res, { podcasts: { channel: [] } }, format, callback);
}

export function handleGetNewestPodcasts(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(
        res,
        { newestPodcasts: { episode: [] } },
        format,
        callback,
    );
}

/**
 * Executes handleTokenInfo.
 */
export function handleTokenInfo(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    const hasApiKey =
        typeof req.query.apiKey === "string" && req.query.apiKey.length > 0;
    const hasToken = typeof req.query.t === "string" && req.query.t.length > 0;

    sendSubsonicSuccess(
        res,
        {
            tokenInfo: {
                valid: true,
                username: req.user?.username,
                authType: hasApiKey
                    ? "apiKey"
                    : hasToken
                      ? "token"
                      : "password",
            },
        },
        format,
        callback,
    );
}
type ScanQueueJobLike = {
    progress?: () => unknown;
};

const SUBSONIC_SCAN_START_COOLDOWN_MS = 30 * 60 * 1000;
let lastSubsonicScanStartRequestAt = 0;

function parseScanProgressCount(job: ScanQueueJobLike | undefined): number {
    if (!job || typeof job.progress !== "function") {
        return 0;
    }

    const value = job.progress();
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(value)));
}

function canQueueSubsonicScan(nowMs: number): boolean {
    return (
        lastSubsonicScanStartRequestAt === 0 ||
        nowMs - lastSubsonicScanStartRequestAt >=
            SUBSONIC_SCAN_START_COOLDOWN_MS
    );
}

/**
 * Executes resetSubsonicScanStartCooldownForTests.
 */
export function resetSubsonicScanStartCooldownForTests(): void {
    lastSubsonicScanStartRequestAt = 0;
}
/**
 * Executes handleGetScanStatus.
 */
export async function handleGetScanStatus(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const activeJobs = await scanQueue.getActive();

        const scanning = activeJobs.length > 0;
        const count = scanning
            ? parseScanProgressCount(activeJobs[0] as ScanQueueJobLike)
            : 0;
        sendSubsonicSuccess(
            res,
            {
                scanStatus: {
                    scanning,
                    count,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch scan status",
            format,
            callback,
        );
    }
}

/**
 * Executes handleStartScan.
 */
export async function handleStartScan(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const nowMs = Date.now();
        const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
            scanQueue.getActive(),
            scanQueue.getWaiting(),
            scanQueue.getDelayed(),
        ]);

        const hasPendingScan =
            activeJobs.length > 0 ||
            waitingJobs.length > 0 ||
            delayedJobs.length > 0;
        const queuedNow = !hasPendingScan && canQueueSubsonicScan(nowMs);

        if (queuedNow) {
            await scanQueue.add(
                "scan",
                {
                    userId: req.user!.id,
                    musicPath: config.music.musicPath,
                },
                {
                    removeOnComplete: true,
                    removeOnFail: 50,
                },
            );
            lastSubsonicScanStartRequestAt = nowMs;
        }

        const activeCount = parseScanProgressCount(
            activeJobs[0] as ScanQueueJobLike,
        );
        sendSubsonicSuccess(
            res,
            {
                scanStatus: {
                    scanning: activeJobs.length > 0 || queuedNow,
                    count: activeCount,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to start scan",
            format,
            callback,
        );
    }
}
