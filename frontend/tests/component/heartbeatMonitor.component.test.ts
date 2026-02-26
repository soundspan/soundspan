import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { HeartbeatMonitor } from "../../lib/audio/heartbeat-monitor.ts";

function createHarness(options?: {
    interval?: number;
    staleThreshold?: number;
    timeTolerance?: number;
    bufferTimeout?: number;
}) {
    const state = {
        currentTime: 10,
        playing: true,
    };
    const calls = {
        stall: 0,
        unexpectedStop: 0,
        bufferTimeout: 0,
        recovery: 0,
    };

    const monitor = new HeartbeatMonitor(
        {
            onStall: () => {
                calls.stall += 1;
            },
            onUnexpectedStop: () => {
                calls.unexpectedStop += 1;
            },
            onBufferTimeout: () => {
                calls.bufferTimeout += 1;
            },
            onRecovery: () => {
                calls.recovery += 1;
            },
            getCurrentTime: () => state.currentTime,
            isActuallyPlaying: () => state.playing,
        },
        {
            interval: options?.interval ?? 60_000,
            staleThreshold: options?.staleThreshold ?? 2,
            timeTolerance: options?.timeTolerance ?? 0.1,
            bufferTimeout: options?.bufferTimeout ?? 1_000,
        },
    );

    return { monitor, state, calls };
}

function tick(monitor: HeartbeatMonitor): void {
    (monitor as unknown as { tick: () => void }).tick();
}

afterEach(() => {
    try {
        mock.timers.reset();
    } catch {
        // Ignore when timers were not mocked in a test.
    }
});

test("detects stall after stale threshold and does not emit duplicate stall callbacks", () => {
    const { monitor, calls } = createHarness({ staleThreshold: 2 });

    monitor.start();
    tick(monitor);
    tick(monitor);
    tick(monitor);

    assert.equal(calls.stall, 1);
    assert.equal(monitor.stalled, true);

    monitor.stop();
    assert.equal(monitor.monitoring, false);
});

test("detects unexpected stop when engine reports not playing", () => {
    const { monitor, state, calls } = createHarness({ staleThreshold: 1 });
    state.playing = false;

    monitor.start();
    tick(monitor);

    assert.equal(calls.unexpectedStop, 1);
    assert.equal(calls.stall, 0);

    monitor.stop();
});

test("recovers from stall when time advances in heartbeat tick", () => {
    const { monitor, state, calls } = createHarness({ staleThreshold: 1 });

    monitor.start();
    tick(monitor);
    assert.equal(monitor.stalled, true);

    state.currentTime = 11;
    tick(monitor);

    assert.equal(calls.recovery, 1);
    assert.equal(monitor.stalled, false);

    monitor.stop();
});

test("notifyProgress clears stall and emits recovery", () => {
    const { monitor, calls } = createHarness({ staleThreshold: 1 });

    monitor.start();
    tick(monitor);
    assert.equal(monitor.stalled, true);

    monitor.notifyProgress(12);

    assert.equal(calls.recovery, 1);
    assert.equal(monitor.stalled, false);

    monitor.stop();
});

test("startBufferTimeout and clearBufferTimeout control timeout callback", () => {
    mock.timers.enable();

    const { monitor, calls } = createHarness({ bufferTimeout: 250 });

    monitor.startBufferTimeout();
    mock.timers.tick(249);
    assert.equal(calls.bufferTimeout, 0);

    mock.timers.tick(1);
    assert.equal(calls.bufferTimeout, 1);

    monitor.startBufferTimeout();
    monitor.clearBufferTimeout();
    mock.timers.tick(1_000);
    assert.equal(calls.bufferTimeout, 1);

    monitor.destroy();
});

test("updateConfig applies new stale threshold", () => {
    const { monitor, calls } = createHarness({ staleThreshold: 3 });

    monitor.updateConfig({ staleThreshold: 1 });
    monitor.start();
    tick(monitor);

    assert.equal(calls.stall, 1);

    monitor.stop();
});
