import { withTimeout } from "../withTimeout";

describe("withTimeout", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("aborts timed-out work, awaits settlement, and returns a timeout result", async () => {
        jest.useFakeTimers();
        const events: string[] = [];
        const operation = jest.fn(
            (signal: AbortSignal) =>
                new Promise<string>((_resolve, reject) => {
                    signal.addEventListener("abort", () => {
                        events.push("aborted");
                        queueMicrotask(() => {
                            events.push("settled");
                            reject(signal.reason);
                        });
                    });
                }),
        );

        const pending = withTimeout(operation, 100, "bounded-operation", {
            result: true,
            logger: { warn: jest.fn() },
        });
        await jest.advanceTimersByTimeAsync(100);

        await expect(pending).resolves.toEqual({ ok: false, timedOut: true });
        expect(operation).toHaveBeenCalledTimes(1);
        expect(operation.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
        expect(events).toEqual(["aborted", "settled"]);
    });

    it("returns a successful discriminated result before the deadline", async () => {
        await expect(
            withTimeout(
                async (signal) => {
                    expect(signal.aborted).toBe(false);
                    return 42;
                },
                1_000,
                "quick-operation",
                {
                    result: true,
                    logger: { warn: jest.fn() },
                },
            ),
        ).resolves.toEqual({ ok: true, value: 42 });
    });

    it("stops waiting when aborted work never settles", async () => {
        jest.useFakeTimers();
        const timeoutLogger = { warn: jest.fn() };
        const pending = withTimeout(
            () => new Promise<string>(() => undefined),
            100,
            "never-settling-operation",
            { result: true, logger: timeoutLogger },
        );

        await jest.advanceTimersByTimeAsync(100);
        let completed = false;
        void pending.then(() => {
            completed = true;
        });
        await jest.advanceTimersByTimeAsync(29_999);
        expect(completed).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ ok: false, timedOut: true });
        expect(timeoutLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Aborted operation did not settle within 30000ms",
            ),
        );
    });

    it("keeps the legacy undefined-on-timeout contract", async () => {
        jest.useFakeTimers();
        const pending = withTimeout(
            () => new Promise<string>(() => undefined),
            50,
            "legacy-operation",
            { warn: jest.fn() },
        );

        await jest.advanceTimersByTimeAsync(50);
        await expect(pending).resolves.toBeUndefined();
    });
});
