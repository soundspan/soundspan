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
    resolveProviderEmbeddingSpace,
    RetiredEmbeddingSpaceError,
    setVibeEmbeddingTargetSpaceId,
} from "../services/embeddingSpaces";
import { fetchProviderSpace } from "../services/vibeProvider";
import { recordVibeSpaceTransition } from "../metrics";
import { logger } from "../utils/logger";
import { blockingBlPop, redisClient } from "../utils/redis";

const VIBE_QUEUE = "audio:clap:queue";
const BLPOP_TIMEOUT_SECONDS = 1;
const COVERAGE_REFRESH_INTERVAL_MS = 60_000;
const SPACE_LIFECYCLE_INTERVAL_MS = 5 * 60_000;
const POP_ERROR_BACKOFF_MS = 250;
const TARGET_RESOLUTION_RETRY_MS = 60_000;
const TERMINAL_TARGET_RESOLUTION_RETRY_MS = 15 * 60_000;

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
        targetSpace: ResolvedWorkerTargetSpace,
    ): Promise<unknown>;
    requeue(rawJob: string): Promise<void>;
    refreshCoverage(targetSpaceId: string): Promise<void>;
    runLifecycle(): Promise<void>;
    resolveTargetSpace(): Promise<ResolvedWorkerTargetSpace>;
    setTargetSpace(spaceId: string): void;
    clearTargetSpace(): void;
    recordSpaceTransition(transition: "registered"): void;
    logger: WorkerLogger;
}

interface ResolvedWorkerTargetSpace extends VibeEmbedJobTargetSpace {
    registered: boolean;
}

/** Lifecycle surface for the backend-driven audio embedding consumer. */
export interface VibeEmbedWorker {
    start(): Promise<boolean>;
    stop(): Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    private stopped = false;

    constructor(private readonly dependencies: VibeEmbedWorkerDependencies) {
        this.limit = pLimit(dependencies.concurrency);
    }

    private async refreshCoverage(): Promise<void> {
        if (!this.targetSpace) return;
        try {
            await this.dependencies.refreshCoverage(this.targetSpace.id);
        } catch (error) {
            this.dependencies.logger.warn(
                "Vibe coverage refresh failed",
                error,
            );
        }
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
            await this.dependencies.processJob(rawJob, this.targetSpace);
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
                VIBE_QUEUE,
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
        if (target.registered) {
            this.dependencies.recordSpaceTransition("registered");
            this.dependencies.logger.warn(
                "Registered provider embedding space for migration",
                { spaceId: target.id },
            );
        }
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
            this.activateTarget(target);
        } catch (error) {
            const retryDelayMs = this.recordTargetResolutionFailure(error);
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

    async start(): Promise<boolean> {
        if (
            !this.dependencies.providerUrl ||
            !this.dependencies.audioAnalysisEnabled
        )
            return false;
        if (this.running) return true;
        this.stopped = false;
        this.running = true;
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
        await redisClient.rPush(VIBE_QUEUE, rawJob);
    },
    refreshCoverage: async (targetSpaceId) => {
        await refreshVibeEmbeddingCoverage(targetSpaceId);
    },
    runLifecycle: async () => {
        await runEmbeddingSpaceLifecycleCheck({
            threshold: config.vibeSpaceCutoverThreshold,
            retirementGraceDays: config.vibeSpaceRetirementGraceDays,
            now: () => new Date(),
        });
    },
    resolveTargetSpace: async () => {
        const providerSpace = await fetchProviderSpace();
        const resolution = await resolveProviderEmbeddingSpace(providerSpace);
        return {
            id: resolution.space.id,
            dim: resolution.space.dim,
            status: resolution.space.status,
            registered: resolution.registered,
        };
    },
    setTargetSpace: setVibeEmbeddingTargetSpaceId,
    clearTargetSpace: clearVibeEmbeddingTargetSpaceId,
    recordSpaceTransition: recordVibeSpaceTransition,
    logger: log,
});

/** Starts the singleton consumer when provider mode is enabled. */
export function startVibeEmbedWorker(): Promise<boolean> {
    return worker.start();
}

/** Stops intake and waits for every popped audio job to finish. */
export async function stopVibeEmbedWorker(): Promise<void> {
    await worker.stop();
}
