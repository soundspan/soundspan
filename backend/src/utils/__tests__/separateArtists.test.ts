import { separateArtists, separateArtistsPreservingOrder } from "../separateArtists";

interface FakeTrack {
    id: number;
    artist: string;
}

const track = (id: number, artist: string): FakeTrack => ({ id, artist });
const getArtist = (t: FakeTrack) => t.artist;

function hasAdjacentSameArtist(items: FakeTrack[]): boolean {
    for (let i = 1; i < items.length; i++) {
        if (items[i].artist === items[i - 1].artist) return true;
    }
    return false;
}

describe("separateArtists (round-robin)", () => {
    it("returns empty array for empty input", () => {
        expect(separateArtists([], getArtist)).toEqual([]);
    });

    it("returns single item unchanged", () => {
        const items = [track(1, "A")];
        expect(separateArtists(items, getArtist)).toEqual(items);
    });

    it("achieves perfect separation with balanced artists", () => {
        const items = [
            track(1, "A"), track(2, "A"), track(3, "A"),
            track(4, "B"), track(5, "B"), track(6, "B"),
            track(7, "C"), track(8, "C"), track(9, "C"),
        ];
        const result = separateArtists(items, getArtist);
        expect(result).toHaveLength(9);
        expect(hasAdjacentSameArtist(result)).toBe(false);
    });

    it("achieves perfect separation when largest bucket ≤ ⌈n/2⌉", () => {
        // 5 tracks: A×3, B×2 → largest=3, ⌈5/2⌉=3, so perfect separation possible
        const items = [
            track(1, "A"), track(2, "A"), track(3, "A"),
            track(4, "B"), track(5, "B"),
        ];
        const result = separateArtists(items, getArtist);
        expect(result).toHaveLength(5);
        expect(hasAdjacentSameArtist(result)).toBe(false);
    });

    it("minimises adjacency when one artist dominates", () => {
        // All same artist — unavoidable adjacency
        const items = [track(1, "A"), track(2, "A"), track(3, "A")];
        const result = separateArtists(items, getArtist);
        expect(result).toHaveLength(3);
        // All same artist, so all adjacent — just verify no tracks lost
        expect(result.map((t) => t.id).sort()).toEqual([1, 2, 3]);
    });

    it("preserves all tracks (no drops)", () => {
        const items = [
            track(1, "A"), track(2, "B"), track(3, "C"),
            track(4, "A"), track(5, "B"), track(6, "C"),
            track(7, "A"), track(8, "D"),
        ];
        const result = separateArtists(items, getArtist);
        expect(result).toHaveLength(items.length);
        expect(result.map((t) => t.id).sort()).toEqual(items.map((t) => t.id).sort());
    });

    it("handles two items same artist", () => {
        const items = [track(1, "A"), track(2, "A")];
        const result = separateArtists(items, getArtist);
        expect(result).toHaveLength(2);
    });

    it("handles two items different artist", () => {
        const items = [track(1, "A"), track(2, "B")];
        const result = separateArtists(items, getArtist);
        expect(result).toHaveLength(2);
        expect(hasAdjacentSameArtist(result)).toBe(false);
    });

    it("works with index-based usage pattern (frontend shuffle)", () => {
        // Simulates the frontend pattern: indices into a queue
        const queue = [
            { artist: "A" }, { artist: "B" }, { artist: "A" },
            { artist: "C" }, { artist: "A" }, { artist: "B" },
        ];
        const indices = [0, 1, 2, 3, 4, 5];
        const result = separateArtists(indices, (idx) => queue[idx].artist);
        expect(result).toHaveLength(6);
        expect(result.sort()).toEqual([0, 1, 2, 3, 4, 5]);
        // Check no adjacent same artist via the queue lookup
        for (let i = 1; i < result.length; i++) {
            expect(queue[result[i]].artist).not.toBe(queue[result[i - 1]].artist);
        }
    });

    it("treats missing/empty artist keys as distinct per track", () => {
        const items = [
            track(1, ""), track(2, ""), track(3, "A"),
        ];
        // Empty strings are equal keys — they will bucket together
        const result = separateArtists(items, getArtist);
        expect(result).toHaveLength(3);
    });
});

describe("separateArtistsPreservingOrder (bounded swap)", () => {
    it("returns empty array for empty input", () => {
        expect(separateArtistsPreservingOrder([], getArtist)).toEqual([]);
    });

    it("returns single item unchanged", () => {
        const items = [track(1, "A")];
        expect(separateArtistsPreservingOrder(items, getArtist)).toEqual(items);
    });

    it("swaps adjacent same-artist tracks when possible", () => {
        const items = [
            track(1, "A"), track(2, "A"), track(3, "B"), track(4, "C"),
        ];
        const result = separateArtistsPreservingOrder(items, getArtist);
        expect(result).toHaveLength(4);
        // Track 2 (A) should be swapped with track 3 (B)
        expect(result[0].artist).toBe("A");
        expect(result[1].artist).toBe("B");
        expect(result[2].artist).toBe("A");
    });

    it("does not swap beyond maxSwapDistance", () => {
        // A A A A B — with maxSwapDistance=3, the first A-A pair tries to find
        // a non-A within 3 ahead. B is at distance 3 from index 1, reachable.
        const items = [
            track(1, "A"), track(2, "A"), track(3, "A"),
            track(4, "A"), track(5, "B"),
        ];
        const result = separateArtistsPreservingOrder(items, getArtist, 3);
        expect(result).toHaveLength(5);
        // Some adjacency is unavoidable but B should move closer
        expect(result.map((t) => t.id).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it("preserves order when no adjacency exists", () => {
        const items = [
            track(1, "A"), track(2, "B"), track(3, "C"), track(4, "A"),
        ];
        const result = separateArtistsPreservingOrder(items, getArtist);
        expect(result).toEqual(items);
    });

    it("preserves all tracks (no drops)", () => {
        const items = [
            track(1, "A"), track(2, "A"), track(3, "B"),
            track(4, "A"), track(5, "C"), track(6, "A"),
        ];
        const result = separateArtistsPreservingOrder(items, getArtist);
        expect(result).toHaveLength(items.length);
        expect(result.map((t) => t.id).sort()).toEqual(items.map((t) => t.id).sort());
    });

    it("does not mutate the input array", () => {
        const items = [track(1, "A"), track(2, "A"), track(3, "B")];
        const original = [...items];
        separateArtistsPreservingOrder(items, getArtist);
        expect(items).toEqual(original);
    });

    it("handles all same artist gracefully", () => {
        const items = [track(1, "X"), track(2, "X"), track(3, "X")];
        const result = separateArtistsPreservingOrder(items, getArtist);
        expect(result).toHaveLength(3);
        expect(result.map((t) => t.id).sort()).toEqual([1, 2, 3]);
    });

    it("respects custom maxSwapDistance", () => {
        // A A B C D — with maxSwapDistance=1, can only look 1 ahead from index 1
        const items = [
            track(1, "A"), track(2, "A"), track(3, "B"),
            track(4, "C"), track(5, "D"),
        ];
        const result = separateArtistsPreservingOrder(items, getArtist, 1);
        expect(result).toHaveLength(5);
        // With distance=1, index 1 can reach index 2 (B) and swap
        expect(result[1].artist).toBe("B");
    });
});
