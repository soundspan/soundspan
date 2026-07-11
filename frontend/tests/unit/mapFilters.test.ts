import assert from "node:assert/strict";
import test from "node:test";
import {
    computeVisibilityMask,
    countVisible,
    type FilterableTrack,
    type MapFilterState,
} from "../../components/vibe/useMapFilters";

const tracks: FilterableTrack[] = [
    { dominantMood: "moodHappy", energy: 0.9, valence: 0.8 }, // 0
    { dominantMood: "moodSad", energy: 0.2, valence: 0.1 }, // 1
    { dominantMood: "moodHappy", energy: null, valence: null }, // 2
    { dominantMood: "moodParty", energy: 0.5, valence: 0.5 }, // 3
    { dominantMood: "moodSad", energy: 0.95, valence: null }, // 4
];

function filters(overrides: Partial<MapFilterState> = {}): MapFilterState {
    return {
        activeMoods: new Set(),
        energyRange: [0, 1],
        valenceRange: [0, 1],
        ...overrides,
    };
}

test("empty activeMoods = all moods pass", () => {
    const mask = computeVisibilityMask(tracks, filters());
    assert.deepEqual(Array.from(mask), [1, 1, 1, 1, 1]);
    assert.equal(countVisible(mask), 5);
});

test("mood toggle keeps only the selected moods", () => {
    const mask = computeVisibilityMask(
        tracks,
        filters({ activeMoods: new Set(["moodHappy"]) })
    );
    assert.deepEqual(Array.from(mask), [1, 0, 1, 0, 0]);
    assert.equal(countVisible(mask), 2);
});

test("multiple active moods union", () => {
    const mask = computeVisibilityMask(
        tracks,
        filters({ activeMoods: new Set(["moodHappy", "moodParty"]) })
    );
    assert.deepEqual(Array.from(mask), [1, 0, 1, 1, 0]);
});

test("energy range excludes out-of-range non-null features", () => {
    const mask = computeVisibilityMask(
        tracks,
        filters({ energyRange: [0.4, 0.6] })
    );
    // track0 energy .9 out, track1 .2 out, track2 null passes, track3 .5 in, track4 .95 out
    assert.deepEqual(Array.from(mask), [0, 0, 1, 1, 0]);
});

test("valence range with null valence still passing", () => {
    const mask = computeVisibilityMask(
        tracks,
        filters({ valenceRange: [0.6, 1] })
    );
    // track0 .8 in, track1 .1 out, track2 null passes, track3 .5 out, track4 null passes
    assert.deepEqual(Array.from(mask), [1, 0, 1, 0, 1]);
});

test("null energy and valence always pass range filters", () => {
    // Narrow both ranges to an empty-ish window; only the all-null track survives ranges.
    const mask = computeVisibilityMask(
        [{ dominantMood: "moodHappy", energy: null, valence: null }],
        filters({ energyRange: [0.99, 1], valenceRange: [0.99, 1] })
    );
    assert.deepEqual(Array.from(mask), [1]);
});

test("mood + range filters compose (AND)", () => {
    const mask = computeVisibilityMask(
        tracks,
        filters({
            activeMoods: new Set(["moodSad"]),
            energyRange: [0.9, 1],
        })
    );
    // Only sad tracks with energy in [.9,1] (or null energy): track1 sad .2 out, track4 sad .95 in
    assert.deepEqual(Array.from(mask), [0, 0, 0, 0, 1]);
});

test("mask length matches track count and countVisible sums it", () => {
    const mask = computeVisibilityMask(tracks, filters());
    assert.equal(mask.length, tracks.length);
    assert.equal(countVisible(mask), 5);
    assert.equal(countVisible(new Uint8Array([1, 0, 1, 0, 0])), 2);
});
