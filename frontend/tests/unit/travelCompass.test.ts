import assert from "node:assert/strict";
import test from "node:test";
import {
    compassNeighbors,
    enrichFromMap,
    matchesDirection,
    VALENCE_DELTA_THRESHOLD,
    ENERGY_DELTA_THRESHOLD,
    DEFAULT_COMPASS_COUNT,
    type CompassCandidate,
    type CompassOrigin,
} from "../../components/vibe/travelCompass";
import type { MapTrack } from "../../components/vibe/types";

function candidate(
    id: string,
    similarity: number,
    energy: number | null,
    valence: number | null,
    moods?: Record<string, number> | null
): CompassCandidate {
    return {
        id,
        title: id,
        album: { id: `al-${id}`, title: "", coverUrl: null },
        artist: { id: `ar-${id}`, name: `Artist ${id}` },
        similarity,
        // Mirrors the backend's Math.max(0, 1 - distance/2) so fixtures built
        // from a target similarity stay internally consistent.
        distance: Math.max(0, 2 * (1 - similarity)),
        energy,
        valence,
        moods: moods ?? null,
    };
}

function mapTrack(id: string, overrides: Partial<MapTrack> = {}): MapTrack {
    return {
        id,
        x: 0.5,
        y: 0.5,
        title: id,
        artist: `Artist ${id}`,
        artistId: `ar-${id}`,
        albumId: `al-${id}`,
        coverUrl: null,
        dominantMood: "moodHappy",
        moodScore: 0.5,
        energy: 0.5,
        valence: 0.5,
        ...overrides,
    };
}

const origin: CompassOrigin = {
    energy: 0.5,
    valence: 0.5,
    moods: { moodHappy: 0.4 },
};

test("thresholds are the documented deltas", () => {
    assert.equal(VALENCE_DELTA_THRESHOLD, 0.03);
    assert.equal(ENERGY_DELTA_THRESHOLD, 0.03);
    assert.equal(DEFAULT_COMPASS_COUNT, 8);
});

test("valence-present direction filtering (happier / sadder)", () => {
    const happier = candidate("h", 0.9, 0.5, 0.6); // +0.1 valence
    const barely = candidate("b", 0.8, 0.5, 0.51); // +0.01, under threshold
    const sadder = candidate("s", 0.7, 0.5, 0.3); // -0.2 valence

    assert.equal(matchesDirection(origin, happier, "happier"), true);
    assert.equal(matchesDirection(origin, barely, "happier"), false);
    assert.equal(matchesDirection(origin, sadder, "happier"), false);

    assert.equal(matchesDirection(origin, sadder, "sadder"), true);
    assert.equal(matchesDirection(origin, happier, "sadder"), false);
});

test("energy-present direction filtering (calmer / more-energetic)", () => {
    const calmer = candidate("c", 0.6, 0.2, 0.5); // -0.3 energy
    const flat = candidate("f", 0.6, 0.5, 0.5); // 0 energy delta
    const hot = candidate("e", 0.6, 0.9, 0.5); // +0.4 energy

    assert.equal(matchesDirection(origin, calmer, "calmer"), true);
    assert.equal(matchesDirection(origin, flat, "calmer"), false);
    assert.equal(matchesDirection(origin, hot, "more-energetic"), true);
    assert.equal(matchesDirection(origin, calmer, "more-energetic"), false);
});

test("null valence falls back to moodHappy delta", () => {
    const happyByMood = candidate("hm", 0.9, 0.5, null, { moodHappy: 0.7 }); // +0.3
    const sadByMood = candidate("sm", 0.9, 0.5, null, { moodHappy: 0.2 }); // -0.2
    const noSignal = candidate("ns", 0.9, 0.5, null, null); // no valence, no moods

    assert.equal(matchesDirection(origin, happyByMood, "happier"), true);
    assert.equal(matchesDirection(origin, happyByMood, "sadder"), false);
    assert.equal(matchesDirection(origin, sadByMood, "sadder"), true);
    assert.equal(matchesDirection(origin, sadByMood, "happier"), false);
    // Nothing to compare on → excluded from both directional filters.
    assert.equal(matchesDirection(origin, noSignal, "happier"), false);
    assert.equal(matchesDirection(origin, noSignal, "sadder"), false);
});

test("null energy is excluded from calmer / more-energetic (no mood fallback)", () => {
    const nullEnergy = candidate("ne", 0.9, null, 0.5);
    assert.equal(matchesDirection(origin, nullEnergy, "calmer"), false);
    assert.equal(matchesDirection(origin, nullEnergy, "more-energetic"), false);
});

test("'any' keeps everything", () => {
    const c = candidate("x", 0.1, null, null, null);
    assert.equal(matchesDirection(origin, c, "any"), true);
});

test("compassNeighbors ranks by similarity desc within a direction", () => {
    const cands = [
        candidate("low", 0.4, 0.5, 0.7), // happier
        candidate("high", 0.95, 0.5, 0.8), // happier
        candidate("mid", 0.6, 0.5, 0.66), // happier
        candidate("sad", 0.99, 0.5, 0.2), // sadder — filtered out
    ];
    const out = compassNeighbors(origin, cands, "happier");
    assert.deepEqual(
        out.map((c) => c.id),
        ["high", "mid", "low"]
    );
});

test("compassNeighbors caps to top-N", () => {
    const cands = Array.from({ length: 12 }, (_, i) =>
        candidate(`t${i}`, i / 12, 0.5, 0.5)
    );
    const out = compassNeighbors(origin, cands, "any", 3);
    assert.equal(out.length, 3);
    // Highest similarities: t11, t10, t9.
    assert.deepEqual(
        out.map((c) => c.id),
        ["t11", "t10", "t9"]
    );
});

test("compassNeighbors defaults to DEFAULT_COMPASS_COUNT", () => {
    const cands = Array.from({ length: 20 }, (_, i) =>
        candidate(`t${i}`, i, 0.5, 0.5)
    );
    assert.equal(compassNeighbors(origin, cands, "any").length, 8);
});

test("enrichFromMap fills only missing energy/valence/moods for on-map candidates", () => {
    const mapIndex = new Map<string, MapTrack>([
        [
            "onmap",
            mapTrack("onmap", {
                energy: 0.8,
                valence: 0.9,
                moods: { moodHappy: 0.7 },
            }),
        ],
    ]);

    const missing = candidate("onmap", 0.5, null, null, null);
    const present = candidate("onmap", 0.5, 0.1, 0.2, { moodHappy: 0.1 });
    const offMap = candidate("offmap", 0.5, null, null, null);

    const [enrichedMissing] = enrichFromMap([missing], mapIndex);
    assert.equal(enrichedMissing.energy, 0.8);
    assert.equal(enrichedMissing.valence, 0.9);
    assert.deepEqual(enrichedMissing.moods, { moodHappy: 0.7 });

    const [enrichedPresent] = enrichFromMap([present], mapIndex);
    assert.equal(enrichedPresent.energy, 0.1, "own value is kept");
    assert.equal(enrichedPresent.valence, 0.2);
    assert.deepEqual(enrichedPresent.moods, { moodHappy: 0.1 });

    const [untouched] = enrichFromMap([offMap], mapIndex);
    assert.equal(untouched.energy, null, "off-map candidate is not enriched");
    assert.equal(untouched, offMap, "off-map candidate returned by reference");
});

test("enrichFromMap recovers deltas so a null-valence candidate can be directional", () => {
    const mapIndex = new Map<string, MapTrack>([
        ["n", mapTrack("n", { valence: 0.9, energy: 0.5 })],
    ]);
    const raw = candidate("n", 0.9, 0.5, null); // valence unknown from /similar
    // Before enrichment the valence delta is unknown → not happier.
    assert.equal(matchesDirection(origin, raw, "happier"), false);
    const [enriched] = enrichFromMap([raw], mapIndex);
    // After enrichment valence 0.9 vs 0.5 → +0.4 → happier.
    assert.equal(matchesDirection(origin, enriched, "happier"), true);
});
