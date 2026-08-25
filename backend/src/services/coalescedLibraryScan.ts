/**
 * Deployment-wide full-library scan coalescing for download completion paths.
 *
 * Lidarr webhook scans are intentionally excluded. Matched downloads use the
 * scan processor's precise MBID/download-id completion logic. External imports
 * retain their own stable-jobId full-library scan with only userId and source.
 */

import { randomUUID } from "crypto";
import type { Job } from "bull";
import type Redis from "ioredis";
import { config } from "../config";

/**
 * Lazily import the scan queue so merely importing this service (routes,
 * download services, tests) does not instantiate every Bull queue and its
 * live Redis connections — the pre-existing call sites all imported
 * workers/queues dynamically for exactly that reason.
 */
async function getScanQueue() {
    const { scanQueue } = await import("../workers/queues");
    return scanQueue;
}
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";

const log = logger.child("CoalescedLibraryScan");
const FOLLOW_UP_KEY = "coalesced-library-scan:follow-up";
const FOLLOW_UP_TTL_SECONDS = 86_400;
const SCAN_DELAY_MS = 30_000;
const MAX_REQUEST_ATTEMPTS = 3;
const QUEUED_STATES = new Set(["waiting", "delayed", "paused"]);
const LIVE_SCAN_STATES = new Set([...QUEUED_STATES, "active"]);
const TERMINAL_SCAN_STATES = new Set(["failed", "completed", "stuck"]);
let followUpRedis: Redis | null = null;
let closed = false;

interface FollowUpPayload {
    userId: string | null;
}

interface ScanRequest {
    userId: string | null;
    triggerSource: string;
}

type AttemptResult = "done" | "retry";

/** Stable Bull identifier shared by every coalesced full-library scan. */
export const COALESCED_SCAN_JOB_ID = "coalesced-library-scan";

function getFollowUpRedis(): Redis {
    if (closed) {
        throw new Error(
            "Coalesced library scan follow-up Redis is closed for shutdown",
        );
    }
    if (!followUpRedis) {
        const testOptions = config.underJest ? { lazyConnect: true } : {};
        followUpRedis = createIORedisClient(
            "coalesced-library-scan-follow-up",
            testOptions,
        );
    }
    return followUpRedis;
}

async function setFollowUp(
    userId: string | null,
    triggerSource: string,
): Promise<string> {
    // This is intentionally a last-writer-wins slot. One request may overwrite
    // another user's marker because every coalesced scan covers the full library.
    const stored = JSON.stringify({ userId, nonce: randomUUID() });
    await getFollowUpRedis().set(
        FOLLOW_UP_KEY,
        stored,
        "EX",
        FOLLOW_UP_TTL_SECONDS,
    );
    log.debug("Coalesced library scan follow-up requested", {
        triggerSource,
    });
    return stored;
}

async function compareAndDeleteFollowUp(stored: string): Promise<boolean> {
    const deleted = await getFollowUpRedis().eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        FOLLOW_UP_KEY,
        stored,
    );
    return deleted === 1;
}

async function markFollowUpAndRecheck(
    request: ScanRequest,
): Promise<AttemptResult> {
    const stored = await setFollowUp(request.userId, request.triggerSource);
    const currentJob = await (
        await getScanQueue()
    ).getJob(COALESCED_SCAN_JOB_ID);
    if (currentJob && LIVE_SCAN_STATES.has(await currentJob.getState())) {
        return "done";
    }
    // This removes this request's marker only; a newer marker is preserved.
    await compareAndDeleteFollowUp(stored);
    return "retry";
}

async function addCoalescedScan(request: ScanRequest): Promise<void> {
    await (
        await getScanQueue()
    ).add(
        "scan",
        { userId: request.userId, source: "coalesced-library-scan" },
        {
            jobId: COALESCED_SCAN_JOB_ID,
            delay: SCAN_DELAY_MS,
            removeOnComplete: true,
            removeOnFail: true,
        },
    );
    log.debug("Coalesced library scan requested", {
        triggerSource: request.triggerSource,
    });
}

async function recheckAddedJob(request: ScanRequest): Promise<AttemptResult> {
    const currentJob = await (
        await getScanQueue()
    ).getJob(COALESCED_SCAN_JOB_ID);
    if (!currentJob) return "retry";
    const state = await currentJob.getState();
    if (QUEUED_STATES.has(state)) return "done";
    if (state !== "active") return "retry";
    return markFollowUpAndRecheck(request);
}

async function addAndRecheck(request: ScanRequest): Promise<AttemptResult> {
    await addCoalescedScan(request);
    return recheckAddedJob(request);
}

async function handleExistingJob(
    job: Job,
    request: ScanRequest,
): Promise<AttemptResult> {
    const state = await job.getState();
    if (QUEUED_STATES.has(state)) {
        log.debug("Coalesced library scan is already queued", {
            triggerSource: request.triggerSource,
        });
        return "done";
    }
    if (state === "active") {
        return markFollowUpAndRecheck(request);
    }
    if (!TERMINAL_SCAN_STATES.has(state)) return "retry";
    const currentState = await job.getState();
    if (!TERMINAL_SCAN_STATES.has(currentState)) return "retry";
    // A replacement can still appear after this fence and before remove(). If
    // that happens, this request's bounded loop re-adds a queued scan. A crash
    // in that narrow gap remains an unavoidable remove-and-readd window.
    await job.remove();
    return "retry";
}

async function requestWithinAttemptLimit(
    request: ScanRequest,
): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
        const existingJob = await (
            await getScanQueue()
        ).getJob(COALESCED_SCAN_JOB_ID);
        const result = existingJob
            ? await handleExistingJob(existingJob, request)
            : await addAndRecheck(request);
        if (result === "done") return true;
    }
    return false;
}

async function useDurableFallback(request: ScanRequest): Promise<void> {
    await setFollowUp(request.userId, request.triggerSource);
    await addCoalescedScan(request);
}

/**
 * Requests one delayed full-library scan shared across all app processes.
 * Initial queue and Redis failures propagate so the caller can retry later.
 */
export async function requestCoalescedLibraryScan(
    userId: string | null,
    triggerSource: string,
): Promise<void> {
    const request = { userId, triggerSource };
    if (await requestWithinAttemptLimit(request)) return;
    await useDurableFallback(request);
}

function parseFollowUpPayload(stored: string): FollowUpPayload | null {
    try {
        const payload: unknown = JSON.parse(stored);
        if (typeof payload !== "object" || payload === null) {
            throw new Error("Follow-up payload must be an object");
        }
        const userId = (payload as Record<string, unknown>).userId;
        if (typeof userId !== "string" && userId !== null) {
            throw new Error("Follow-up userId must be a string or null");
        }
        const nonce = (payload as Record<string, unknown>).nonce;
        if (typeof nonce !== "string") {
            throw new Error("Follow-up nonce must be a string");
        }
        return { userId };
    } catch (error) {
        log.warn(
            "Ignoring invalid coalesced library scan follow-up; marker retained until expiry or overwrite",
            { error },
        );
        return null;
    }
}

/**
 * Processes one distributed follow-up request after a scan settles. The marker
 * remains durable until re-enqueue succeeds and owned cleanup completes.
 * Failures are warned and never reject the event owner.
 */
export async function consumeCoalescedScanFollowUp(): Promise<void> {
    let stored: string | null;
    try {
        stored = await getFollowUpRedis().get(FOLLOW_UP_KEY);
    } catch (error) {
        warnFollowUpReadFailure(error);
        return;
    }
    if (!stored) return;
    const payload = parseFollowUpPayload(stored);
    if (!payload) return;
    try {
        await requestCoalescedLibraryScan(
            payload.userId,
            "coalesced-follow-up",
        );
    } catch (error) {
        log.warn(
            "Failed to re-enqueue coalesced library scan follow-up; marker retained",
            { error },
        );
        return;
    }
    try {
        await compareAndDeleteFollowUp(stored);
    } catch (error) {
        warnFollowUpDeleteFailure(error);
    }
}

function warnFollowUpReadFailure(error: unknown): void {
    if (closed) {
        log.warn(
            "Shutdown in progress; coalesced scan follow-up marker retained for consumption after restart or the next trigger",
            { error },
        );
        return;
    }
    log.warn("Failed to read coalesced library scan follow-up", { error });
}

function warnFollowUpDeleteFailure(error: unknown): void {
    if (closed) {
        log.warn(
            "Shutdown in progress; consumed coalesced scan follow-up marker retained for consumption after restart or the next trigger",
            { error },
        );
        return;
    }
    log.warn(
        "Failed to delete consumed coalesced library scan follow-up; marker retained for consumption on the next trigger",
        { error },
    );
}

/** Closes the lazily-created Redis client owned by scan coalescing. */
export async function closeCoalescedLibraryScanRedis(): Promise<void> {
    if (closed) return;
    closed = true;
    const client = followUpRedis;
    followUpRedis = null;
    if (!client) return;
    try {
        await client.quit();
    } catch (error) {
        log.warn("Failed to close coalesced library scan Redis client", {
            error,
        });
    }
}
