import assert from "node:assert/strict";
import test from "node:test";
import {
    MAX_CONSECUTIVE_POLL_FAILURES,
    resolveYouTubeDownloadPoll,
    shouldAbandonYouTubeDownloadPolling,
} from "../../lib/youtube-download-poll.ts";

test("queued job keeps polling with zero progress", () => {
    const result = resolveYouTubeDownloadPoll({ status: "queued" });
    assert.equal(result.done, false);
    assert.equal(result.toast, null);
    assert.equal(result.progressPct, 0);
});

test("downloading job reports clamped progress and keeps polling", () => {
    const result = resolveYouTubeDownloadPoll({
        status: "downloading",
        progressPct: 42.5,
    });
    assert.equal(result.done, false);
    assert.equal(result.toast, null);
    assert.equal(result.progressPct, 42.5);

    const over = resolveYouTubeDownloadPoll({
        status: "downloading",
        progressPct: 120,
    });
    assert.equal(over.progressPct, 100);

    const under = resolveYouTubeDownloadPoll({
        status: "downloading",
        progressPct: -3,
    });
    assert.equal(under.progressPct, 0);
});

test("processing job keeps polling while postprocessing runs", () => {
    const result = resolveYouTubeDownloadPoll({
        status: "processing",
        progressPct: 99,
    });
    assert.equal(result.done, false);
    assert.equal(result.toast, null);
    assert.equal(result.progressPct, 99);
});

test("completed job stops polling with a success toast", () => {
    const result = resolveYouTubeDownloadPoll({
        status: "completed",
        progressPct: 100,
    });
    assert.equal(result.done, true);
    assert.equal(result.toast, "success");
    assert.equal(result.progressPct, 100);
});

test("failed job stops polling with an error toast", () => {
    const result = resolveYouTubeDownloadPoll({
        status: "failed",
        progressPct: 12,
    });
    assert.equal(result.done, true);
    assert.equal(result.toast, "error");
    assert.equal(result.progressPct, null);
});

test("unknown status keeps polling without progress", () => {
    const result = resolveYouTubeDownloadPoll({
        status: "mystery" as never,
    });
    assert.equal(result.done, false);
    assert.equal(result.toast, null);
    assert.equal(result.progressPct, null);
});

test("isolated poll failures are tolerated as still in progress", () => {
    assert.equal(shouldAbandonYouTubeDownloadPolling(1), false);
    assert.equal(
        shouldAbandonYouTubeDownloadPolling(
            MAX_CONSECUTIVE_POLL_FAILURES - 1
        ),
        false
    );
});

test("polling is abandoned only after the consecutive-failure budget", () => {
    assert.equal(
        shouldAbandonYouTubeDownloadPolling(MAX_CONSECUTIVE_POLL_FAILURES),
        true
    );
    assert.equal(
        shouldAbandonYouTubeDownloadPolling(
            MAX_CONSECUTIVE_POLL_FAILURES + 1
        ),
        true
    );
});

test("the failure budget tolerates more than a single transient error", () => {
    assert.equal(MAX_CONSECUTIVE_POLL_FAILURES >= 3, true);
    assert.equal(shouldAbandonYouTubeDownloadPolling(0), false);
});
