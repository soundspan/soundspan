import assert from "node:assert/strict";
import test from "node:test";
import { resolveQueueDropIndices } from "../../components/vibe/QueuePanel";

/**
 * QueuePanel's drag-and-drop reuses reorderDnd.ts's pure drop math (same as
 * /queue's Next Up list) but rows are indexed relative to the panel's
 * upcoming-list, not the absolute queue. `resolveQueueDropIndices` is the one
 * place that translation happens — this mirrors exactly what
 * app/queue/page.tsx's buildRowDropProps does inline
 * (`currentIndex + 1 + idx`), just as an exported, unit-testable helper per
 * the vibe map QueuePanel's spec (component tests can't simulate real DOM
 * drag events against renderToStaticMarkup output, so the interaction-level
 * coverage for the index math lives here instead).
 */

test("resolveQueueDropIndices offsets panel-relative indices by currentIndex + 1", () => {
    // currentIndex 4 -> upcoming row 0 is absolute index 5, row 2 is 7.
    // Drop row 0 ("after" row 2, i.e. panel-relative overIdx=2) -> absolute
    // target lands just after row 2: resolveDropTargetIndex(0, 2, "after") = 2.
    assert.deepEqual(resolveQueueDropIndices(4, 0, 2, "after"), {
        from: 5,
        to: 7,
    });
});

test("resolveQueueDropIndices matches /queue's inline translation for a 'before' drop", () => {
    // currentIndex 0 -> upcoming rows are absolute indices 1..N.
    // Drop row 3 before row 1 -> resolveDropTargetIndex(3, 1, "before") = 1.
    assert.deepEqual(resolveQueueDropIndices(0, 3, 1, "before"), {
        from: 4,
        to: 2,
    });
});

test("resolveQueueDropIndices is a no-op translation for onto-self / adjacent drops", () => {
    const selfDrop = resolveQueueDropIndices(2, 1, 1, "before");
    assert.equal(selfDrop.from, selfDrop.to);

    const adjacentBefore = resolveQueueDropIndices(2, 1, 2, "before");
    assert.equal(adjacentBefore.from, adjacentBefore.to);

    const adjacentAfter = resolveQueueDropIndices(2, 2, 1, "after");
    assert.equal(adjacentAfter.from, adjacentAfter.to);
});

test("resolveQueueDropIndices boundaries: drop before the first upcoming row and after the last", () => {
    // currentIndex -1 (nothing has played yet) -> upcoming rows are absolute
    // indices 0..N, i.e. the whole queue.
    assert.deepEqual(resolveQueueDropIndices(-1, 5, 0, "before"), {
        from: 5,
        to: 0,
    });
    assert.deepEqual(resolveQueueDropIndices(-1, 0, 9, "after"), {
        from: 0,
        to: 9,
    });
});
