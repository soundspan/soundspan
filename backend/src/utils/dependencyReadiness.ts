import { prisma } from "./db";
import { redisClient } from "./redis";
import { logger } from "./logger";

const DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_DEPENDENCY_CHECK_TIMEOUT_MS = 2_000;

const parsedDependencyCheckIntervalMs = Number.parseInt(
    process.env.READINESS_DEPENDENCY_CHECK_INTERVAL_MS ||
        `${DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS}`,
    10
);
const READINESS_DEPENDENCY_CHECK_INTERVAL_MS =
    Number.isFinite(parsedDependencyCheckIntervalMs) &&
    parsedDependencyCheckIntervalMs > 0
        ? parsedDependencyCheckIntervalMs
        : DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS;

const parsedDependencyCheckTimeoutMs = Number.parseInt(
    process.env.READINESS_DEPENDENCY_CHECK_TIMEOUT_MS ||
        `${DEFAULT_DEPENDENCY_CHECK_TIMEOUT_MS}`,
    10
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        promise
            .then((value) => {
                clearTimeout(timeoutId);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

async function probePostgres(timeoutMs: number): Promise<DependencyStatus> {
    try {
        await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs);
        return { ok: true, error: null };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function probeRedis(timeoutMs: number): Promise<DependencyStatus> {
    if (!redisClient.isReady) {
        return {
            ok: false,
            error: "Redis client is not ready",
        };
    }

    try {
        await withTimeout(redisClient.ping(), timeoutMs);
        return { ok: true, error: null };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export class DependencyReadinessTracker {
    private snapshot: DependencyReadinessSnapshot = initialSnapshot();
    private inFlightProbe: Promise<DependencyReadinessSnapshot> | null = null;

    constructor(private readonly label: string) {}

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
                postgres: { ok: true, error: null },
                redis: { ok: true, error: null },
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
                logger.warn(
                    `[Readiness/${this.label}] Dependencies unhealthy (postgres=${postgres.ok}, redis=${redis.ok})`
                );
            } else if (!previousHealthy && overallHealthy) {
                logger.info(
                    `[Readiness/${this.label}] Dependencies recovered`
                );
            }

            return this.getSnapshot();
        })().finally(() => {
            this.inFlightProbe = null;
        });

        return this.inFlightProbe;
    }
}

export function createDependencyReadinessTracker(
    label: string
): DependencyReadinessTracker {
    return new DependencyReadinessTracker(label);
}
