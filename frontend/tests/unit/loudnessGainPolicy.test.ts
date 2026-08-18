import assert from "node:assert/strict";
import test from "node:test";
import {
    isAlbumOrderedQueue,
    resolveLoudnessGain,
    type LoudnessGainInput,
} from "../../lib/audio-engine/loudnessGainPolicy";

const TARGET = -18;

function input(overrides: Partial<LoudnessGainInput>): LoudnessGainInput {
    return {
        mode: "auto",
        targetLufs: TARGET,
        isAlbumContext: false,
        track: null,
        ...overrides,
    };
}

test("mode off passes audio through untouched", () => {
    const decision = resolveLoudnessGain(
        input({
            mode: "off",
            track: { loudnessLufs: -5, truePeakDb: 0 },
        }),
    );
    assert.equal(decision.gainDb, 0);
    assert.equal(decision.gainFactor, 1);
    assert.equal(decision.reason, "mode_off");
});

test("missing track passes through", () => {
    const decision = resolveLoudnessGain(input({ track: null }));
    assert.equal(decision.reason, "no_track");
    assert.equal(decision.gainFactor, 1);
});

test("non-finite target passes through", () => {
    const decision = resolveLoudnessGain(
        input({ targetLufs: Number.NaN, track: { loudnessLufs: -5 } }),
    );
    assert.equal(decision.reason, "invalid_target");
    assert.equal(decision.gainFactor, 1);
});

test("unmeasured track passes through with no mid-queue jump handling", () => {
    const decision = resolveLoudnessGain(
        input({ track: { loudnessLufs: null, truePeakDb: null } }),
    );
    assert.equal(decision.reason, "unmeasured");
    assert.equal(decision.gainDb, 0);
});

test("loud track is attenuated by the full difference", () => {
    const decision = resolveLoudnessGain(
        input({ track: { loudnessLufs: -9.5, truePeakDb: 1.0 } }),
    );
    assert.equal(decision.reason, "leveled");
    assert.ok(Math.abs(decision.gainDb - -8.5) < 1e-9);
    assert.ok(Math.abs(decision.gainFactor - 10 ** (-8.5 / 20)) < 1e-9);
});

test("quiet track boost is capped at +3 dB", () => {
    const decision = resolveLoudnessGain(
        input({ track: { loudnessLufs: -30, truePeakDb: -12 } }),
    );
    assert.equal(decision.reason, "boost_clamped");
    assert.equal(decision.gainDb, 3);
});

test("boost never exceeds true-peak headroom", () => {
    const decision = resolveLoudnessGain(
        input({ track: { loudnessLufs: -24, truePeakDb: -1.5 } }),
    );
    assert.equal(decision.reason, "boost_clamped");
    assert.ok(Math.abs(decision.gainDb - 1.5) < 1e-9);
});

test("small boost inside headroom applies fully", () => {
    const decision = resolveLoudnessGain(
        input({ track: { loudnessLufs: -20, truePeakDb: -6 } }),
    );
    assert.equal(decision.reason, "leveled");
    assert.ok(Math.abs(decision.gainDb - 2) < 1e-9);
});

test("boost is denied without a peak measurement", () => {
    const decision = resolveLoudnessGain(
        input({ track: { loudnessLufs: -30, truePeakDb: null } }),
    );
    assert.equal(decision.reason, "boost_denied_no_peak");
    assert.equal(decision.gainDb, 0);
});

test("positive-peak track gets no boost headroom", () => {
    const decision = resolveLoudnessGain(
        input({ track: { loudnessLufs: -25, truePeakDb: 0.8 } }),
    );
    assert.equal(decision.reason, "boost_clamped");
    assert.equal(decision.gainDb, 0);
});

test("auto mode uses album gain inside album context", () => {
    const decision = resolveLoudnessGain(
        input({
            isAlbumContext: true,
            track: {
                loudnessLufs: -8,
                truePeakDb: 0,
                albumLoudnessLufs: -12,
                albumTruePeakDb: 0.5,
            },
        }),
    );
    assert.equal(decision.reason, "leveled");
    assert.ok(Math.abs(decision.gainDb - -6) < 1e-9);
});

test("auto mode uses track gain outside album context", () => {
    const decision = resolveLoudnessGain(
        input({
            isAlbumContext: false,
            track: {
                loudnessLufs: -8,
                truePeakDb: 0,
                albumLoudnessLufs: -12,
                albumTruePeakDb: 0.5,
            },
        }),
    );
    assert.ok(Math.abs(decision.gainDb - -10) < 1e-9);
});

test("album mode falls back to track values while rollups converge", () => {
    const decision = resolveLoudnessGain(
        input({
            mode: "album",
            track: { loudnessLufs: -14, truePeakDb: -0.2 },
        }),
    );
    assert.equal(decision.reason, "leveled");
    assert.ok(Math.abs(decision.gainDb - -4) < 1e-9);
});

test("album boost without album peak falls back to the track peak", () => {
    const decision = resolveLoudnessGain(
        input({
            mode: "album",
            track: {
                loudnessLufs: -21,
                truePeakDb: -2,
                albumLoudnessLufs: -22,
                albumTruePeakDb: null,
            },
        }),
    );
    assert.equal(decision.reason, "boost_clamped");
    assert.ok(Math.abs(decision.gainDb - 2) < 1e-9);
});

test("track mode ignores album measurements entirely", () => {
    const decision = resolveLoudnessGain(
        input({
            mode: "track",
            isAlbumContext: true,
            track: {
                loudnessLufs: -8,
                truePeakDb: 0,
                albumLoudnessLufs: -12,
            },
        }),
    );
    assert.ok(Math.abs(decision.gainDb - -10) < 1e-9);
});

function queueOf(...albumIds: (string | undefined)[]) {
    return albumIds.map((id) => ({ album: { id } }));
}

test("single-album unshuffled queue is an album context", () => {
    assert.equal(isAlbumOrderedQueue(queueOf("a1", "a1", "a1"), false), true);
});

test("shuffle is never an album context", () => {
    assert.equal(isAlbumOrderedQueue(queueOf("a1", "a1"), true), false);
});

test("mixed-album queue is not an album context", () => {
    assert.equal(isAlbumOrderedQueue(queueOf("a1", "a2", "a1"), false), false);
});

test("queues without album ids are not album contexts", () => {
    assert.equal(
        isAlbumOrderedQueue(queueOf(undefined, undefined), false),
        false,
    );
});

test("empty queue is not an album context", () => {
    assert.equal(isAlbumOrderedQueue([], false), false);
});

test("oversized queues are never treated as albums", () => {
    const oversized = Array.from({ length: 501 }, () => ({
        album: { id: "a1" },
    }));
    assert.equal(isAlbumOrderedQueue(oversized, false), false);
});

test("album measurements nested under the album object are honored", () => {
    const decision = resolveLoudnessGain(
        input({
            isAlbumContext: true,
            track: {
                loudnessLufs: -8,
                truePeakDb: 0,
                album: { albumLoudnessLufs: -12, albumTruePeakDb: 0.5 },
            },
        }),
    );
    assert.equal(decision.reason, "leveled");
    assert.ok(Math.abs(decision.gainDb - -6) < 1e-9);
});

test("flattened album measurements win over nested ones", () => {
    const decision = resolveLoudnessGain(
        input({
            isAlbumContext: true,
            track: {
                loudnessLufs: -8,
                albumLoudnessLufs: -10,
                album: { albumLoudnessLufs: -20 },
            },
        }),
    );
    assert.ok(Math.abs(decision.gainDb - -8) < 1e-9);
});
