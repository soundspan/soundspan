import assert from "node:assert/strict";
import { test } from "node:test";
import {
    resolveQueueCenteringBehavior,
    resolveQueueCenteringIndex,
} from "../../lib/overlay-queue-centering";

test("an empty queue never centers", () => {
    assert.equal(
        resolveQueueCenteringBehavior({
            isFirstReveal: true,
            indexChanged: false,
            shouldReduceMotion: false,
            queueLength: 0,
        }),
        null,
    );
});

test("the first reveal jumps without animation", () => {
    assert.equal(
        resolveQueueCenteringBehavior({
            isFirstReveal: true,
            indexChanged: false,
            shouldReduceMotion: false,
            queueLength: 12,
        }),
        "auto",
    );
});

test("a track change while visible glides smoothly", () => {
    assert.equal(
        resolveQueueCenteringBehavior({
            isFirstReveal: false,
            indexChanged: true,
            shouldReduceMotion: false,
            queueLength: 12,
        }),
        "smooth",
    );
});

test("reduced motion turns track-change glides into jumps", () => {
    assert.equal(
        resolveQueueCenteringBehavior({
            isFirstReveal: false,
            indexChanged: true,
            shouldReduceMotion: true,
            queueLength: 12,
        }),
        "auto",
    );
});

test("no reveal and no index change leaves the list alone", () => {
    assert.equal(
        resolveQueueCenteringBehavior({
            isFirstReveal: false,
            indexChanged: false,
            shouldReduceMotion: false,
            queueLength: 12,
        }),
        null,
    );
});

test("centering targets the playing row and falls back to the top", () => {
    assert.equal(resolveQueueCenteringIndex(5, 12), 5);
    assert.equal(resolveQueueCenteringIndex(-1, 12), 0);
    assert.equal(resolveQueueCenteringIndex(12, 12), 0);
});
