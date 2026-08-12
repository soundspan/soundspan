import { prisma } from "./db";
import { redisClient } from "./redis";
import { logger, type Logger } from "./logger";

const DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_DEPENDENCY_CHECK_TIMEOUT_MS = 2_000;

const parsedDependencyCheckIntervalMs = Number.parseInt(
    process.env.READINESS_DEPENDENCY_CHECK_INTERVAL_MS ||
        `${DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS}`,
    10,
);
const READINESS_DEPENDENCY_CHECK_INTERVAL_MS =
    Number.isFinite(parsedDependencyCheckIntervalMs) &&
    parsedDependencyCheckIntervalMs > 0
        ? parsedDependencyCheckIntervalMs
        : DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS;

const parsedDependencyCheckTimeoutMs = Number.parseInt(
    process.env.READINESS_DEPENDENCY_CHECK_TIMEOUT_MS ||
        `${DEFAULT_DEPENDENCY_CHECK_TIMEOUT_MS}`,
    10,
);
const READINESS_DEPENDENCY_CHECK_TIMEOUT_MS =
    Number.isFinite(parsedDependencyCheckTimeoutMs) &&
    parsedDependencyCheckTimeoutMs > 0
        ? parsedDependencyCheckTimeoutMs
        : DEFAULT_DEPENDENCY_CHECK_TIMEOUT_MS;

const READINESS_REQUIRE_DEPENDENCIES =
    process.env.READINESS_REQUIRE_DEPENDENCIES !== "false";

interface DependencyStatus {
    ok: boolean;
    error: string | null;
    latencyMs: number | null;
}

export interface DependencyReadinessSnapshot {
    required: boolean;
    overallHealthy: boolean;
    checkIntervalMs: number;
    checkTimeoutMs: number;
    lastCheckedAt: number | null;
    postgres: DependencyStatus;
    redis: DependencyStatus;
}

function initialSnapshot(): DependencyReadinessSnapshot {
    const defaultStatus: DependencyStatus = {
        ok: !READINESS_REQUIRE_DEPENDENCIES,
        error: READINESS_REQUIRE_DEPENDENCIES ? "not-checked" : null,
        latencyMs: null,
    };

    return {
        required: READINESS_REQUIRE_DEPENDENCIES,
        overallHealthy: !READINESS_REQUIRE_DEPENDENCIES,
        checkIntervalMs: READINESS_DEPENDENCY_CHECK_INTERVAL_MS,
        checkTimeoutMs: READINESS_DEPENDENCY_CHECK_TIMEOUT_MS,
        lastCheckedAt: null,
        postgres: { ...defaultStatus },
        redis: { ...defaultStatus },
    };
}

async function withAbortDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new Error(`timed out after ${timeoutMs}ms`);
    const timeoutId = setTimeout(
        () => controller.abort(timeoutError),
        timeoutMs,
    );

    try {
        return await operation(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) {
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function probePostgres(timeoutMs: number): Promise<DependencyStatus> {
    const startedAt = Date.now();
    const maxWait = Math.max(1, Math.floor(timeoutMs / 2));
    const timeout = Math.max(1, timeoutMs - maxWait);
    try {
        await prisma.$transaction([prisma.$queryRaw`SELECT 1`], {
            maxWait,
            timeout,
        });
        return {
            ok: true,
            error: null,
            latencyMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            latencyMs: null,
        };
    }
}

async function probeRedis(timeoutMs: number): Promise<DependencyStatus> {
    if (!redisClient.isReady) {
        return {
            ok: false,
            error: "Redis client is not ready",
            latencyMs: null,
        };
    }

    const startedAt = Date.now();
    try {
        await withAbortDeadline(
            async (signal) =>
                await redisClient
                    .withCommandOptions({ abortSignal: signal })
                    .ping(),
            timeoutMs,
        );
        return {
            ok: true,
            error: null,
            latencyMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            latencyMs: null,
        };
    }
}

/**
 * Represents the DependencyReadinessTracker class.
 */
export class DependencyReadinessTracker {
    private snapshot: DependencyReadinessSnapshot = initialSnapshot();
    private inFlightProbe: Promise<DependencyReadinessSnapshot> | null = null;
    private readonly log: Logger;

    constructor(label: string) {
        this.log = logger.child("Readiness").child(label);
    }

    getSnapshot(): DependencyReadinessSnapshot {
        return { ...this.snapshot };
    }

    isHealthy(): boolean {
        return this.snapshot.overallHealthy;
    }

    async probe(force: boolean = false): Promise<DependencyReadinessSnapshot> {
        if (!READINESS_REQUIRE_DEPENDENCIES) {
            this.snapshot = {
                ...this.snapshot,
                required: false,
                overallHealthy: true,
                lastCheckedAt: Date.now(),
                postgres: { ok: true, error: null, latencyMs: null },
                redis: { ok: true, error: null, latencyMs: null },
            };
            return this.getSnapshot();
        }

        const now = Date.now();
        if (
            !force &&
            this.snapshot.lastCheckedAt &&
            now - this.snapshot.lastCheckedAt <
                READINESS_DEPENDENCY_CHECK_INTERVAL_MS
        ) {
            return this.getSnapshot();
        }

        if (this.inFlightProbe) {
            return this.inFlightProbe;
        }

        this.inFlightProbe = (async () => {
            const previousHealthy = this.snapshot.overallHealthy;
            const [postgres, redis] = await Promise.all([
                probePostgres(READINESS_DEPENDENCY_CHECK_TIMEOUT_MS),
                probeRedis(READINESS_DEPENDENCY_CHECK_TIMEOUT_MS),
            ]);

            const overallHealthy = postgres.ok && redis.ok;
            this.snapshot = {
                required: true,
                overallHealthy,
                checkIntervalMs: READINESS_DEPENDENCY_CHECK_INTERVAL_MS,
                checkTimeoutMs: READINESS_DEPENDENCY_CHECK_TIMEOUT_MS,
                lastCheckedAt: Date.now(),
                postgres,
                redis,
            };

            if (previousHealthy && !overallHealthy) {
                this.log.warn(
                    `Dependencies unhealthy (postgres=${postgres.ok}, redis=${redis.ok})`,
                );
            } else if (!previousHealthy && overallHealthy) {
                this.log.info("Dependencies recovered");
            }

            return this.getSnapshot();
        })().finally(() => {
            this.inFlightProbe = null;
        });

        return this.inFlightProbe;
    }
}

/**
 * Executes createDependencyReadinessTracker.
 */
export function createDependencyReadinessTracker(
    label: string,
): DependencyReadinessTracker {
    return new DependencyReadinessTracker(label);
}
