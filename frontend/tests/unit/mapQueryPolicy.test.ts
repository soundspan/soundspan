import assert from "node:assert/strict";
import test from "node:test";
import {
    BUILDING_POLL_LIMIT,
    BUILDING_POLL_MS,
    isPollExhausted,
    mergeMapAnswer,
    nextPollDelayMs,
    type VibeMapPayload,
    type VibeMapQueryData,
} from "../../components/vibe/mapQueryPolicy";

const READY: VibeMapPayload = {
    tracks: [],
    trackCount: 0,
    computedAt: "2026-09-17T00:00:00.000Z",
};

const CACHED_READY: VibeMapQueryData = {
    payload: READY,
    phase: "ready",
    buildingPolls: 0,
    retryAt: null,
};

test("a ready answer replaces the payload and resets the poll count", () => {
    const merged = mergeMapAnswer(
        { ...CACHED_READY, phase: "building", buildingPolls: 7 },
        { ...READY, computedAt: "2026-09-18T00:00:00.000Z" },
    );
    assert.equal(merged.phase, "ready");
    assert.equal(merged.payload?.computedAt, "2026-09-18T00:00:00.000Z");
    assert.equal(merged.buildingPolls, 0);
    assert.equal(merged.retryAt, null);
});

test("a building answer keeps the previous payload and counts the poll", () => {
    const first = mergeMapAnswer(CACHED_READY, { building: true });
    assert.equal(first.phase, "building");
    assert.equal(first.payload, READY);
    assert.equal(first.buildingPolls, 1);

    const second = mergeMapAnswer(first, { building: true });
    assert.equal(second.buildingPolls, 2);
    assert.equal(second.payload, READY);
});

test("a building answer with nothing cached has no payload", () => {
    const merged = mergeMapAnswer(undefined, { building: true });
    assert.equal(merged.payload, null);
    assert.equal(merged.buildingPolls, 1);
});

test("a failed answer keeps the payload, stops counting, and records the retry time", () => {
    const merged = mergeMapAnswer(
        { ...CACHED_READY, phase: "building", buildingPolls: 3 },
        { building: true, failed: true, retryAt: "2026-09-17T01:00:00.000Z" },
    );
    assert.equal(merged.phase, "failed");
    assert.equal(merged.payload, READY);
    assert.equal(merged.buildingPolls, 3);
    assert.equal(merged.retryAt, "2026-09-17T01:00:00.000Z");
    assert.equal(
        mergeMapAnswer(undefined, { building: true, failed: true }).retryAt,
        null,
    );
});

test("polling continues only while a build runs and the limit is not exceeded", () => {
    assert.equal(nextPollDelayMs(undefined), false);
    assert.equal(nextPollDelayMs(CACHED_READY), false);
    assert.equal(nextPollDelayMs({ ...CACHED_READY, phase: "failed" }), false);
    assert.equal(
        nextPollDelayMs({
            ...CACHED_READY,
            phase: "building",
            buildingPolls: BUILDING_POLL_LIMIT,
        }),
        BUILDING_POLL_MS,
    );
    assert.equal(
        nextPollDelayMs({
            ...CACHED_READY,
            phase: "building",
            buildingPolls: BUILDING_POLL_LIMIT + 1,
        }),
        false,
    );
});

test("exhaustion is only reported for an over-limit build", () => {
    assert.equal(isPollExhausted(undefined), false);
    assert.equal(isPollExhausted(CACHED_READY), false);
    assert.equal(
        isPollExhausted({
            ...CACHED_READY,
            phase: "building",
            buildingPolls: BUILDING_POLL_LIMIT,
        }),
        false,
    );
    assert.equal(
        isPollExhausted({
            ...CACHED_READY,
            phase: "building",
            buildingPolls: BUILDING_POLL_LIMIT + 1,
        }),
        true,
    );
});
