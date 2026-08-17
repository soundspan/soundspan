jest.mock("../../config", () => ({
    config: {
        vibeProviderUrl: undefined,
        vibeEmbedConcurrency: 1,
        analysisQueues: { vibeMaxDepth: 100 },
        features: { audioAnalysis: true },
        redisUrl: "redis://mock:6379",
        internalApiSecret: "test-secret",
    },
}));

import { createVibeEmbedWorker } from "../vibeEmbedWorker";
import {
    EmbeddingSpaceDimensionMismatchError,
    EmbeddingSpacePreprocessingMismatchError,
    RetiredEmbeddingSpaceError,
} from "../../services/embeddingSpaces";
import { EmbeddingTargetInvalidatedError } from "../../services/trackEmbeddings";

const flushPromises = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("vibe embed worker", () => {
    function createHarness(overrides?: {
        providerUrl?: string;
        concurrency?: number;
        audioAnalysisEnabled?: boolean;
    }) {
        const pop = jest.fn<Promise<string | null>, [string, number]>();
        const processJob = jest.fn(async () => "stored" as const);
        const requeue = jest.fn(async () => undefined);
        const refreshCoverage = jest.fn(async () => ({
            embedded: 8,
            pending: 2,
            failed: 1,
        }));
        const runLifecycle = jest.fn(async () => undefined);
        const cleanupLegacyArtifacts = jest.fn<Promise<void>, []>(
            async () => undefined,
        );
        const setTargetSpace = jest.fn();
        const clearTargetSpace = jest.fn();
        const recordSpaceTransition = jest.fn();
        const setMigrationActive = jest.fn();
        const writeStatus = jest.fn(async () => undefined);
        const now = jest.fn(() => new Date("2026-08-17T12:00:00.000Z"));
        const resolveTargetSpace = jest.fn<
            Promise<{
                id: string;
                dim: number;
                status: "active" | "migrating";
                registered: boolean;
                family: string;
            }>,
            []
        >(async () => ({
            id: "space-active",
            dim: 2,
            status: "active",
            registered: false,
            family: "test-family",
        }));
        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const worker = createVibeEmbedWorker({
            providerUrl: overrides?.providerUrl,
            audioAnalysisEnabled: overrides?.audioAnalysisEnabled ?? true,
            concurrency: overrides?.concurrency ?? 1,
            pop,
            processJob,
            requeue,
            refreshCoverage,
            runLifecycle,
            cleanupLegacyArtifacts,
            setTargetSpace,
            clearTargetSpace,
            recordSpaceTransition,
            setMigrationActive,
            writeStatus,
            now,
            resolveTargetSpace,
            logger,
        });
        return {
            worker,
            pop,
            processJob,
            requeue,
            refreshCoverage,
            runLifecycle,
            cleanupLegacyArtifacts,
            setTargetSpace,
            clearTargetSpace,
            recordSpaceTransition,
            setMigrationActive,
            writeStatus,
            resolveTargetSpace,
            logger,
        };
    }

    afterEach(() => {
        jest.useRealTimers();
    });

    it("does not start when the provider URL is unset", async () => {
        const harness = createHarness();

        await expect(harness.worker.start()).resolves.toBe(false);
        await harness.worker.stop();

        expect(harness.pop).not.toHaveBeenCalled();
        expect(harness.refreshCoverage).not.toHaveBeenCalled();
    });

    it("does not start when audio analysis is disabled", async () => {
        const harness = createHarness({
            providerUrl: "http://provider:8090",
            audioAnalysisEnabled: false,
        });

        await expect(harness.worker.start()).resolves.toBe(false);
        await harness.worker.stop();

        expect(harness.pop).not.toHaveBeenCalled();
        expect(harness.refreshCoverage).not.toHaveBeenCalled();
    });

    it("starts intake and coverage only when provider mode is enabled", async () => {
        const firstPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop.mockReturnValueOnce(firstPop.promise);

        await expect(harness.worker.start()).resolves.toBe(true);
        await flushPromises();
        expect(harness.pop).toHaveBeenCalledWith("audio:clap:queue", 1);
        expect(harness.refreshCoverage).toHaveBeenCalledTimes(1);
        expect(harness.refreshCoverage).toHaveBeenCalledWith("space-active");
        expect(harness.writeStatus).toHaveBeenLastCalledWith({
            providerReachability: {
                reachable: true,
                checkedAt: "2026-08-17T12:00:00.000Z",
            },
            targetSpace: {
                id: "space-active",
                family: "test-family",
                status: "active",
            },
            coverage: { embedded: 8, pending: 2, failed: 1 },
        });

        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
    });

    it("starts legacy cleanup once without delaying intake on failure", async () => {
        const firstPop = deferred<string | null>();
        const cleanup = deferred<void>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop.mockReturnValueOnce(firstPop.promise);
        harness.cleanupLegacyArtifacts.mockReturnValueOnce(cleanup.promise);

        await expect(harness.worker.start()).resolves.toBe(true);
        await expect(harness.worker.start()).resolves.toBe(true);
        await flushPromises();

        expect(harness.cleanupLegacyArtifacts).toHaveBeenCalledTimes(1);
        expect(harness.pop).toHaveBeenCalledWith("audio:clap:queue", 1);

        cleanup.resolve();
        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
    });

    it("logs legacy cleanup failure and continues provider intake", async () => {
        const firstPop = deferred<string | null>();
        const error = new Error("redis unavailable");
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop.mockReturnValueOnce(firstPop.promise);
        harness.cleanupLegacyArtifacts.mockRejectedValueOnce(error);

        await expect(harness.worker.start()).resolves.toBe(true);
        await flushPromises();

        expect(harness.pop).toHaveBeenCalledWith("audio:clap:queue", 1);
        expect(harness.logger.warn).toHaveBeenCalledWith(
            "Legacy vibe Redis cleanup failed",
            error,
        );

        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
    });

    it("abandons legacy cleanup at the fixed shutdown deadline", async () => {
        jest.useFakeTimers();
        const firstPop = deferred<string | null>();
        const cleanup = deferred<void>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop.mockReturnValueOnce(firstPop.promise);
        harness.cleanupLegacyArtifacts.mockReturnValueOnce(cleanup.promise);

        await harness.worker.start();
        await Promise.resolve();
        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await jest.advanceTimersByTimeAsync(60_000);

        await expect(stopping).resolves.toBeUndefined();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            "Legacy vibe Redis cleanup abandoned at its deadline",
            { timeoutMs: 60_000 },
        );
    });

    it("finishes an in-flight job before shutdown resolves", async () => {
        const job = deferred<"stored">();
        const secondPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop
            .mockResolvedValueOnce('{"trackId":"track-1"}')
            .mockReturnValueOnce(secondPop.promise);
        harness.processJob.mockReturnValueOnce(job.promise);

        await harness.worker.start();
        await flushPromises();
        expect(harness.processJob).toHaveBeenCalledTimes(1);
        expect(harness.processJob).toHaveBeenCalledWith(
            '{"trackId":"track-1"}',
            {
                id: "space-active",
                dim: 2,
                status: "active",
                registered: false,
            },
        );

        let stopped = false;
        const stopping = harness.worker.stop().then(() => {
            stopped = true;
        });
        await flushPromises();
        expect(stopped).toBe(false);

        job.resolve("stored");
        secondPop.resolve(null);
        await stopping;
        expect(stopped).toBe(true);
        expect(harness.requeue).not.toHaveBeenCalled();
    });

    it("awaits each bounded BLPOP timeout instead of busy-spinning", async () => {
        const firstPop = deferred<string | null>();
        const secondPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop
            .mockReturnValueOnce(firstPop.promise)
            .mockReturnValueOnce(secondPop.promise);

        await harness.worker.start();
        await flushPromises();
        expect(harness.pop).toHaveBeenCalledTimes(1);

        firstPop.resolve(null);
        await flushPromises();
        expect(harness.pop).toHaveBeenCalledTimes(2);
        expect(harness.pop).toHaveBeenNthCalledWith(2, "audio:clap:queue", 1);

        const stopping = harness.worker.stop();
        secondPop.resolve(null);
        await stopping;
    });

    it("bounds popped work to configured concurrency", async () => {
        const firstJob = deferred<"stored">();
        const secondJob = deferred<"stored">();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
            concurrency: 2,
        });
        harness.pop
            .mockResolvedValueOnce("job-1")
            .mockResolvedValueOnce("job-2")
            .mockResolvedValue(null);
        harness.processJob
            .mockReturnValueOnce(firstJob.promise)
            .mockReturnValueOnce(secondJob.promise);

        await harness.worker.start();
        await flushPromises();
        expect(harness.processJob).toHaveBeenCalledTimes(2);
        expect(harness.pop).toHaveBeenCalledTimes(2);

        const stopping = harness.worker.stop();
        firstJob.resolve("stored");
        secondJob.resolve("stored");
        await stopping;
    });

    it("requeues a popped job when processing cannot finalize it", async () => {
        const secondPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop
            .mockResolvedValueOnce("unfinished-job")
            .mockReturnValueOnce(secondPop.promise);
        harness.processJob.mockRejectedValueOnce(new Error("database down"));

        await harness.worker.start();
        await flushPromises();

        expect(harness.requeue).toHaveBeenCalledWith("unfinished-job");
        const stopping = harness.worker.stop();
        secondPop.resolve(null);
        await stopping;
    });

    it("requeues once and succeeds after a target is retired", async () => {
        const finalPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.resolveTargetSpace
            .mockResolvedValueOnce({
                id: "space-retired",
                dim: 2,
                status: "migrating",
                registered: false,
                family: "test-family",
            })
            .mockResolvedValueOnce({
                id: "space-new",
                dim: 2,
                status: "active",
                registered: false,
                family: "test-family",
            });
        harness.pop
            .mockResolvedValueOnce("target-invalidated-job")
            .mockResolvedValueOnce("target-invalidated-job")
            .mockReturnValueOnce(finalPop.promise);
        harness.processJob
            .mockRejectedValueOnce(
                new EmbeddingTargetInvalidatedError("space-retired"),
            )
            .mockResolvedValueOnce("stored");

        await harness.worker.start();
        await flushPromises();
        await flushPromises();

        expect(harness.requeue).toHaveBeenCalledTimes(1);
        expect(harness.resolveTargetSpace).toHaveBeenCalledTimes(2);
        expect(harness.processJob).toHaveBeenNthCalledWith(
            2,
            "target-invalidated-job",
            expect.objectContaining({ id: "space-new", status: "active" }),
        );
        expect(harness.logger.info).toHaveBeenCalledWith(
            "Vibe embedding target invalidated; resolving a fresh target",
            { spaceId: "space-retired" },
        );

        const stopping = harness.worker.stop();
        finalPop.resolve(null);
        await stopping;
    });

    it("refreshes coverage on the slow worker interval", async () => {
        jest.useFakeTimers();
        const firstPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop.mockReturnValueOnce(firstPop.promise);

        await harness.worker.start();
        await Promise.resolve();
        expect(harness.refreshCoverage).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(60_000);
        expect(harness.refreshCoverage).toHaveBeenCalledTimes(2);

        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
    });

    it.each(["active", "migrating"] as const)(
        "targets a provider resolved to a %s space",
        async (status) => {
            const firstPop = deferred<string | null>();
            const harness = createHarness({
                providerUrl: "http://provider:8090",
            });
            harness.resolveTargetSpace.mockResolvedValue({
                id: `space-${status}`,
                dim: 2,
                status,
                registered: false,
                family: "test-family",
            });
            harness.pop.mockReturnValueOnce(firstPop.promise);

            await expect(harness.worker.start()).resolves.toBe(true);
            expect(harness.setTargetSpace).toHaveBeenCalledWith(
                `space-${status}`,
            );
            expect(harness.setMigrationActive).toHaveBeenCalledWith(
                status === "migrating",
            );
            await flushPromises();
            expect(harness.processJob).not.toHaveBeenCalled();

            const stopping = harness.worker.stop();
            firstPop.resolve(null);
            await stopping;
        },
    );

    it("logs a prominent transition when resolution registers a new space", async () => {
        const firstPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.resolveTargetSpace.mockResolvedValue({
            id: "space-new",
            dim: 2,
            status: "migrating",
            registered: true,
            family: "test-family",
        });
        harness.pop.mockReturnValueOnce(firstPop.promise);

        await harness.worker.start();

        expect(harness.logger.warn).toHaveBeenCalledWith(
            "Registered provider embedding space for migration",
            { spaceId: "space-new" },
        );
        expect(harness.recordSpaceTransition).toHaveBeenCalledWith(
            "registered",
        );
        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
    });

    it("retries target resolution and starts consuming after recovery", async () => {
        jest.useFakeTimers();
        const firstPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        const error = new Error("registry unavailable");
        harness.resolveTargetSpace
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce({
                id: "space-recovered",
                dim: 3,
                status: "migrating",
                registered: false,
                family: "test-family",
            });
        harness.pop.mockReturnValueOnce(firstPop.promise);

        await expect(harness.worker.start()).resolves.toBe(true);
        await Promise.resolve();
        expect(harness.resolveTargetSpace).toHaveBeenCalledTimes(1);
        expect(harness.pop).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(60_000);

        expect(harness.resolveTargetSpace).toHaveBeenCalledTimes(2);
        expect(harness.pop).toHaveBeenCalledWith("audio:clap:queue", 1);
        expect(harness.logger.error).toHaveBeenCalledWith(
            "Vibe embedding worker target-space resolution failed",
            { error },
        );
        expect(harness.writeStatus).toHaveBeenCalledWith({
            providerReachability: {
                reachable: false,
                checkedAt: "2026-08-17T12:00:00.000Z",
            },
            targetSpace: null,
            coverage: null,
        });

        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
    });

    it.each([
        new RetiredEmbeddingSpaceError("space-retired"),
        new EmbeddingSpaceDimensionMismatchError("space-mismatch", 512, 768),
        new EmbeddingSpacePreprocessingMismatchError("space-mismatch"),
    ])(
        "rate-limits terminal target resolution error $name on a longer retry interval",
        async (error) => {
            jest.useFakeTimers();
            const harness = createHarness({
                providerUrl: "http://provider:8090",
            });
            harness.resolveTargetSpace.mockRejectedValue(error);

            await harness.worker.start();
            await Promise.resolve();

            expect(harness.resolveTargetSpace).toHaveBeenCalledTimes(1);
            expect(harness.logger.error).toHaveBeenCalledWith(
                "Vibe embedding worker target-space resolution failed",
                { error },
            );
            expect(harness.logger.warn).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(60_000);
            expect(harness.resolveTargetSpace).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(14 * 60_000);
            expect(harness.resolveTargetSpace).toHaveBeenCalledTimes(2);
            expect(harness.logger.error).toHaveBeenCalledTimes(1);
            expect(harness.logger.warn).toHaveBeenCalledWith(
                "Vibe embedding worker target-space resolution remains blocked",
                { error },
            );

            await jest.advanceTimersByTimeAsync(14 * 60_000);
            expect(harness.resolveTargetSpace).toHaveBeenCalledTimes(2);

            await harness.worker.stop();
        },
    );

    it("does not enter the consumer loop when stopped during target resolution", async () => {
        const target = deferred<{
            id: string;
            dim: number;
            status: "active";
            registered: false;
            family: string;
        }>();
        const firstPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.resolveTargetSpace.mockReturnValueOnce(target.promise);
        harness.pop.mockReturnValueOnce(firstPop.promise);

        const starting = harness.worker.start();
        await Promise.resolve();
        const stopping = harness.worker.stop();
        target.resolve({
            id: "space-late",
            dim: 2,
            status: "active",
            registered: false,
            family: "test-family",
        });

        await expect(starting).resolves.toBe(true);
        await flushPromises();
        const cleanup = harness.worker.stop();
        firstPop.resolve(null);
        await Promise.all([stopping, cleanup]);

        expect(harness.pop).not.toHaveBeenCalled();
        expect(harness.setTargetSpace).not.toHaveBeenCalled();
    });
});
