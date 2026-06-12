import {
    hasReliableEnhanced,
    calculateEnhancedValence,
    calculateEnhancedArousal,
    detectOOD,
    octaveAwareBPMDistance,
    buildFeatureVector,
    cosineSimilarity,
    computeTagBonus,
    computeAggregateFeatureVector,
    scoreTracksAgainstSeed,
} from "../radioVibeEngine";

// ---------------------------------------------------------------------------
// hasReliableEnhanced
// ---------------------------------------------------------------------------
describe("hasReliableEnhanced", () => {
    it("returns true for enhanced mode with reliable version prefix", () => {
        expect(
            hasReliableEnhanced("enhanced", "2.1b6-enhanced-v3.0.0")
        ).toBe(true);
    });

    it("returns false for standard mode", () => {
        expect(hasReliableEnhanced("standard", "2.1b6-enhanced-v3.0.0")).toBe(
            false
        );
    });

    it("returns false for null/undefined inputs", () => {
        expect(hasReliableEnhanced(null, null)).toBe(false);
        expect(hasReliableEnhanced(undefined, undefined)).toBe(false);
        expect(hasReliableEnhanced("enhanced", null)).toBe(false);
    });

    it("returns false for non-reliable version", () => {
        expect(hasReliableEnhanced("enhanced", "1.0-old")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// calculateEnhancedValence
// ---------------------------------------------------------------------------
describe("calculateEnhancedValence", () => {
    it("returns value between 0 and 1 for default track", () => {
        const val = calculateEnhancedValence({});
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
    });

    it("returns higher valence for happy major-key tracks", () => {
        const happy = calculateEnhancedValence({
            moodHappy: 0.9,
            moodSad: 0.1,
            moodParty: 0.8,
            keyScale: "major",
            energy: 0.8,
            danceabilityMl: 0.8,
        });
        const sad = calculateEnhancedValence({
            moodHappy: 0.1,
            moodSad: 0.9,
            moodParty: 0.1,
            keyScale: "minor",
            energy: 0.2,
            danceabilityMl: 0.2,
        });
        expect(happy).toBeGreaterThan(sad);
    });

    it("clamps to 0-1 range", () => {
        const extreme = calculateEnhancedValence({
            moodHappy: 1,
            moodSad: 0,
            moodParty: 1,
            keyScale: "major",
            energy: 1,
            danceabilityMl: 1,
        });
        expect(extreme).toBeLessThanOrEqual(1);
        expect(extreme).toBeGreaterThanOrEqual(0);
    });
});

// ---------------------------------------------------------------------------
// calculateEnhancedArousal
// ---------------------------------------------------------------------------
describe("calculateEnhancedArousal", () => {
    it("returns value between 0 and 1 for default track", () => {
        const val = calculateEnhancedArousal({});
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
    });

    it("returns higher arousal for aggressive fast tracks", () => {
        const high = calculateEnhancedArousal({
            moodAggressive: 0.9,
            moodParty: 0.8,
            moodRelaxed: 0.1,
            moodAcoustic: 0.1,
            energy: 0.9,
            bpm: 180,
        });
        const low = calculateEnhancedArousal({
            moodAggressive: 0.1,
            moodParty: 0.1,
            moodRelaxed: 0.9,
            moodAcoustic: 0.9,
            energy: 0.2,
            bpm: 70,
        });
        expect(high).toBeGreaterThan(low);
    });
});

// ---------------------------------------------------------------------------
// detectOOD
// ---------------------------------------------------------------------------
describe("detectOOD", () => {
    it("detects all-high uniform moods as OOD", () => {
        expect(
            detectOOD({
                moodHappy: 0.85,
                moodSad: 0.75,
                moodRelaxed: 0.80,
                moodAggressive: 0.78,
            })
        ).toBe(true);
    });

    it("detects all-neutral moods as OOD", () => {
        expect(
            detectOOD({
                moodHappy: 0.50,
                moodSad: 0.48,
                moodRelaxed: 0.51,
                moodAggressive: 0.49,
            })
        ).toBe(true);
    });

    it("returns false for clearly differentiated moods", () => {
        expect(
            detectOOD({
                moodHappy: 0.9,
                moodSad: 0.1,
                moodRelaxed: 0.3,
                moodAggressive: 0.2,
            })
        ).toBe(false);
    });

    it("handles missing mood values with defaults", () => {
        // All default to 0.5 -> all-neutral -> OOD
        expect(detectOOD({})).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// octaveAwareBPMDistance
// ---------------------------------------------------------------------------
describe("octaveAwareBPMDistance", () => {
    it("returns 0 for identical BPMs", () => {
        expect(octaveAwareBPMDistance(120, 120)).toBe(0);
    });

    it("returns 0 for zero BPMs", () => {
        expect(octaveAwareBPMDistance(0, 120)).toBe(0);
        expect(octaveAwareBPMDistance(120, 0)).toBe(0);
    });

    it("treats half-time and double-time as equivalent", () => {
        // 60 BPM and 120 BPM should be close (octave equivalent)
        const dist = octaveAwareBPMDistance(60, 120);
        expect(dist).toBeLessThan(0.1);
    });

    it("returns higher distance for non-octave-related BPMs", () => {
        const close = octaveAwareBPMDistance(120, 124);
        const far = octaveAwareBPMDistance(120, 90);
        expect(far).toBeGreaterThan(close);
    });

    it("caps at 1.0", () => {
        expect(octaveAwareBPMDistance(77, 154)).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// buildFeatureVector
// ---------------------------------------------------------------------------
describe("buildFeatureVector", () => {
    it("returns a 13-element vector", () => {
        const vec = buildFeatureVector({});
        expect(vec).toHaveLength(13);
    });

    it("applies 1.3x weight to mood features for enhanced tracks", () => {
        const enhancedTrack = {
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3.2.0",
            moodHappy: 0.8,
            moodSad: 0.2,
            moodRelaxed: 0.4,
            moodAggressive: 0.3,
            moodParty: 0.6,
            moodAcoustic: 0.3,
            moodElectronic: 0.7,
            energy: 0.6,
            bpm: 120,
            danceabilityMl: 0.7,
            instrumentalness: 0.4,
            keyScale: "major",
        };
        const vec = buildFeatureVector(enhancedTrack);
        // First element is moodHappy * 1.3
        expect(vec[0]).toBeCloseTo(0.8 * 1.3, 5);
    });

    it("uses default 0.5 for missing mood values on non-enhanced tracks", () => {
        const vec = buildFeatureVector({});
        // All 7 mood features should be 0.5 * 1.3 = 0.65
        for (let i = 0; i < 7; i++) {
            expect(vec[i]).toBeCloseTo(0.65, 5);
        }
    });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------
describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
        const v = [1, 2, 3, 4, 5];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    it("returns 0 for zero vectors", () => {
        expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
        expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    });

    it("is symmetric", () => {
        const a = [1, 3, 5, 7];
        const b = [2, 4, 6, 8];
        expect(cosineSimilarity(a, b)).toBeCloseTo(
            cosineSimilarity(b, a),
            10
        );
    });

    it("gives high similarity for proportional vectors", () => {
        const a = [1, 2, 3];
        const b = [2, 4, 6];
        expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    });
});

// ---------------------------------------------------------------------------
// computeTagBonus
// ---------------------------------------------------------------------------
describe("computeTagBonus", () => {
    it("returns 0 when no tags", () => {
        expect(computeTagBonus([], [], [], [])).toBe(0);
    });

    it("returns 0 when no overlap", () => {
        expect(
            computeTagBonus(["rock"], ["indie"], ["jazz"], ["classical"])
        ).toBe(0);
    });

    it("returns bonus for overlapping tags (case-insensitive)", () => {
        const bonus = computeTagBonus(
            ["Rock", "indie"],
            ["alternative"],
            ["rock"],
            ["pop"]
        );
        expect(bonus).toBe(0.01); // 1 overlap * 0.01
    });

    it("caps at 0.05 for many overlapping tags", () => {
        const tags = ["a", "b", "c", "d", "e", "f", "g", "h"];
        expect(computeTagBonus(tags, [], tags, [])).toBe(0.05);
    });
});

// ---------------------------------------------------------------------------
// computeAggregateFeatureVector
// ---------------------------------------------------------------------------
describe("computeAggregateFeatureVector", () => {
    it("returns null for empty array", () => {
        expect(computeAggregateFeatureVector([])).toBeNull();
    });

    it("returns null for tracks with no audio data", () => {
        expect(
            computeAggregateFeatureVector([{ id: "1" }, { id: "2" }])
        ).toBeNull();
    });

    it("returns the single track's vector for one seed", () => {
        const track = { bpm: 120, energy: 0.7, valence: 0.5 };
        const centroid = computeAggregateFeatureVector([track]);
        const single = buildFeatureVector(track);
        expect(centroid).not.toBeNull();
        expect(centroid).toHaveLength(13);
        for (let i = 0; i < 13; i++) {
            expect(centroid![i]).toBeCloseTo(single[i], 5);
        }
    });

    it("averages feature vectors from multiple seeds", () => {
        const t1 = { bpm: 100, energy: 0.4, valence: 0.3 };
        const t2 = { bpm: 140, energy: 0.8, valence: 0.7 };
        const centroid = computeAggregateFeatureVector([t1, t2]);
        const v1 = buildFeatureVector(t1);
        const v2 = buildFeatureVector(t2);
        expect(centroid).not.toBeNull();
        for (let i = 0; i < 13; i++) {
            expect(centroid![i]).toBeCloseTo((v1[i] + v2[i]) / 2, 5);
        }
    });

    it("filters out tracks without audio data before averaging", () => {
        const analyzed = { bpm: 120, energy: 0.6, valence: 0.5 };
        const noData = { id: "no-data" };
        const centroid = computeAggregateFeatureVector([analyzed, noData]);
        const single = buildFeatureVector(analyzed);
        expect(centroid).not.toBeNull();
        for (let i = 0; i < 13; i++) {
            expect(centroid![i]).toBeCloseTo(single[i], 5);
        }
    });
});

// ---------------------------------------------------------------------------
// scoreTracksAgainstSeed
// ---------------------------------------------------------------------------
describe("scoreTracksAgainstSeed", () => {
    const identityBias = (score: number, _pref: number) => score;

    it("returns empty array when no candidates", () => {
        const seedVec = buildFeatureVector({ bpm: 120, energy: 0.5 });
        const result = scoreTracksAgainstSeed(
            seedVec,
            [],
            [],
            [],
            new Map(),
            identityBias
        );
        expect(result).toEqual([]);
    });

    it("scores similar tracks higher than dissimilar ones", () => {
        const seed = {
            bpm: 120,
            energy: 0.7,
            valence: 0.6,
            moodHappy: 0.8,
            moodSad: 0.2,
        };
        const seedVec = buildFeatureVector(seed);

        const similar = {
            id: "similar",
            bpm: 122,
            energy: 0.68,
            valence: 0.58,
            moodHappy: 0.75,
            moodSad: 0.22,
            lastfmTags: [],
            essentiaGenres: [],
        };
        const dissimilar = {
            id: "dissimilar",
            bpm: 80,
            energy: 0.2,
            valence: 0.1,
            moodHappy: 0.1,
            moodSad: 0.9,
            lastfmTags: [],
            essentiaGenres: [],
        };

        const result = scoreTracksAgainstSeed(
            seedVec,
            [],
            [],
            [similar, dissimilar],
            new Map(),
            identityBias
        );

        // Similar track should score above threshold and rank first
        const similarResult = result.find((r) => r.id === "similar");
        expect(similarResult).toBeDefined();
        if (result.length > 1) {
            expect(result[0].id).toBe("similar");
        }
    });

    it("filters out tracks below threshold", () => {
        // A track with completely opposite features should be below 0.40 threshold
        const seed = {
            bpm: 120,
            energy: 0.9,
            moodHappy: 0.95,
            moodSad: 0.05,
            moodRelaxed: 0.1,
            moodAggressive: 0.8,
            moodParty: 0.9,
            moodAcoustic: 0.05,
            moodElectronic: 0.9,
            danceabilityMl: 0.9,
            instrumentalness: 0.05,
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3.2.0",
            keyScale: "major",
        };
        const seedVec = buildFeatureVector(seed);

        const opposite = {
            id: "opposite",
            bpm: 60,
            energy: 0.05,
            moodHappy: 0.05,
            moodSad: 0.95,
            moodRelaxed: 0.9,
            moodAggressive: 0.05,
            moodParty: 0.05,
            moodAcoustic: 0.95,
            moodElectronic: 0.05,
            danceabilityMl: 0.05,
            instrumentalness: 0.95,
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3.2.0",
            keyScale: "minor",
            lastfmTags: [],
            essentiaGenres: [],
        };

        const result = scoreTracksAgainstSeed(
            seedVec,
            [],
            [],
            [opposite],
            new Map(),
            identityBias
        );

        // The opposite track should be filtered out or have low score
        if (result.length > 0) {
            expect(result[0].score).toBeGreaterThan(0.40);
        }
    });

    it("returns results sorted by score descending", () => {
        const seedVec = buildFeatureVector({ bpm: 120, energy: 0.6 });

        const candidates = [
            {
                id: "a",
                bpm: 121,
                energy: 0.61,
                lastfmTags: [],
                essentiaGenres: [],
            },
            {
                id: "b",
                bpm: 119,
                energy: 0.59,
                lastfmTags: [],
                essentiaGenres: [],
            },
            {
                id: "c",
                bpm: 100,
                energy: 0.4,
                lastfmTags: [],
                essentiaGenres: [],
            },
        ];

        const result = scoreTracksAgainstSeed(
            seedVec,
            [],
            [],
            candidates,
            new Map(),
            identityBias
        );

        for (let i = 1; i < result.length; i++) {
            expect(result[i - 1].score).toBeGreaterThanOrEqual(
                result[i].score
            );
        }
    });

    it("includes tag bonus in scoring", () => {
        const seedVec = buildFeatureVector({ bpm: 120, energy: 0.5 });

        const withTags = {
            id: "tagged",
            bpm: 120,
            energy: 0.5,
            lastfmTags: ["rock", "indie", "alternative"],
            essentiaGenres: ["rock"],
        };
        const withoutTags = {
            id: "untagged",
            bpm: 120,
            energy: 0.5,
            lastfmTags: [],
            essentiaGenres: [],
        };

        const resultWith = scoreTracksAgainstSeed(
            seedVec,
            ["rock", "indie", "alternative"],
            ["rock"],
            [withTags],
            new Map(),
            identityBias
        );

        const resultWithout = scoreTracksAgainstSeed(
            seedVec,
            ["rock", "indie", "alternative"],
            ["rock"],
            [withoutTags],
            new Map(),
            identityBias
        );

        if (resultWith.length > 0 && resultWithout.length > 0) {
            expect(resultWith[0].score).toBeGreaterThan(
                resultWithout[0].score
            );
        }
    });
});
