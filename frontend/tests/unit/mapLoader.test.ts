import assert from "node:assert/strict";
import test from "node:test";
import {
    pollVibeMap,
    type MapPollHandlers,
    type VibeMapResponse,
} from "../../components/vibe/mapLoader";

const READY: VibeMapResponse = {
    tracks: [],
    trackCount: 0,
    computedAt: "2026-09-17T00:00:00.000Z",
};

function recordingHandlers() {
    const events: string[] = [];
    const handlers: MapPollHandlers = {
        onReady: (payload) => events.push(`ready:${payload.computedAt}`),
        onBuilding: () => events.push("building"),
        onFailed: (retryAt) => events.push(`failed:${retryAt ?? "none"}`),
        onStalled: () => events.push("stalled"),
        onError: () => events.push("error"),
    };
    return { events, handlers };
}

/** Manual scheduler: captured callbacks run only when the test says so. */
function manualScheduler() {
    const queue: Array<{ callback: () => void; delayMs: number }> = [];
    let cleared = 0;
    return {
        queue,
        clearedCount: () => cleared,
        schedule(callback: () => void, delayMs: number) {
            queue.push({ callback, delayMs });
            return () => {
                cleared += 1;
            };
        },
        async flush() {
            const next = queue.shift();
            assert.ok(next, "expected a scheduled poll");
            next.callback();
            await settleMicrotasks();
        },
    };
}

async function settleMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function sequence(responses: VibeMapResponse[]) {
    let calls = 0;
    const signals: AbortSignal[] = [];
    return {
        calls: () => calls,
        signals,
        load: async (signal: AbortSignal) => {
            calls += 1;
            signals.push(signal);
            const next = responses.shift();
            assert.ok(next, "load called more times than responses provided");
            return next;
        },
    };
}

const OPTIONS = { intervalMs: 50, maxBuildingPolls: 2 };

test("a ready answer resolves immediately without scheduling", async () => {
    const { events, handlers } = recordingHandlers();
    const scheduler = manualScheduler();
    const source = sequence([READY]);
    pollVibeMap(source.load, handlers, {
        ...OPTIONS,
        schedule: scheduler.schedule,
    });
    await settleMicrotasks();
    assert.deepEqual(events, ["ready:2026-09-17T00:00:00.000Z"]);
    assert.equal(scheduler.queue.length, 0);
    assert.equal(source.calls(), 1);
    assert.equal(source.signals[0]?.aborted, false);
});

test("building answers re-poll on the configured interval until ready", async () => {
    const { events, handlers } = recordingHandlers();
    const scheduler = manualScheduler();
    const source = sequence([{ building: true }, { building: true }, READY]);
    pollVibeMap(source.load, handlers, {
        ...OPTIONS,
        schedule: scheduler.schedule,
    });
    await settleMicrotasks();
    assert.deepEqual(events, ["building"]);
    assert.equal(scheduler.queue[0]?.delayMs, 50);
    await scheduler.flush();
    assert.deepEqual(events, ["building", "building"]);
    await scheduler.flush();
    assert.deepEqual(events, [
        "building",
        "building",
        "ready:2026-09-17T00:00:00.000Z",
    ]);
    assert.equal(source.calls(), 3);
});

test("a failed build stops polling and reports the retry time", async () => {
    const { events, handlers } = recordingHandlers();
    const scheduler = manualScheduler();
    const source = sequence([
        { building: true, failed: true, retryAt: "2026-09-17T01:00:00.000Z" },
    ]);
    pollVibeMap(source.load, handlers, {
        ...OPTIONS,
        schedule: scheduler.schedule,
    });
    await settleMicrotasks();
    assert.deepEqual(events, ["failed:2026-09-17T01:00:00.000Z"]);
    assert.equal(scheduler.queue.length, 0);
});

test("a failed build without a retry time reports none", async () => {
    const { events, handlers } = recordingHandlers();
    const source = sequence([{ building: true, failed: true }]);
    pollVibeMap(source.load, handlers, OPTIONS);
    await settleMicrotasks();
    assert.deepEqual(events, ["failed:none"]);
});

test("polling gives up as stalled once the building limit is exceeded", async () => {
    const { events, handlers } = recordingHandlers();
    const scheduler = manualScheduler();
    const source = sequence([
        { building: true },
        { building: true },
        { building: true },
    ]);
    pollVibeMap(source.load, handlers, {
        ...OPTIONS,
        schedule: scheduler.schedule,
    });
    await settleMicrotasks();
    await scheduler.flush();
    await scheduler.flush();
    assert.deepEqual(events, ["building", "building", "stalled"]);
    assert.equal(scheduler.queue.length, 0);
});

test("a rejected load reports an error and stops", async () => {
    const { events, handlers } = recordingHandlers();
    const scheduler = manualScheduler();
    pollVibeMap(
        async () => {
            throw new Error("boom");
        },
        handlers,
        { ...OPTIONS, schedule: scheduler.schedule },
    );
    await settleMicrotasks();
    assert.deepEqual(events, ["error"]);
    assert.equal(scheduler.queue.length, 0);
});

test("cancel clears the pending timer, aborts the signal, and silences later answers", async () => {
    const { events, handlers } = recordingHandlers();
    const scheduler = manualScheduler();
    const source = sequence([{ building: true }, READY]);
    const handle = pollVibeMap(source.load, handlers, {
        ...OPTIONS,
        schedule: scheduler.schedule,
    });
    await settleMicrotasks();
    assert.deepEqual(events, ["building"]);
    handle.cancel();
    assert.equal(scheduler.clearedCount(), 1);
    assert.equal(source.signals[0]?.aborted, true);
    await scheduler.flush();
    assert.deepEqual(events, ["building"]);
});

test("cancel during an in-flight load drops its answer and its rejection", async () => {
    const { events, handlers } = recordingHandlers();
    let resolveLoad: (value: VibeMapResponse) => void = () => undefined;
    const handle = pollVibeMap(
        () =>
            new Promise<VibeMapResponse>((resolve) => {
                resolveLoad = resolve;
            }),
        handlers,
        OPTIONS,
    );
    handle.cancel();
    resolveLoad(READY);
    await settleMicrotasks();
    assert.deepEqual(events, []);

    const rejected = pollVibeMap(
        (signal) =>
            new Promise<VibeMapResponse>((_resolve, reject) => {
                signal.addEventListener("abort", () =>
                    reject(new Error("aborted")),
                );
            }),
        handlers,
        OPTIONS,
    );
    rejected.cancel();
    await settleMicrotasks();
    assert.deepEqual(events, []);
});
