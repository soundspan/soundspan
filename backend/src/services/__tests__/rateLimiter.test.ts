export {};

const queueInstances: any[] = [];

jest.mock("p-queue", () => ({
    __esModule: true,
    default: class MockPQueue {
        concurrency: number;
        intervalCap: number;
        interval: number;
        carryoverConcurrencyCount: boolean;
        pending: number;
        size: number;
        add: jest.Mock;
        onIdle: jest.Mock;
        clear: jest.Mock;

        constructor(options: any) {
            this.concurrency = options.concurrency;
            this.intervalCap = options.intervalCap;
            this.interval = options.interval;
            this.carryoverConcurrencyCount = options.carryoverConcurrencyCount;
            this.pending = 0;
            this.size = 0;
            this.add = jest.fn(async (task: () => Promise<any>) => task());
            this.onIdle = jest.fn(async () => undefined);
            this.clear = jest.fn();
            queueInstances.push(this);
        }
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

async function loadRateLimiterModule() {
    jest.resetModules();
    queueInstances.length = 0;
    return import("../rateLimiter");
}

describe("rateLimiter", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("initializes per-service queues with expected limits", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const queues = (rateLimiter as any).queues as Map<string, any>;

        expect(queues.size).toBe(6);
        expect(queues.get("lastfm").intervalCap).toBe(3);
        expect(queues.get("musicbrainz").concurrency).toBe(1);
        expect(queues.get("deezer").interval).toBe(5000);
    });

    it("throws for unknown services", async () => {
        const { rateLimiter } = await loadRateLimiterModule();

        await expect(
            rateLimiter.execute("unknown" as any, async () => "ok")
        ).rejects.toThrow("Unknown service: unknown");
    });

    it("executes requests successfully through queue", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const requestFn = jest.fn().mockResolvedValue("ok");

        const result = await rateLimiter.execute("lastfm", requestFn);

        const lastfmQueue = (rateLimiter as any).queues.get("lastfm");
        expect(result).toBe("ok");
        expect(requestFn).toHaveBeenCalledTimes(1);
        expect(lastfmQueue.add).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ priority: 0 })
        );
    });

    it("retries and succeeds on rate limit errors", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const sleepSpy = jest
            .spyOn(rateLimiter as any, "sleep")
            .mockResolvedValue(undefined);
        jest.spyOn(Math, "random").mockReturnValue(0);

        const requestFn = jest
            .fn()
            .mockRejectedValueOnce({ response: { status: 429 }, message: "429" })
            .mockResolvedValue("ok-after-retry");

        const result = await rateLimiter.execute("lastfm", requestFn);

        expect(result).toBe("ok-after-retry");
        expect(requestFn).toHaveBeenCalledTimes(2);
        expect(sleepSpy).toHaveBeenCalledWith(1000);
    });

    it("does not retry when skipRetry is enabled", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const sleepSpy = jest
            .spyOn(rateLimiter as any, "sleep")
            .mockResolvedValue(undefined);
        const error = { response: { status: 429 }, message: "429" };
        const requestFn = jest.fn().mockRejectedValue(error);

        await expect(
            rateLimiter.execute("lastfm", requestFn, { skipRetry: true })
        ).rejects.toEqual(error);
        expect(requestFn).toHaveBeenCalledTimes(1);
        expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("retries transient network failures", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const sleepSpy = jest
            .spyOn(rateLimiter as any, "sleep")
            .mockResolvedValue(undefined);
        jest.spyOn(Math, "random").mockReturnValue(0);

        const requestFn = jest
            .fn()
            .mockRejectedValueOnce({ code: "ETIMEDOUT", message: "timeout" })
            .mockResolvedValue("ok");

        const result = await rateLimiter.execute("deezer", requestFn);

        expect(result).toBe("ok");
        expect(requestFn).toHaveBeenCalledTimes(2);
        expect(sleepSpy).toHaveBeenCalledWith(500);
    });

    it("waits for open circuit breakers, then resets and proceeds", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const circuit = (rateLimiter as any).circuitBreakers.get("lastfm");
        const sleepSpy = jest
            .spyOn(rateLimiter as any, "sleep")
            .mockResolvedValue(undefined);

        circuit.isOpen = true;
        circuit.openedAt = Date.now();
        circuit.resetAfterMs = 5000;
        circuit.consecutiveFailures = 4;

        const requestFn = jest.fn().mockResolvedValue("ok");
        await rateLimiter.execute("lastfm", requestFn);

        expect(sleepSpy).toHaveBeenCalledWith(expect.any(Number));
        expect(circuit.isOpen).toBe(false);
        expect(circuit.consecutiveFailures).toBe(0);
    });

    it("pauses and resumes globally", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const sleepSpy = jest
            .spyOn(rateLimiter as any, "sleep")
            .mockResolvedValue(undefined);

        rateLimiter.pauseAll(5000);
        const result = await rateLimiter.execute(
            "fanart",
            async () => "during-pause"
        );

        expect(result).toBe("during-pause");
        expect(sleepSpy).toHaveBeenCalledWith(expect.any(Number));

        rateLimiter.resume();
        expect((rateLimiter as any).globalPaused).toBe(false);
    });

    it("provides queue stats and queue lifecycle controls", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const queues = (rateLimiter as any).queues as Map<string, any>;
        queues.get("lastfm").pending = 2;
        queues.get("lastfm").size = 7;

        const stats = rateLimiter.getStats();
        expect(stats.lastfm).toEqual({ pending: 2, size: 7 });

        await rateLimiter.drain();
        for (const queue of queues.values()) {
            expect(queue.onIdle).toHaveBeenCalledTimes(1);
        }

        rateLimiter.clear();
        for (const queue of queues.values()) {
            expect(queue.clear).toHaveBeenCalledTimes(1);
        }
    });

    it("updates per-service concurrency by clamped multiplier", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        const queues = (rateLimiter as any).queues as Map<string, any>;

        rateLimiter.updateConcurrencyMultiplier(10);
        expect(rateLimiter.getConcurrencyMultiplier()).toBe(5);
        expect(queues.get("lastfm").concurrency).toBe(3);
        expect(queues.get("musicbrainz").concurrency).toBe(1);
        expect(queues.get("deezer").concurrency).toBe(25);

        rateLimiter.updateConcurrencyMultiplier(0);
        expect(rateLimiter.getConcurrencyMultiplier()).toBe(1);
        expect(queues.get("deezer").concurrency).toBe(5);
    });

    it("calculates backoff from Retry-After and exponential fallback", async () => {
        const { rateLimiter } = await loadRateLimiterModule();
        jest.spyOn(Math, "random").mockReturnValue(0);

        const retryAfterDelay = (rateLimiter as any).calculateBackoff(0, 1000, {
            response: { headers: { "retry-after": "7" } },
        });
        const exponentialDelay = (rateLimiter as any).calculateBackoff(2, 1000);

        expect(retryAfterDelay).toBe(7000);
        expect(exponentialDelay).toBe(4000);
    });

    it("detects transient failures by code, status, and message", async () => {
        const { rateLimiter } = await loadRateLimiterModule();

        expect(
            (rateLimiter as any).isTransientError({ code: "ECONNRESET" })
        ).toBe(true);
        expect(
            (rateLimiter as any).isTransientError({ response: { status: 503 } })
        ).toBe(true);
        expect(
            (rateLimiter as any).isTransientError({ message: "Socket hang up" })
        ).toBe(true);
        expect(
            (rateLimiter as any).isTransientError({ message: "validation failed" })
        ).toBe(false);
    });
});
