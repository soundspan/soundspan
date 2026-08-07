import assert from "node:assert/strict";
import test from "node:test";
import {
    FLIGHT_PLAN_LIMIT,
    upcomingOnMapPoints,
} from "../../components/vibe/flightPlan";
import type { QueueItem } from "../../lib/queue-item";

/** Minimal track-shaped queue entry (itemType omitted == track). */
function track(id: string): QueueItem {
    return {
        id,
        title: `Track ${id}`,
        artist: { name: "A" },
        album: { title: "Al" },
        duration: 100,
    };
}

function episode(id: string): QueueItem {
    return {
        itemType: "episode",
        id: `pod:${id}`,
        title: `Ep ${id}`,
        podcastTitle: "Pod",
        podcastId: "pod",
        episodeId: id,
        coverUrl: null,
        duration: 100,
    };
}

/** posOf stub: ids in `onMap` resolve to distinct points, others are off-map. */
function posOfFor(onMap: readonly string[]) {
    const index = new Map(onMap.map((id, i) => [id, { x: i * 0.1, y: i * 0.05 }]));
    return (id: string) => index.get(id) ?? null;
}

test("returns [] for an empty or missing queue", () => {
    assert.deepEqual(upcomingOnMapPoints([], 0, posOfFor(["a"])), []);
    assert.deepEqual(upcomingOnMapPoints(null, 0, posOfFor(["a"])), []);
    assert.deepEqual(upcomingOnMapPoints(undefined, 0, posOfFor(["a"])), []);
});

test("starts at the current track's dot and walks upcoming on-map tracks in order", () => {
    const posOf = posOfFor(["a", "b", "c"]);
    const pts = upcomingOnMapPoints(
        [track("a"), track("b"), track("c")],
        0,
        posOf
    );
    assert.deepEqual(pts, [posOf("a"), posOf("b"), posOf("c")]);
});

test("skips podcast episodes and off-map tracks without breaking the line", () => {
    const posOf = posOfFor(["a", "c"]);
    const pts = upcomingOnMapPoints(
        [track("a"), episode("e1"), track("offmap"), track("c")],
        0,
        posOf
    );
    assert.deepEqual(pts, [posOf("a"), posOf("c")]);
});

test("returns [] when fewer than two points resolve (a plan needs a line)", () => {
    // Only the current track is on the map.
    assert.deepEqual(
        upcomingOnMapPoints([track("a"), track("x")], 0, posOfFor(["a"])),
        []
    );
    // Only one upcoming track is on the map and nothing is current.
    assert.deepEqual(
        upcomingOnMapPoints([track("x"), track("b")], -1, posOfFor(["b"])),
        []
    );
});

test("an off-map current track still yields a plan from the upcoming hops", () => {
    const posOf = posOfFor(["b", "c"]);
    const pts = upcomingOnMapPoints(
        [track("offmap"), track("b"), track("c")],
        0,
        posOf
    );
    assert.deepEqual(pts, [posOf("b"), posOf("c")]);
});

test("caps the upcoming hops at the limit (start point not counted)", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const posOf = posOfFor(ids);
    const pts = upcomingOnMapPoints(ids.map(track), 0, posOf);
    assert.equal(pts.length, 1 + FLIGHT_PLAN_LIMIT);
    const ptsCustom = upcomingOnMapPoints(ids.map(track), 0, posOf, 3);
    assert.equal(ptsCustom.length, 1 + 3);
});

test("a currentIndex of -1 draws the plan over the whole queue", () => {
    const posOf = posOfFor(["a", "b"]);
    const pts = upcomingOnMapPoints([track("a"), track("b")], -1, posOf);
    assert.deepEqual(pts, [posOf("a"), posOf("b")]);
});
