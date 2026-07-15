import assert from "node:assert/strict";
import test from "node:test";
import {
    appendTrailEntry,
    fadeAlphaForAge,
    readStoredString,
    readStoredTrail,
    readStoredTrailMode,
    sessionStorageSafe,
    writeStoredString,
    writeStoredTrail,
    writeStoredTrailMode,
    TRAIL_CAP,
    TRAIL_FADE_FULL_MS,
    TRAIL_FADE_ZERO_MS,
    TRAIL_MODE_STORAGE_KEY,
    TRAIL_STORAGE_KEY,
    type StorageLike,
    type TrailEntry,
} from "../../components/vibe/useSessionTrail";

/** In-memory storage stub. */
function makeStorage(initial: Record<string, string> = {}): StorageLike & {
    data: Record<string, string>;
} {
    const data = { ...initial };
    return {
        data,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => {
            data[k] = v;
        },
    };
}

test("appendTrailEntry appends when the track id changes", () => {
    let trail: TrailEntry[] = [];
    trail = appendTrailEntry(trail, "a", 1);
    trail = appendTrailEntry(trail, "b", 2);
    trail = appendTrailEntry(trail, "c", 3);
    assert.deepEqual(
        trail.map((e) => e.trackId),
        ["a", "b", "c"]
    );
});

test("appendTrailEntry does not duplicate the most recent id", () => {
    let trail: TrailEntry[] = [{ trackId: "a", at: 1 }];
    const same = appendTrailEntry(trail, "a", 2);
    assert.equal(same, trail, "same-id append returns the same reference");
    assert.equal(same.length, 1);

    // A repeat that is not adjacent is still appended.
    trail = appendTrailEntry(trail, "b", 3);
    trail = appendTrailEntry(trail, "a", 4);
    assert.deepEqual(
        trail.map((e) => e.trackId),
        ["a", "b", "a"]
    );
});

test("appendTrailEntry caps the trail length, dropping oldest", () => {
    let trail: TrailEntry[] = [];
    for (let i = 0; i < TRAIL_CAP + 20; i++) {
        trail = appendTrailEntry(trail, `t${i}`, i);
    }
    assert.equal(trail.length, TRAIL_CAP);
    // Oldest survivor is t20, newest is the last appended.
    assert.equal(trail[0].trackId, `t20`);
    assert.equal(trail[trail.length - 1].trackId, `t${TRAIL_CAP + 20 - 1}`);
});

test("readStoredTrail returns [] for null storage (SSR) or missing key", () => {
    assert.deepEqual(readStoredTrail(null), []);
    assert.deepEqual(readStoredTrail(makeStorage()), []);
});

test("readStoredTrail rejects malformed / non-array / bad-shape payloads", () => {
    assert.deepEqual(readStoredTrail(makeStorage({ [TRAIL_STORAGE_KEY]: "{not json" })), []);
    assert.deepEqual(readStoredTrail(makeStorage({ [TRAIL_STORAGE_KEY]: '{"a":1}' })), []);
    // Array with bad entries is filtered down to valid ones.
    const mixed = makeStorage({
        [TRAIL_STORAGE_KEY]: JSON.stringify([
            { trackId: "a", at: 1 },
            { trackId: 5, at: 2 },
            { nope: true },
            { trackId: "b", at: 3 },
        ]),
    });
    assert.deepEqual(
        readStoredTrail(mixed).map((e) => e.trackId),
        ["a", "b"]
    );
});

test("writeStoredTrail then readStoredTrail round-trips", () => {
    const storage = makeStorage();
    const trail: TrailEntry[] = [
        { trackId: "a", at: 1 },
        { trackId: "b", at: 2 },
    ];
    writeStoredTrail(storage, trail);
    assert.deepEqual(readStoredTrail(storage), trail);
});

test("writeStoredTrail is a no-op for null storage (SSR safe)", () => {
    // Must not throw.
    writeStoredTrail(null, [{ trackId: "a", at: 1 }]);
});

// --- clear() semantics (writeStoredTrail(storage, []) is the pure core of
// useSessionTrail's clear — the hook itself is a React effect layer over
// this, plus resetting the internal lastId ref so the currently-playing
// track is only re-appended on its NEXT change). --------------------------

test("writeStoredTrail([]) clears a previously-stored trail", () => {
    const storage = makeStorage();
    writeStoredTrail(storage, [
        { trackId: "a", at: 1 },
        { trackId: "b", at: 2 },
    ]);
    assert.equal(readStoredTrail(storage).length, 2);

    writeStoredTrail(storage, []);
    assert.deepEqual(readStoredTrail(storage), []);
});

// --- sessionStorageSafe / readStoredString / writeStoredString ------------
// The shared guard every vibe-map sessionStorage read/write (this trail, the
// layout-mode toggle, hint dismissal, the trail-mode toggle) routes through.

test("sessionStorageSafe returns null outside a browser (this test runs under plain node)", () => {
    assert.equal(sessionStorageSafe(), null);
});

test("readStoredString returns null for null storage or a missing key", () => {
    assert.equal(readStoredString(null, "any-key"), null);
    assert.equal(readStoredString(makeStorage(), "missing-key"), null);
});

test("writeStoredString then readStoredString round-trips", () => {
    const storage = makeStorage();
    writeStoredString(storage, "k", "v");
    assert.equal(readStoredString(storage, "k"), "v");
});

test("writeStoredString is a no-op for null storage (SSR safe)", () => {
    // Must not throw.
    writeStoredString(null, "k", "v");
});

test("readStoredString/writeStoredString swallow a throwing storage (quota / private mode)", () => {
    const throwing: StorageLike = {
        getItem: () => {
            throw new Error("boom");
        },
        setItem: () => {
            throw new Error("boom");
        },
    };
    assert.equal(readStoredString(throwing, "k"), null);
    // Must not throw.
    writeStoredString(throwing, "k", "v");
});

// --- Trail display mode (on / fade / off) ----------------------------------

test("readStoredTrailMode defaults to 'on' for null storage, a missing key, or garbage", () => {
    assert.equal(readStoredTrailMode(null), "on");
    assert.equal(readStoredTrailMode(makeStorage()), "on");
    assert.equal(
        readStoredTrailMode(makeStorage({ [TRAIL_MODE_STORAGE_KEY]: "bogus" })),
        "on"
    );
});

test("writeStoredTrailMode then readStoredTrailMode round-trips each valid mode", () => {
    const storage = makeStorage();
    for (const mode of ["on", "fade", "off"] as const) {
        writeStoredTrailMode(storage, mode);
        assert.equal(readStoredTrailMode(storage), mode);
    }
});

// --- fadeAlphaForAge (the "fade" mode age -> opacity curve) ----------------

test("fadeAlphaForAge is 1 for any age at/under the full-opacity window", () => {
    assert.equal(fadeAlphaForAge(0), 1);
    assert.equal(fadeAlphaForAge(TRAIL_FADE_FULL_MS), 1);
    assert.equal(fadeAlphaForAge(TRAIL_FADE_FULL_MS - 1), 1);
});

test("fadeAlphaForAge is 0 for any age at/beyond the zero-opacity cutoff", () => {
    assert.equal(fadeAlphaForAge(TRAIL_FADE_ZERO_MS), 0);
    assert.equal(fadeAlphaForAge(TRAIL_FADE_ZERO_MS + 1), 0);
    assert.equal(fadeAlphaForAge(TRAIL_FADE_ZERO_MS * 10), 0);
});

test("fadeAlphaForAge interpolates linearly between the two windows", () => {
    const mid = (TRAIL_FADE_FULL_MS + TRAIL_FADE_ZERO_MS) / 2;
    assert.ok(Math.abs(fadeAlphaForAge(mid) - 0.5) < 1e-9);

    const quarter =
        TRAIL_FADE_FULL_MS + (TRAIL_FADE_ZERO_MS - TRAIL_FADE_FULL_MS) * 0.25;
    assert.ok(Math.abs(fadeAlphaForAge(quarter) - 0.75) < 1e-9);
});

test("fadeAlphaForAge treats a negative (clock-skewed) age as fully opaque", () => {
    assert.equal(fadeAlphaForAge(-100), 1);
});
