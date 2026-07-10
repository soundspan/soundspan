import {
    allocateTracksWithArtistWeighting,
    sampleUniform,
} from "../artistSlotAllocation";

type TestTrack = { id: string; artistId: string };

const makeCatalog = (spec: Record<string, number>): TestTrack[] => {
    const tracks: TestTrack[] = [];
    for (const [artistId, count] of Object.entries(spec)) {
        for (let i = 0; i < count; i += 1) {
            tracks.push({ id: `${artistId}-t${i}`, artistId });
        }
    }
    return tracks;
};

const getArtistKey = (track: TestTrack) => track.artistId;

const makeRng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
};

const countByArtist = (tracks: TestTrack[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const track of tracks) {
        counts.set(track.artistId, (counts.get(track.artistId) ?? 0) + 1);
    }
    return counts;
};

describe("allocateTracksWithArtistWeighting", () => {
    it("returns empty output for empty input or non-positive target", () => {
        expect(
            allocateTracksWithArtistWeighting([], getArtistKey, {
                targetCount: 10,
            }),
        ).toEqual([]);
        expect(
            allocateTracksWithArtistWeighting(
                makeCatalog({ a: 3 }),
                getArtistKey,
                { targetCount: 0 },
            ),
        ).toEqual([]);
    });

    it("allocates exactly targetCount when enough capacity exists", () => {
        const result = allocateTracksWithArtistWeighting(
            makeCatalog({ a: 40, b: 10, c: 10, d: 10 }),
            getArtistKey,
            { targetCount: 20, rng: makeRng(7) },
        );
        expect(result).toHaveLength(20);
        const ids = new Set(result.map((t) => t.id));
        expect(ids.size).toBe(20);
    });

    it("enforces the per-artist ceiling regardless of discography size", () => {
        // One artist has 100 of 130 tracks; ceiling 30% of 20 slots = 6.
        const result = allocateTracksWithArtistWeighting(
            makeCatalog({ giant: 100, b: 10, c: 10, d: 10 }),
            getArtistKey,
            { targetCount: 20, ceilingShare: 0.3, rng: makeRng(1) },
        );
        const counts = countByArtist(result);
        expect(counts.get("giant")! <= 6).toBe(true);
        expect(result).toHaveLength(20);
    });

    it("weights larger discographies above one-hit wonders (alpha 0.5)", () => {
        const result = allocateTracksWithArtistWeighting(
            makeCatalog({ big: 16, small: 1, other1: 4, other2: 4, other3: 4 }),
            getArtistKey,
            { targetCount: 12, alpha: 0.5, ceilingShare: 0.5, rng: makeRng(3) },
        );
        const counts = countByArtist(result);
        // w_big = 4, w_small = 1: big must get measurably more slots.
        expect(counts.get("big")! > (counts.get("small") ?? 0)).toBe(true);
        expect(counts.get("big")! >= 3).toBe(true);
    });

    it("alpha=0 degenerates toward uniform per-artist allocation", () => {
        const result = allocateTracksWithArtistWeighting(
            makeCatalog({ a: 50, b: 5, c: 5, d: 5 }),
            getArtistKey,
            { targetCount: 12, alpha: 0, ceilingShare: 0.5, rng: makeRng(5) },
        );
        const counts = countByArtist(result);
        // Equal weights: every artist gets 3 of 12.
        expect(counts.get("a")).toBe(3);
        expect(counts.get("b")).toBe(3);
        expect(counts.get("c")).toBe(3);
        expect(counts.get("d")).toBe(3);
    });

    it("is deterministic for the same injected rng seed", () => {
        const catalog = makeCatalog({ a: 20, b: 15, c: 5, d: 2 });
        const first = allocateTracksWithArtistWeighting(catalog, getArtistKey, {
            targetCount: 10,
            rng: makeRng(42),
        });
        const second = allocateTracksWithArtistWeighting(catalog, getArtistKey, {
            targetCount: 10,
            rng: makeRng(42),
        });
        expect(first.map((t) => t.id)).toEqual(second.map((t) => t.id));
    });

    it("returns everything (capped) when capacity is below the target", () => {
        const result = allocateTracksWithArtistWeighting(
            makeCatalog({ a: 2, b: 1 }),
            getArtistKey,
            { targetCount: 50, rng: makeRng(9) },
        );
        expect(result).toHaveLength(3);
    });

    it("caps a single-artist pool at the ceiling instead of filling the target", () => {
        const result = allocateTracksWithArtistWeighting(
            makeCatalog({ only: 100 }),
            getArtistKey,
            { targetCount: 20, ceilingShare: 0.3, rng: makeRng(2) },
        );
        expect(result).toHaveLength(6); // 30% of 20
    });

    it("spaces dominant artists via round-robin interleaving", () => {
        const result = allocateTracksWithArtistWeighting(
            makeCatalog({ a: 10, b: 10 }),
            getArtistKey,
            { targetCount: 10, alpha: 0, ceilingShare: 0.5, rng: makeRng(4) },
        );
        // Round-robin over two equally-weighted artists alternates them.
        const sequence = result.map((t) => t.artistId);
        for (let i = 1; i < sequence.length; i += 1) {
            expect(sequence[i]).not.toBe(sequence[i - 1]);
        }
    });
});

describe("sampleUniform", () => {
    it("samples the requested count without duplicates", () => {
        const items = Array.from({ length: 50 }, (_, i) => i);
        const sample = sampleUniform(items, 10, makeRng(11));
        expect(sample).toHaveLength(10);
        expect(new Set(sample).size).toBe(10);
    });

    it("returns a copy of everything when count exceeds length", () => {
        const items = [1, 2, 3];
        const sample = sampleUniform(items, 10, makeRng(11));
        expect(sample).toHaveLength(3);
        expect(new Set(sample)).toEqual(new Set(items));
    });

    it("is deterministic under an injected rng and does not mutate input", () => {
        const items = Array.from({ length: 20 }, (_, i) => i);
        const original = [...items];
        const first = sampleUniform(items, 5, makeRng(21));
        const second = sampleUniform(items, 5, makeRng(21));
        expect(first).toEqual(second);
        expect(items).toEqual(original);
    });
});
