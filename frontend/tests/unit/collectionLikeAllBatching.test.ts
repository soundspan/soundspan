import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the batch processing logic used in useCollectionLikeAll.
 * We extract and test the batchProcess algorithm independently.
 */

/** Reimplementation of the batchProcess utility for testing. */
async function batchProcess<T>(
    items: T[],
    size: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    for (let i = 0; i < items.length; i += size) {
        await Promise.all(items.slice(i, i + size).map(fn));
    }
}

test("batchProcess processes all items", async () => {
    const processed: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    await batchProcess(items, 3, async (item) => {
        processed.push(item);
    });

    assert.deepStrictEqual(processed.sort((a, b) => a - b), items);
});

test("batchProcess respects batch size concurrency", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await batchProcess(items, 5, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
    });

    assert.equal(maxConcurrent, 5, "max concurrency should equal batch size");
});

test("batchProcess handles empty array", async () => {
    let callCount = 0;
    await batchProcess([], 5, async () => {
        callCount++;
    });
    assert.equal(callCount, 0);
});

test("batchProcess handles items fewer than batch size", async () => {
    const processed: number[] = [];
    await batchProcess([1, 2, 3], 10, async (item) => {
        processed.push(item);
    });
    assert.deepStrictEqual(processed.sort((a, b) => a - b), [1, 2, 3]);
});

test("batchProcess waits for each batch to complete before starting next", async () => {
    const startOrder: number[] = [];
    const endOrder: number[] = [];
    const items = Array.from({ length: 6 }, (_, i) => i);

    await batchProcess(items, 2, async (item) => {
        startOrder.push(item);
        await new Promise((resolve) => setTimeout(resolve, 20));
        endOrder.push(item);
    });

    // Items 0,1 should both start before either of items 2,3 start
    // (since batch size is 2, items 0+1 run concurrently, then 2+3, then 4+5)
    const indexOf2Start = startOrder.indexOf(2);
    const indexOf0End = endOrder.indexOf(0);
    const indexOf1End = endOrder.indexOf(1);

    // Items 2 must not start before items 0 AND 1 finish
    assert.ok(indexOf2Start >= 2, "item 2 should start after batch 1 completes");
    assert.ok(indexOf0End < endOrder.indexOf(2), "item 0 should finish before item 2");
    assert.ok(indexOf1End < endOrder.indexOf(2), "item 1 should finish before item 2");
});

test("batchProcess propagates errors from batch items", async () => {
    const items = [1, 2, 3, 4, 5];

    await assert.rejects(
        () =>
            batchProcess(items, 3, async (item) => {
                if (item === 2) throw new Error("item 2 failed");
            }),
        { message: "item 2 failed" }
    );
});

test("batchProcess with batch size of 1 processes sequentially", async () => {
    const order: number[] = [];
    const items = [1, 2, 3, 4];

    await batchProcess(items, 1, async (item) => {
        order.push(item);
        await new Promise((resolve) => setTimeout(resolve, 5));
    });

    // Should be strictly sequential
    assert.deepStrictEqual(order, [1, 2, 3, 4]);
});

test("collectLikeableTrackIds deduplicates and trims IDs while preserving order", async () => {
    const { collectLikeableTrackIds } = await import("../../hooks/useCollectionLikeAll");

    const ids = collectLikeableTrackIds([
        { id: " track-1 " },
        { id: "track-2" },
        { id: "track-1" },
        { id: "" },
        { id: "   " },
        { id: "track-3" },
        { id: "track-2" },
    ]);

    assert.deepStrictEqual(ids, ["track-1", "track-2", "track-3"]);
});
