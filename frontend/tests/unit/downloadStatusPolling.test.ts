import assert from "node:assert/strict";
import { test } from "node:test";
import {
    resolveDownloadErrorBackoffMs,
    resolveDownloadPollDelayMs,
} from "../../hooks/downloadStatusPolling";

test("download polling cadence follows active, existing, and empty boundaries", () => {
    assert.equal(resolveDownloadPollDelayMs(1, 1), 5_000);
    assert.equal(resolveDownloadPollDelayMs(2, 0), 5_000);
    assert.equal(resolveDownloadPollDelayMs(0, 1), 10_000);
    assert.equal(resolveDownloadPollDelayMs(0, 0), 30_000);
});

test("download error backoff grows exponentially and caps at 120 seconds", () => {
    assert.equal(resolveDownloadErrorBackoffMs(15_000, 0), 15_000);
    assert.equal(resolveDownloadErrorBackoffMs(15_000, 1), 30_000);
    assert.equal(resolveDownloadErrorBackoffMs(15_000, 2), 60_000);
    assert.equal(resolveDownloadErrorBackoffMs(15_000, 3), 120_000);
    assert.equal(resolveDownloadErrorBackoffMs(15_000, 10), 120_000);
});
