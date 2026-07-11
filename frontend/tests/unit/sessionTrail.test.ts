import assert from "node:assert/strict";
import test from "node:test";
import {
    appendTrailEntry,
    readStoredTrail,
    writeStoredTrail,
    TRAIL_CAP,
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
