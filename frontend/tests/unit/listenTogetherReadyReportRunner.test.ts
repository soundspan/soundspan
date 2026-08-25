import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ListenTogetherReadyReportRunner,
    LT_READY_REPORT_MAX_WAIT_MS,
    type ReadyReportRunnerPorts,
    type ReadyReportTarget,
} from "../../lib/listenTogetherReadyReportRunner";
import type { ReadyReportSnapshot } from "../../lib/listenTogetherReadyReport";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HarnessOptions {
    snapshot?: Partial<ReadyReportSnapshot>;
    reportReady?: () => Promise<void>;
    startClockAt?: number;
}

function makeHarness(options: HarnessOptions = {}) {
    const listeners: Array<() => void> = [];
    const reports: number[] = [];
    const recoveries: Array<{ reason: string }> = [];
    let clock = options.startClockAt ?? 0;

    const snapshot = (
        target: ReadyReportTarget,
        elapsedMs: number,
    ): ReadyReportSnapshot => ({
        expectedTrackId: target.trackId,
        serverQueuedTrackId: null,
        expectedLocalTrackId: null,
        activeTrackId: "t-1",
        queuedTrackId: null,
        loadedTrackId: "t-1",
        engineDurationSec: 120,
        engineCurrentTimeSec: 0,
        elapsedMs,
        maxWaitMs: LT_READY_REPORT_MAX_WAIT_MS,
        ...options.snapshot,
    });

    const ports: ReadyReportRunnerPorts = {
        engineOn: (listener) => listeners.push(listener),
        engineOff: (listener) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        },
        readSnapshot: snapshot,
        reportReady:
            options.reportReady ??
            (async () => {
                reports.push(Date.now());
            }),
        recover: (reason) => {
            recoveries.push({ reason });
        },
        now: () => clock,
    };

    return {
        runner: new ListenTogetherReadyReportRunner(ports),
        listeners,
        reports,
        recoveries,
        advanceClock: (ms: number) => {
            clock += ms;
        },
    };
}

test("a ready snapshot reports after the settle delay and detaches the listener", async () => {
    const h = makeHarness();
    h.runner.begin({ currentIndex: 0, trackId: "t-1" });
    assert.equal(h.listeners.length, 1, "load listener armed");
    await sleep(200);
    assert.equal(h.reports.length, 1, "reported once");
    assert.equal(h.listeners.length, 0, "listener detached after report");
});

test("an unready snapshot polls without reporting", async () => {
    const h = makeHarness({ snapshot: { loadedTrackId: null } });
    h.runner.begin({ currentIndex: 0, trackId: "t-1" });
    await sleep(250);
    assert.equal(h.reports.length, 0);
    assert.equal(h.recoveries.length, 0);
    h.runner.clearTimer();
    h.runner.detachLoadListener();
});

test("the engine load event is the fast path to reporting", async () => {
    const h = makeHarness({ snapshot: { loadedTrackId: null } });
    h.runner.begin({ currentIndex: 0, trackId: "t-1" });
    h.listeners[0]?.();
    await sleep(20);
    assert.equal(h.reports.length, 1, "load event reported immediately");
    h.runner.clearTimer();
});

test("timeout without a track match recovers exactly once", async () => {
    const h = makeHarness({
        snapshot: {
            activeTrackId: "other",
            loadedTrackId: null,
        },
    });
    h.runner.begin({ currentIndex: 0, trackId: "t-1" });
    h.advanceClock(LT_READY_REPORT_MAX_WAIT_MS + 1);
    await sleep(150);
    assert.equal(h.recoveries.length, 1);
    assert.match(h.recoveries[0].reason, /timed out/);
    assert.equal(h.reports.length, 0);
    assert.equal(h.listeners.length, 0, "listener detached on recovery");
});

test("an obsolete track detaches the listener but a matching one does not", () => {
    const h = makeHarness({ snapshot: { loadedTrackId: null } });
    h.runner.begin({ currentIndex: 2, trackId: "t-2" });
    h.runner.detachLoadListenerIfObsolete(2, "t-2");
    assert.equal(h.listeners.length, 1, "same target keeps the listener");
    h.runner.detachLoadListenerIfObsolete(3, "t-3");
    assert.equal(h.listeners.length, 0, "moved target drops the listener");
    h.runner.clearTimer();
});

test("begin cancels the previous wait before starting a new one", async () => {
    const h = makeHarness({ snapshot: { loadedTrackId: null } });
    h.runner.begin({ currentIndex: 0, trackId: "t-1" });
    h.runner.begin({ currentIndex: 1, trackId: "t-2" });
    assert.equal(h.listeners.length, 1, "only the new wait's listener remains");
    h.runner.clearTimer();
    h.runner.detachLoadListener();
});

test("a failed report retries and eventually succeeds", async () => {
    let failures = 1;
    const reports: number[] = [];
    const h = makeHarness({
        reportReady: async () => {
            if (failures > 0) {
                failures -= 1;
                throw new Error("transient");
            }
            reports.push(1);
        },
    });
    h.runner.begin({ currentIndex: 0, trackId: "t-1" });
    await sleep(600);
    assert.equal(reports.length, 1, "second attempt succeeded");
});
