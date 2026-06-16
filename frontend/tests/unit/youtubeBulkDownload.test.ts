import assert from "node:assert/strict";
import test from "node:test";
import {
    BULK_DOWNLOAD_CONCURRENCY,
    mapLimit,
    summarizeBulkProgress,
    youtubeJobToDownloadItem,
    type BulkItemStatus,
    type YouTubeDownloadJob,
} from "../../lib/youtube-bulk-download.ts";

const NOW_ISO = "2026-06-16T00:00:00.000Z";

function ytJob(overrides: Partial<YouTubeDownloadJob> = {}): YouTubeDownloadJob {
    return {
        jobId: "job-1",
        videoId: "vid00000001",
        status: "downloading",
        progressPct: 42.6,
        filePath: null,
        title: "Some Mix",
        error: null,
        alreadyExisted: false,
        source: "Book Club Radio",
        createdAt: 1_700_000_000,
        ...overrides,
    };
}

test("summarizeBulkProgress on an empty run", () => {
    const out = summarizeBulkProgress([]);
    assert.deepEqual(out, {
        total: 0,
        completed: 0,
        failed: 0,
        active: 0,
        pending: 0,
        pct: 0,
        done: false,
    });
});

test("summarizeBulkProgress counts each status and computes terminal pct", () => {
    const statuses: BulkItemStatus[] = [
        "completed",
        "completed",
        "failed",
        "active",
        "pending",
    ];
    const out = summarizeBulkProgress(statuses);
    assert.equal(out.total, 5);
    assert.equal(out.completed, 2);
    assert.equal(out.failed, 1);
    assert.equal(out.active, 1);
    assert.equal(out.pending, 1);
    // 3 of 5 terminal -> 60%
    assert.equal(out.pct, 60);
    assert.equal(out.done, false);
});

test("summarizeBulkProgress is done only when all items are terminal", () => {
    assert.equal(
        summarizeBulkProgress(["completed", "failed"]).done,
        true
    );
    assert.equal(
        summarizeBulkProgress(["completed", "active"]).done,
        false
    );
});

test("mapLimit runs every item exactly once", async () => {
    const seen: number[] = [];
    await mapLimit([10, 20, 30, 40], 2, async (item) => {
        seen.push(item);
    });
    assert.deepEqual(seen.sort((a, b) => a - b), [10, 20, 30, 40]);
});

test("mapLimit never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 9 }, (_, i) => i);
    await mapLimit(items, 3, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
    });
    assert.ok(maxInFlight <= 3, `max in flight ${maxInFlight} exceeded 3`);
    assert.ok(maxInFlight >= 2, "expected real concurrency");
});

test("mapLimit keeps draining after a worker throws", async () => {
    const completed: number[] = [];
    await mapLimit([1, 2, 3, 4], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        completed.push(item);
    });
    assert.deepEqual(completed.sort((a, b) => a - b), [1, 3, 4]);
});

test("mapLimit handles an empty list", async () => {
    let calls = 0;
    await mapLimit([], 3, async () => {
        calls++;
    });
    assert.equal(calls, 0);
});

test("BULK_DOWNLOAD_CONCURRENCY is a sane positive bound", () => {
    assert.ok(BULK_DOWNLOAD_CONCURRENCY >= 1 && BULK_DOWNLOAD_CONCURRENCY <= 8);
});

test("youtubeJobToDownloadItem maps a job to a tagged list row", () => {
    const item = youtubeJobToDownloadItem(ytJob(), NOW_ISO);
    assert.equal(item.id, "job-1");
    assert.equal(item.subject, "Some Mix");
    assert.equal(item.type, "track");
    assert.equal(item.status, "downloading");
    assert.equal(item.metadata.currentSource, "youtube");
    assert.equal(item.metadata.progressPct, 43); // rounded from 42.6
    assert.equal(item.metadata.statusText, "43% · Book Club Radio");
    assert.equal(item.createdAt, new Date(1_700_000_000 * 1000).toISOString());
});

test("youtubeJobToDownloadItem falls back to videoId and nowIso", () => {
    const item = youtubeJobToDownloadItem(
        ytJob({ title: "", source: null, createdAt: null }),
        NOW_ISO
    );
    assert.equal(item.subject, "vid00000001");
    assert.equal(item.metadata.statusText, "43%");
    assert.equal(item.createdAt, NOW_ISO);
});

test("youtubeJobToDownloadItem clamps progress to 0-100", () => {
    assert.equal(
        youtubeJobToDownloadItem(ytJob({ progressPct: 999 }), NOW_ISO).metadata
            .progressPct,
        100
    );
    assert.equal(
        youtubeJobToDownloadItem(ytJob({ progressPct: -5 }), NOW_ISO).metadata
            .progressPct,
        0
    );
});
