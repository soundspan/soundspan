import pLimit from "p-limit";
import { config } from "../config";
import {
    processVibeEmbedJob,
    type VibeEmbedJobTargetSpace,
} from "../services/vibeEmbedJobs";
import { refreshVibeEmbeddingCoverage } from "../services/vibeEmbeddingCoverage";
import { runEmbeddingSpaceLifecycleCheck } from "../services/embeddingSpaceLifecycle";
import {
    clearVibeEmbeddingTargetSpaceId,
    EmbeddingSpaceDimensionMismatchError,
    EmbeddingSpacePreprocessingMismatchError,
    getVibeEmbeddingTargetSpaceId,
    resolveProviderEmbeddingSpace,
    RetiredEmbeddingSpaceError,
    setVibeEmbeddingTargetSpaceId,
} from "../services/embeddingSpaces";
import { fetchProviderSpace } from "../services/vibeProvider";
import {
    recordVibeSpaceTransition,
    setVibeMigrationActive,
    setVibeProviderQueueCapacity,
} from "../metrics";
import type { VibeEmbeddingCoverage } from "../metrics/vibeEmbedMetrics";
import { logger } from "../utils/logger";
import { blockingBlPop, redisClient } from "../utils/redis";
import {
    cleanupLegacyVibeRedisArtifacts,
    VIBE_PROVIDER_QUEUE_KEY,
} from "./legacyVibeRedisCleanup";
import {
    writeVibeWorkerStatus,
    type VibeWorkerStatus,
} from "./vibeWorkerStatus";

const BLPOP_TIMEOUT_SECONDS = 1;
const COVERAGE_REFRESH_INTERVAL_MS = 60_000;
const SPACE_LIFECYCLE_INTERVAL_MS = 5 * 60_000;
const POP_ERROR_BACKOFF_MS = 250;
const TARGET_RESOLUTION_RETRY_MS = 60_000;
const TERMINAL_TARGET_RESOLUTION_RETRY_MS = 15 * 60_000;
const LEGACY_CLEANUP_TIMEOUT_MS = 60_000;

interface WorkerLogger {
    info(message: string, context?: unknown): void;
    warn(message: string, context?: unknown): void;
    error(message: string, context?: unknown): void;
}

interface VibeEmbedWorkerDependencies {
    providerUrl: string | undefined;
    audioAnalysisEnabled: boolean;
    concurrency: number;
    pop(queue: string, timeoutSeconds: number): Promise<string | null>;
    processJob(
        rawJob: string,
        targetSpace: VibeWorkerJobTargetSpace,
    ): Promise<unknown>;
    requeue(rawJob: string): Promise<void>;
    refreshCoverage(targetSpaceId: string): Promise<VibeEmbeddingCoverage>;
    runLifecycle(): Promise<void>;
    cleanupLegacyArtifacts(): Promise<void>;
    resolveTargetSpace(): Promise<ResolvedWorkerTargetSpace>;
    setTargetSpace(spaceId: string): void;
    clearTargetSpace(): void;
    recordSpaceTransition(transition: "registered"): void;
    setMigrationActive(active: boolean): void;
    writeStatus(status: VibeWorkerStatus): Promise<void>;
    now(): Date;
    logger: WorkerLogger;
}

interface VibeWorkerJobTargetSpace extends VibeEmbedJobTargetSpace {
    registered: boolean;
}

interface ResolvedWorkerTargetSpace extends VibeWorkerJobTargetSpace {
    family: string;
}

/** Lifecycle surface for the backend-driven audio embedding consumer. */
export interface VibeEmbedWorker {
    start(): Promise<boolean>;
    stop(): Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleAtDeadline(
    task: Promise<void>,
    timeoutMs: number,
): Promise<"completed" | "deadline"> {
    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), timeoutMs);
        timer.unref();
    });
    try {
        return await Promise.race([
            task.then(() => "completed" as const),
            deadline,
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function isTerminalTargetResolutionError(error: unknown): boolean {
    return (
        error instanceof RetiredEmbeddingSpaceError ||
        error instanceof EmbeddingSpaceDimensionMismatchError ||
        error instanceof EmbeddingSpacePreprocessingMismatchError
    );
}

/** Creates a provider-gated, bounded, drainable audio embedding worker. */
class VibeEmbedWorkerRuntime implements VibeEmbedWorker {
    private readonly limit: ReturnType<typeof pLimit>;
    private readonly active = new Set<Promise<void>>();
    private running = false;
    private loopPromise: Promise<void> | null = null;
    private coverageInterval: NodeJS.Timeout | null = null;
    private lifecycleInterval: NodeJS.Timeout | null = null;
    private lifecycleTask: Promise<void> | null = null;
    private targetSpace: ResolvedWorkerTargetSpace | null = null;
    private retryWake: (() => void) | null = null;
    private terminalResolutionFailureCount = 0;
    private cleanupStarted = false;
    private cleanupTask: Promise<void> | null = null;
    private providerReachability:
        | VibeWorkerStatus["providerReachability"]
        | null = null;
    private coverage: VibeEmbeddingCoverage | null = null;
    private statusWriteTask: Promise<void> = Promise.resolve();
    private stopped = false;

    constructor(private readonly dependencies: VibeEmbedWorkerDependencies) {
        this.limit = pLimit(dependencies.concurrency);
    }

    private async refreshCoverage(): Promise<void> {
        if (!this.targetSpace) return;
        try {
            this.coverage = await this.dependencies.refreshCoverage(
                this.targetSpace.id,
            );
            await this.publishStatus();
        } catch (error) {
            this.dependencies.logger.warn(
                "Vibe coverage refresh failed",
                error,
            );
        }
    }

    private async publishStatus(): Promise<void> {
        if (!this.providerReachability) return;
        const targetSpace = this.targetSpace
            ? {
                  id: this.targetSpace.id,
                  family: this.targetSpace.family,
                  status: this.targetSpace.status,
              }
            : null;
        const status = {
            providerReachability: this.providerReachability,
            targetSpace,
            coverage: this.coverage,
        };
        const writeTask = this.statusWriteTask
            .then(() => this.dependencies.writeStatus(status))
            .catch((error) => {
                this.dependencies.logger.warn(
                    "Failed to publish vibe worker status",
                    error,
                );
            });
        this.statusWriteTask = writeTask;
        await writeTask;
    }

    private scheduleLifecycle(): void {
        if (this.lifecycleTask) return;
        const task = this.dependencies
            .runLifecycle()
            .catch((error) => {
                this.dependencies.logger.warn(
                    "Embedding-space lifecycle check failed",
                    error,
                );
            })
            .finally(() => {
                if (this.lifecycleTask === task) this.lifecycleTask = null;
            });
        this.lifecycleTask = task;
    }

    private async runJob(rawJob: string): Promise<void> {
        try {
            if (!this.targetSpace) {
                throw new Error("Vibe embedding target space is unresolved");
            }
            const jobTarget = {
                id: this.targetSpace.id,
                dim: this.targetSpace.dim,
                status: this.targetSpace.status,
                registered: this.targetSpace.registered,
            };
            await this.dependencies.processJob(rawJob, jobTarget);
        } catch (error) {
            this.dependencies.logger.error(
                "Vibe embedding job failed before finalization",
                error,
            );
            await this.dependencies.requeue(rawJob).catch((requeueError) => {
                this.dependencies.logger.error(
                    "Failed to requeue unfinished vibe embedding job",
                    requeueError,
                );
            });
        }
    }

    private schedule(rawJob: string): void {
        const task = this.limit(() => this.runJob(rawJob)).finally(() => {
            this.active.delete(task);
        });
        this.active.add(task);
    }

    private async popNext(): Promise<string | null> {
        try {
            return await this.dependencies.pop(
                VIBE_PROVIDER_QUEUE_KEY,
                BLPOP_TIMEOUT_SECONDS,
            );
        } catch (error) {
            this.dependencies.logger.warn(
                "Vibe embedding queue pop failed",
                error,
            );
            await delay(POP_ERROR_BACKOFF_MS);
            return null;
        }
    }

    private async runLoop(): Promise<void> {
        while (this.running) {
            if (!this.targetSpace) {
                await this.resolveTargetSpace();
                continue;
            }
            if (this.active.size >= this.dependencies.concurrency) {
                await Promise.race(this.active);
                continue;
            }
            const rawJob = await this.popNext();
            if (rawJob !== null) this.schedule(rawJob);
        }
        await Promise.allSettled(this.active);
    }

    private waitForTargetRetry(milliseconds: number): Promise<void> {
        return new Promise((resolve) => {
            let timer: NodeJS.Timeout | null = null;
            const finish = () => {
                if (timer) clearTimeout(timer);
                timer = null;
                if (this.retryWake === finish) this.retryWake = null;
                resolve();
            };
            timer = setTimeout(finish, milliseconds);
            timer.unref();
            this.retryWake = finish;
        });
    }

    private activateTarget(target: ResolvedWorkerTargetSpace): void {
        this.terminalResolutionFailureCount = 0;
        this.targetSpace = target;
        this.dependencies.setTargetSpace(target.id);
        this.dependencies.setMigrationActive(target.status === "migrating");
        if (target.registered) {
            this.dependencies.recordSpaceTransition("registered");
            this.dependencies.logger.warn(
                "Registered provider embedding space for migration",
                { spaceId: target.id },
            );
        }
        void this.publishStatus();
        this.startCoverageRefresh();
        this.startLifecycleChecks();
        this.dependencies.logger.info("Vibe embedding worker started", {
            concurrency: this.dependencies.concurrency,
            targetSpaceId: target.id,
            targetSpaceStatus: target.status,
        });
    }

    private async resolveTargetSpace(): Promise<void> {
        try {
            const target = await this.dependencies.resolveTargetSpace();
            if (this.stopped || !this.running) return;
            this.providerReachability = {
                reachable: true,
                checkedAt: this.dependencies.now().toISOString(),
            };
            this.activateTarget(target);
        } catch (error) {
            this.providerReachability = {
                reachable: false,
                checkedAt: this.dependencies.now().toISOString(),
            };
            const retryDelayMs = this.recordTargetResolutionFailure(error);
            void this.publishStatus();
            if (this.running) await this.waitForTargetRetry(retryDelayMs);
        }
    }

    private recordTargetResolutionFailure(error: unknown): number {
        if (!isTerminalTargetResolutionError(error)) {
            this.terminalResolutionFailureCount = 0;
            this.dependencies.logger.error(
                "Vibe embedding worker target-space resolution failed",
                { error },
            );
            return TARGET_RESOLUTION_RETRY_MS;
        }
        this.terminalResolutionFailureCount += 1;
        if (this.terminalResolutionFailureCount === 1) {
            this.dependencies.logger.error(
                "Vibe embedding worker target-space resolution failed",
                { error },
            );
        } else {
            this.dependencies.logger.warn(
                "Vibe embedding worker target-space resolution remains blocked",
                { error },
            );
        }
        return TERMINAL_TARGET_RESOLUTION_RETRY_MS;
    }

    private startCoverageRefresh(): void {
        void this.refreshCoverage();
        this.coverageInterval = setInterval(
            () => void this.refreshCoverage(),
            COVERAGE_REFRESH_INTERVAL_MS,
        );
        this.coverageInterval.unref();
    }

    private startLifecycleChecks(): void {
        this.scheduleLifecycle();
        this.lifecycleInterval = setInterval(
            () => this.scheduleLifecycle(),
            SPACE_LIFECYCLE_INTERVAL_MS,
        );
        this.lifecycleInterval.unref();
    }

    private startLegacyCleanup(): void {
        if (this.cleanupStarted) return;
        this.cleanupStarted = true;
        const task = this.runLegacyCleanup().finally(() => {
            if (this.cleanupTask === task) this.cleanupTask = null;
        });
        this.cleanupTask = task;
    }

    private async runLegacyCleanup(): Promise<void> {
        try {
            const outcome = await settleAtDeadline(
                this.dependencies.cleanupLegacyArtifacts(),
                LEGACY_CLEANUP_TIMEOUT_MS,
            );
            if (outcome === "deadline") {
                this.dependencies.logger.warn(
                    "Legacy vibe Redis cleanup abandoned at its deadline",
                    { timeoutMs: LEGACY_CLEANUP_TIMEOUT_MS },
                );
            }
        } catch (error) {
            this.dependencies.logger.warn(
                "Legacy vibe Redis cleanup failed",
                error,
            );
        }
    }

    async start(): Promise<boolean> {
        if (
            !this.dependencies.providerUrl ||
            !this.dependencies.audioAnalysisEnabled
        )
            return false;
        if (this.running) return true;
        this.stopped = false;
        this.running = true;
        this.startLegacyCleanup();
        this.loopPromise = this.runLoop();
        return true;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.running = false;
        this.retryWake?.();
        if (this.coverageInterval) clearInterval(this.coverageInterval);
        this.coverageInterval = null;
        if (this.lifecycleInterval) clearInterval(this.lifecycleInterval);
        this.lifecycleInterval = null;
        await this.lifecycleTask;
        this.lifecycleTask = null;
        await this.cleanupTask;
        this.cleanupTask = null;
        await this.loopPromise;
        this.loopPromise = null;
        this.targetSpace = null;
        this.dependencies.clearTargetSpace();
    }
}

/** Creates a provider-gated, bounded, drainable audio embedding worker. */
export function createVibeEmbedWorker(
    dependencies: VibeEmbedWorkerDependencies,
): VibeEmbedWorker {
    return new VibeEmbedWorkerRuntime(dependencies);
}

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("VibeEmbedWorker")
        : logger;
const worker = createVibeEmbedWorker({
    providerUrl: config.vibeProviderUrl,
    audioAnalysisEnabled: config.features.audioAnalysis,
    concurrency: config.vibeEmbedConcurrency,
    pop: async (queue, timeoutSeconds) => {
        const result = await blockingBlPop(queue, timeoutSeconds);
        return result?.element ?? null;
    },
    processJob: processVibeEmbedJob,
    requeue: async (rawJob) => {
        await redisClient.rPush(VIBE_PROVIDER_QUEUE_KEY, rawJob);
    },
    refreshCoverage: async (targetSpaceId) => {
        return refreshVibeEmbeddingCoverage(targetSpaceId);
    },
    runLifecycle: async () => {
        const currentProviderSpaceId = await getVibeEmbeddingTargetSpaceId();
        await runEmbeddingSpaceLifecycleCheck({
            threshold: config.vibeSpaceCutoverThreshold,
            retirementGraceDays: config.vibeSpaceRetirementGraceDays,
            allowFailed: config.vibeSpaceCutoverAllowFailed,
            currentProviderSpaceId,
            now: () => new Date(),
        });
    },
    cleanupLegacyArtifacts: async () => {
        const result = await cleanupLegacyVibeRedisArtifacts(redisClient, log);
        log.info("Legacy vibe Redis cleanup completed", result);
    },
    resolveTargetSpace: async () => {
        const providerSpace = await fetchProviderSpace();
        const resolution = await resolveProviderEmbeddingSpace(providerSpace);
        return {
            id: resolution.space.id,
            dim: resolution.space.dim,
            status: resolution.space.status,
            registered: resolution.registered,
            family: resolution.space.family,
        };
    },
    setTargetSpace: setVibeEmbeddingTargetSpaceId,
    clearTargetSpace: clearVibeEmbeddingTargetSpaceId,
    recordSpaceTransition: recordVibeSpaceTransition,
    setMigrationActive: setVibeMigrationActive,
    writeStatus: async (status) => {
        await writeVibeWorkerStatus(redisClient, status);
    },
    now: () => new Date(),
    logger: log,
});

setVibeProviderQueueCapacity(config.analysisQueues.vibeMaxDepth);

/** Starts the singleton consumer when provider mode is enabled. */
export function startVibeEmbedWorker(): Promise<boolean> {
    return worker.start();
}

/** Stops intake and waits for every popped audio job to finish. */
export async function stopVibeEmbedWorker(): Promise<void> {
    await worker.stop();
}
