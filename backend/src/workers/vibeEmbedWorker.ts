import pLimit from "p-limit";
import { config } from "../config";
import { processVibeEmbedJob } from "../services/vibeEmbedJobs";
import { refreshVibeEmbeddingCoverage } from "../services/vibeEmbeddingCoverage";
import { logger } from "../utils/logger";
import { blockingBlPop, redisClient } from "../utils/redis";

const VIBE_QUEUE = "audio:clap:queue";
const BLPOP_TIMEOUT_SECONDS = 1;
const COVERAGE_REFRESH_INTERVAL_MS = 60_000;
const POP_ERROR_BACKOFF_MS = 250;

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
    processJob(rawJob: string): Promise<unknown>;
    requeue(rawJob: string): Promise<void>;
    refreshCoverage(): Promise<void>;
    logger: WorkerLogger;
}

/** Lifecycle surface for the backend-driven audio embedding consumer. */
export interface VibeEmbedWorker {
    start(): boolean;
    stop(): Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Creates a provider-gated, bounded, drainable audio embedding worker. */
class VibeEmbedWorkerRuntime implements VibeEmbedWorker {
    private readonly limit: ReturnType<typeof pLimit>;
    private readonly active = new Set<Promise<void>>();
    private running = false;
    private loopPromise: Promise<void> | null = null;
    private coverageInterval: NodeJS.Timeout | null = null;

    constructor(private readonly dependencies: VibeEmbedWorkerDependencies) {
        this.limit = pLimit(dependencies.concurrency);
    }

    private async refreshCoverage(): Promise<void> {
        try {
            await this.dependencies.refreshCoverage();
        } catch (error) {
            this.dependencies.logger.warn(
                "Vibe coverage refresh failed",
                error,
            );
        }
    }

    private async runJob(rawJob: string): Promise<void> {
        try {
            await this.dependencies.processJob(rawJob);
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
            if (this.active.size >= this.dependencies.concurrency) {
                await Promise.race(this.active);
                continue;
            }
            const rawJob = await this.popNext();
            if (rawJob !== null) this.schedule(rawJob);
        }
        await Promise.allSettled(this.active);
    }

    private startCoverageRefresh(): void {
        void this.refreshCoverage();
        this.coverageInterval = setInterval(
            () => void this.refreshCoverage(),
            COVERAGE_REFRESH_INTERVAL_MS,
        );
        this.coverageInterval.unref();
    }

    start(): boolean {
        if (
            !this.dependencies.providerUrl ||
            !this.dependencies.audioAnalysisEnabled
        )
            return false;
        if (this.running) return true;
        this.running = true;
        this.startCoverageRefresh();
        this.loopPromise = this.runLoop();
        this.dependencies.logger.info("Vibe embedding worker started", {
            concurrency: this.dependencies.concurrency,
        });
        return true;
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.coverageInterval) clearInterval(this.coverageInterval);
        this.coverageInterval = null;
        await this.loopPromise;
        this.loopPromise = null;
    }
}

/** Creates a provider-gated, bounded, drainable audio embedding worker. */
export function createVibeEmbedWorker(
    dependencies: VibeEmbedWorkerDependencies,
): VibeEmbedWorker {
    return new VibeEmbedWorkerRuntime(dependencies);
}

const log = logger.child("VibeEmbedWorker");
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
    refreshCoverage: refreshVibeEmbeddingCoverage,
    logger: log,
});

/** Starts the singleton consumer when provider mode is enabled. */
export function startVibeEmbedWorker(): boolean {
    return worker.start();
}

/** Stops intake and waits for every popped audio job to finish. */
export async function stopVibeEmbedWorker(): Promise<void> {
    await worker.stop();
}
