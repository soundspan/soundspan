import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type {
    DeviceAuthPollOutcome,
    DeviceAuthSession,
    UseDeviceAuthPollingOptions,
    UseDeviceAuthPollingReturn,
} from "../../hooks/useDeviceAuthPolling";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

function deferred<T>() {
    let resolveRef!: (value: T) => void;
    let rejectRef!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolveRef = resolve;
        rejectRef = reject;
    });
    return { promise, resolve: resolveRef, reject: rejectRef };
}

function session(deviceCode: string, expiresAtMs = 10_000): DeviceAuthSession {
    return {
        deviceCode,
        verificationUri: `https://tidal.example/${deviceCode}`,
        userCode: `user-${deviceCode}`,
        pollIntervalMs: 1_000,
        expiresAtMs,
    };
}

async function mountHook(options: UseDeviceAuthPollingOptions) {
    const { useDeviceAuthPolling } = await import("../../hooks/useDeviceAuthPolling");
    const { createRoot } = await import("react-dom/client");
    const latestRef: { current: UseDeviceAuthPollingReturn | null } = { current: null };

    function Probe() {
        latestRef.current = useDeviceAuthPolling(options);
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Probe)));

    return {
        latest: () => {
            assert.ok(latestRef.current, "hook did not render");
            return latestRef.current;
        },
        act: async (fn: () => void | Promise<void>) => {
            await React.act(async () => {
                await fn();
            });
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function advance(
    harness: Awaited<ReturnType<typeof mountHook>>,
    tick: (milliseconds: number) => void,
    milliseconds: number,
) {
    await harness.act(async () => {
        tick(milliseconds);
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("start transitions through loading to polling and reports the session", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    const initiated = deferred<DeviceAuthSession>();
    const started: DeviceAuthSession[] = [];
    const harness = await mountHook({
        initiate: () => initiated.promise,
        poll: async () => ({ status: "pending" }),
        onSessionStarted: (value) => started.push(value),
    });

    let startPromise!: Promise<void>;
    await harness.act(() => {
        startPromise = harness.latest().start();
    });
    assert.equal(harness.latest().phase, "loading");

    const activeSession = session("first");
    await harness.act(async () => {
        initiated.resolve(activeSession);
        await startPromise;
    });
    assert.equal(harness.latest().phase, "polling");
    assert.deepEqual(harness.latest().session, activeSession);
    assert.deepEqual(started, [activeSession]);
    await harness.unmount();
});

test("a successful poll stops all future polling and calls onSuccess", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    const polledCodes: string[] = [];
    let successCalls = 0;
    const harness = await mountHook({
        initiate: async () => session("success"),
        poll: async (deviceCode) => {
            polledCodes.push(deviceCode);
            return { status: "success" };
        },
        onSuccess: () => {
            successCalls += 1;
        },
    });

    await harness.act(() => harness.latest().start());
    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 1_000);
    assert.equal(harness.latest().phase, "success");
    assert.equal(successCalls, 1);
    assert.deepEqual(polledCodes, ["success"]);

    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 20_000);
    assert.deepEqual(polledCodes, ["success"]);
    await harness.unmount();
});

test("a re-entrant start cancels the first polling chain", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    const sessions = [session("first"), session("second")];
    const polledCodes: string[] = [];
    let initiationIndex = 0;
    const harness = await mountHook({
        initiate: async () => sessions[initiationIndex++],
        poll: async (deviceCode) => {
            polledCodes.push(deviceCode);
            return { status: "pending" };
        },
    });

    await harness.act(() => harness.latest().start());
    assert.equal(harness.latest().session?.deviceCode, "first");
    await harness.act(() => harness.latest().start());
    assert.equal(harness.latest().session?.deviceCode, "second");

    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 3_000);
    assert.deepEqual(polledCodes, ["second"]);
    await harness.unmount();
});

test("expiry stops polling and surfaces the configured message", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    let pollCalls = 0;
    const harness = await mountHook({
        initiate: async () => ({ ...session("expiring", 2_000), pollIntervalMs: 5_000 }),
        poll: async () => {
            pollCalls += 1;
            return { status: "pending" };
        },
        expiredMessage: "The code expired",
    });

    await harness.act(() => harness.latest().start());
    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 2_000);
    assert.equal(harness.latest().phase, "error");
    assert.equal(harness.latest().error, "The code expired");
    assert.equal(harness.latest().timeLeftSeconds, null);

    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 10_000);
    assert.equal(pollCalls, 0);
    await harness.unmount();
});

test("unmount cancels polling without post-unmount React errors", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
    let pollCalls = 0;
    const harness = await mountHook({
        initiate: async () => session("unmounted"),
        poll: async () => {
            pollCalls += 1;
            return { status: "pending" };
        },
    });

    await harness.act(() => harness.latest().start());
    await harness.unmount();
    t.mock.timers.tick(10_000);
    await Promise.resolve();
    assert.equal(pollCalls, 0);
    assert.deepEqual(errors, []);
});

test("transient rejection retries, then an error outcome stops polling", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    const outcomes: Array<DeviceAuthPollOutcome | Error> = [
        new Error("temporary"),
        { status: "error", message: "Authorization denied" },
    ];
    let pollCalls = 0;
    const harness = await mountHook({
        initiate: async () => session("retry"),
        poll: async () => {
            pollCalls += 1;
            const outcome = outcomes.shift();
            if (outcome instanceof Error) throw outcome;
            assert.ok(outcome);
            return outcome;
        },
    });

    await harness.act(() => harness.latest().start());
    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 1_000);
    assert.equal(harness.latest().phase, "polling");
    assert.equal(pollCalls, 1);

    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 1_000);
    assert.equal(harness.latest().phase, "error");
    assert.equal(harness.latest().error, "Authorization denied");
    assert.equal(pollCalls, 2);

    await advance(harness, t.mock.timers.tick.bind(t.mock.timers), 10_000);
    assert.equal(pollCalls, 2);
    await harness.unmount();
});
