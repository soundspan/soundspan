jest.mock("../../config", () => ({
    config: {
        vibeProviderUrl: undefined,
        vibeEmbedConcurrency: 1,
        features: { audioAnalysis: true },
        redisUrl: "redis://mock:6379",
        internalApiSecret: "test-secret",
    },
}));

import { createVibeEmbedWorker } from "../vibeEmbedWorker";

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
        const refreshCoverage = jest.fn(async () => undefined);
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
            logger,
        });
        return {
            worker,
            pop,
            processJob,
            requeue,
            refreshCoverage,
            logger,
        };
    }

    afterEach(() => {
        jest.useRealTimers();
    });

    it("does not start when the provider URL is unset", async () => {
        const harness = createHarness();

        expect(harness.worker.start()).toBe(false);
        await harness.worker.stop();

        expect(harness.pop).not.toHaveBeenCalled();
        expect(harness.refreshCoverage).not.toHaveBeenCalled();
    });

    it("does not start when audio analysis is disabled", async () => {
        const harness = createHarness({
            providerUrl: "http://provider:8090",
            audioAnalysisEnabled: false,
        });

        expect(harness.worker.start()).toBe(false);
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

        expect(harness.worker.start()).toBe(true);
        await flushPromises();
        expect(harness.pop).toHaveBeenCalledWith("audio:clap:queue", 1);
        expect(harness.refreshCoverage).toHaveBeenCalledTimes(1);

        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
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

        harness.worker.start();
        await flushPromises();
        expect(harness.processJob).toHaveBeenCalledTimes(1);

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

        harness.worker.start();
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

        harness.worker.start();
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

        harness.worker.start();
        await flushPromises();

        expect(harness.requeue).toHaveBeenCalledWith("unfinished-job");
        const stopping = harness.worker.stop();
        secondPop.resolve(null);
        await stopping;
    });

    it("refreshes coverage on the slow worker interval", async () => {
        jest.useFakeTimers();
        const firstPop = deferred<string | null>();
        const harness = createHarness({
            providerUrl: "http://provider:8090",
        });
        harness.pop.mockReturnValueOnce(firstPop.promise);

        harness.worker.start();
        await Promise.resolve();
        expect(harness.refreshCoverage).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(60_000);
        expect(harness.refreshCoverage).toHaveBeenCalledTimes(2);

        const stopping = harness.worker.stop();
        firstPop.resolve(null);
        await stopping;
    });
});
