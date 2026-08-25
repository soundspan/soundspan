import assert from "node:assert/strict";
import { test } from "node:test";
import {
    evaluateReadyReport,
    type ReadyReportSnapshot,
} from "../../lib/listenTogetherReadyReport";

function snapshot(
    overrides: Partial<ReadyReportSnapshot> = {},
): ReadyReportSnapshot {
    return {
        expectedTrackId: "t-1",
        serverQueuedTrackId: null,
        expectedLocalTrackId: null,
        activeTrackId: "t-1",
        queuedTrackId: null,
        loadedTrackId: "t-1",
        engineDurationSec: 180,
        engineCurrentTimeSec: 0,
        elapsedMs: 500,
        maxWaitMs: 7500,
        ...overrides,
    };
}

test("reports when the expected track is loaded with media data", () => {
    const result = evaluateReadyReport(snapshot());
    assert.equal(result.decision, "report");
    assert.equal(result.mediaReady, true);
    assert.equal(result.timedOut, false);
});

test("polls while the expected track has not loaded yet", () => {
    const result = evaluateReadyReport(snapshot({ loadedTrackId: null }));
    assert.equal(result.decision, "poll");
    assert.equal(result.mediaReady, false);
});

test("polls when the engine has no media data for the loaded track", () => {
    const result = evaluateReadyReport(
        snapshot({ engineDurationSec: 0, engineCurrentTimeSec: 0 }),
    );
    assert.equal(result.decision, "poll");
});

test("current playback time counts as media data when duration is missing", () => {
    const result = evaluateReadyReport(
        snapshot({ engineDurationSec: Number.NaN, engineCurrentTimeSec: 12 }),
    );
    assert.equal(result.decision, "report");
});

test("reports on timeout when the local track still matches expectations", () => {
    const result = evaluateReadyReport(
        snapshot({ loadedTrackId: null, elapsedMs: 8000 }),
    );
    assert.equal(result.decision, "report");
    assert.equal(result.timedOut, true);
    assert.equal(result.mediaReady, false);
});

test("recovers on timeout when the local track never matched", () => {
    const result = evaluateReadyReport(
        snapshot({
            activeTrackId: "other",
            queuedTrackId: "other-2",
            elapsedMs: 8000,
        }),
    );
    assert.equal(result.decision, "recover");
    assert.equal(result.hasTrackMatch, false);
});

test("no expected candidates means any local track matches", () => {
    const result = evaluateReadyReport(
        snapshot({
            expectedTrackId: null,
            serverQueuedTrackId: null,
            expectedLocalTrackId: null,
            activeTrackId: "anything",
            loadedTrackId: "anything",
        }),
    );
    assert.equal(result.decision, "report");
    assert.equal(result.hasTrackMatch, true);
});

test("availability remap satisfies the match via the local track id", () => {
    const result = evaluateReadyReport(
        snapshot({
            expectedTrackId: "remote-1",
            expectedLocalTrackId: "local-9",
            activeTrackId: "local-9",
            loadedTrackId: "local-9",
        }),
    );
    assert.equal(result.decision, "report");
});

test("the queued track can satisfy readiness when nothing is active", () => {
    const result = evaluateReadyReport(
        snapshot({
            activeTrackId: null,
            queuedTrackId: "t-1",
            loadedTrackId: "t-1",
        }),
    );
    assert.equal(result.decision, "report");
});
