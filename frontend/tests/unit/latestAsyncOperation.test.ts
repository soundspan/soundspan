import assert from "node:assert/strict";
import test from "node:test";
import {
    createLatestAsyncOperationState,
    type LatestAsyncOperationState,
    enqueueLatestAsyncOperation,
} from "../../lib/latest-async-operation.ts";

async function waitForDrain<TArg>(
    state: LatestAsyncOperationState<TArg>,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!state.inFlight && !state.hasQueuedArg) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    throw new Error("latest async operation did not drain");
}

test("keeps only the latest queued arg while in flight", async () => {
    const state = createLatestAsyncOperationState<number>();
    const executed: number[] = [];

    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const runner = async (arg: number) => {
        executed.push(arg);
        if (arg === 1) {
            await firstGate;
        }
    };

    enqueueLatestAsyncOperation(state, 1, runner);
    enqueueLatestAsyncOperation(state, 2, runner);
    enqueueLatestAsyncOperation(state, 3, runner);

    releaseFirst?.();
    await waitForDrain(state);

    assert.deepEqual(executed, [1, 3]);
});

test("calls onError for queued latest operation failures", async () => {
    const state = createLatestAsyncOperationState<number>();
    const executed: number[] = [];
    const failedArgs: number[] = [];

    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const runner = async (arg: number) => {
        executed.push(arg);
        if (arg === 1) {
            await firstGate;
            return;
        }
        throw new Error("forced failure");
    };

    enqueueLatestAsyncOperation(state, 1, runner, {
        onError: (_error, arg) => {
            failedArgs.push(arg);
        },
    });
    enqueueLatestAsyncOperation(state, 2, runner, {
        onError: (_error, arg) => {
            failedArgs.push(arg);
        },
    });

    releaseFirst?.();
    await waitForDrain(state);

    assert.deepEqual(executed, [1, 2]);
    assert.deepEqual(failedArgs, [2]);
});

test("LT host rapid double-next preserves both sequential intents under contention", async () => {
    const state = createLatestAsyncOperationState<"next">();
    const emitted: string[] = [];

    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const runner = async (arg: "next") => {
        emitted.push(arg);
        if (emitted.length === 1) {
            await firstGate;
        }
    };

    enqueueLatestAsyncOperation(state, "next", runner);
    enqueueLatestAsyncOperation(state, "next", runner);

    releaseFirst?.();
    await waitForDrain(state);

    assert.deepEqual(emitted, ["next", "next"]);
});

test("LT host queue collapses intermediate actions to latest pending intent", async () => {
    type HostAction = "next" | "previous" | "set-track:7";
    const state = createLatestAsyncOperationState<HostAction>();
    const emitted: HostAction[] = [];

    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const runner = async (arg: HostAction) => {
        emitted.push(arg);
        if (arg === "next") {
            await firstGate;
        }
    };

    enqueueLatestAsyncOperation(state, "next", runner);
    enqueueLatestAsyncOperation(state, "previous", runner);
    enqueueLatestAsyncOperation(state, "set-track:7", runner);

    releaseFirst?.();
    await waitForDrain(state);

    assert.deepEqual(emitted, ["next", "set-track:7"]);
});

test("restarts the pump when a queued arg appears during inFlight teardown", async () => {
    const state = createLatestAsyncOperationState<number>();
    const executed: number[] = [];
    let inFlightValue = state.inFlight;
    let injectedDuringTeardown = false;

    Object.defineProperty(state, "inFlight", {
        configurable: true,
        enumerable: true,
        get: () => inFlightValue,
        set: (value: boolean) => {
            inFlightValue = value;
            if (!value && !injectedDuringTeardown) {
                injectedDuringTeardown = true;
                state.hasQueuedArg = true;
                state.queuedArg = 99;
            }
        },
    });

    const runner = async (arg: number) => {
        executed.push(arg);
    };

    enqueueLatestAsyncOperation(state, 1, runner);
    await waitForDrain(state);

    assert.deepEqual(executed, [1, 99]);
});
