import { applyArtistCap, type ArtistCapTrack } from "../services/programmaticPlaylistArtistCap";

type TestTrack = ArtistCapTrack & { id: string };

function makeTrack(id: string, artistId?: string): TestTrack {
    return {
        id,
        album:
            artistId ?
                {
                    artist: {
                        id: artistId,
                    },
                }
            :   {
                    artist: {},
                },
    };
}

function makeSeededRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function countByArtist(tracks: TestTrack[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const track of tracks) {
        const artistId = track.album?.artist?.id ?? `unknown:${track.id}`;
        counts.set(artistId, (counts.get(artistId) ?? 0) + 1);
    }
    return counts;
}

describe("applyArtistCap", () => {
    it("enforces max-per-artist cap", () => {
        const input: TestTrack[] = [
            makeTrack("a-1", "artist-a"),
            makeTrack("a-2", "artist-a"),
            makeTrack("a-3", "artist-a"),
            makeTrack("b-1", "artist-b"),
            makeTrack("b-2", "artist-b"),
            makeTrack("c-1", "artist-c"),
        ];

        const selected = applyArtistCap(input, {
            maxPerArtist: 2,
            rng: makeSeededRng(42),
        });

        const counts = countByArtist(selected);
        for (const count of counts.values()) {
            expect(count).toBeLessThanOrEqual(2);
        }
        expect(selected.length).toBe(5);
    });

    it("is deterministic when a deterministic RNG is provided", () => {
        const input: TestTrack[] = [
            makeTrack("a-1", "artist-a"),
            makeTrack("a-2", "artist-a"),
            makeTrack("a-3", "artist-a"),
            makeTrack("b-1", "artist-b"),
            makeTrack("b-2", "artist-b"),
            makeTrack("c-1", "artist-c"),
            makeTrack("d-1", "artist-d"),
            makeTrack("e-1", "artist-e"),
        ];

        const first = applyArtistCap(input, {
            maxPerArtist: 2,
            rng: makeSeededRng(1337),
        }).map((track) => track.id);

        const second = applyArtistCap(input, {
            maxPerArtist: 2,
            rng: makeSeededRng(1337),
        }).map((track) => track.id);

        expect(first).toEqual(second);
    });

    it("uses stable fallback keys for unknown artists", () => {
        const input: TestTrack[] = [
            makeTrack("unknown-1"),
            makeTrack("unknown-1"),
            makeTrack("unknown-2"),
            makeTrack("known-a-1", "artist-a"),
            makeTrack("known-a-2", "artist-a"),
        ];

        const selected = applyArtistCap(input, {
            maxPerArtist: 1,
            rng: makeSeededRng(7),
        });

        const selectedIds = selected.map((track) => track.id);
        const unknownOneCount = selectedIds.filter((id) => id === "unknown-1").length;
        const knownArtistCount = selected.filter((track) => track.album?.artist?.id === "artist-a").length;

        expect(unknownOneCount).toBe(1);
        expect(knownArtistCount).toBe(1);
        expect(selectedIds).toContain("unknown-2");
    });

    it("preserves input ranking when preserveInputOrder is enabled", () => {
        const input: TestTrack[] = [
            makeTrack("a-1", "artist-a"),
            makeTrack("a-2", "artist-a"),
            makeTrack("a-3", "artist-a"),
            makeTrack("b-1", "artist-b"),
            makeTrack("b-2", "artist-b"),
            makeTrack("c-1", "artist-c"),
        ];

        const selected = applyArtistCap(input, {
            maxPerArtist: 2,
            targetCount: 4,
            preserveInputOrder: true,
            rng: makeSeededRng(999),
        }).map((track) => track.id);

        expect(selected).toEqual(["a-1", "a-2", "b-1", "b-2"]);
    });

    it("fills target size via controlled cap relaxation in sparse pools", () => {
        const input: TestTrack[] = [
            makeTrack("a-1", "artist-a"),
            makeTrack("a-2", "artist-a"),
            makeTrack("a-3", "artist-a"),
            makeTrack("a-4", "artist-a"),
            makeTrack("b-1", "artist-b"),
            makeTrack("b-2", "artist-b"),
            makeTrack("b-3", "artist-b"),
            makeTrack("b-4", "artist-b"),
        ];

        const selected = applyArtistCap(input, {
            maxPerArtist: 2,
            targetCount: 8,
            rng: makeSeededRng(101),
            fallback: {
                enabled: true,
                maxRelaxedPerArtist: 4,
            },
        });

        const counts = countByArtist(selected);
        expect(selected).toHaveLength(8);
        expect(counts.get("artist-a")).toBeLessThanOrEqual(4);
        expect(counts.get("artist-b")).toBeLessThanOrEqual(4);
    });

    it("can refill from excluded tracks after max relaxation", () => {
        const input: TestTrack[] = [
            makeTrack("a-1", "artist-a"),
            makeTrack("a-2", "artist-a"),
            makeTrack("a-3", "artist-a"),
            makeTrack("a-4", "artist-a"),
            makeTrack("a-5", "artist-a"),
            makeTrack("b-1", "artist-b"),
        ];

        const selected = applyArtistCap(input, {
            maxPerArtist: 2,
            targetCount: 6,
            rng: makeSeededRng(202),
            fallback: {
                enabled: true,
                maxRelaxedPerArtist: 3,
                refillFromExcludedAfterMaxRelaxation: true,
            },
        });

        expect(selected).toHaveLength(6);
    });

    it("is deterministic across fallback passes with seeded RNG", () => {
        const input: TestTrack[] = [
            makeTrack("a-1", "artist-a"),
            makeTrack("a-2", "artist-a"),
            makeTrack("a-3", "artist-a"),
            makeTrack("a-4", "artist-a"),
            makeTrack("b-1", "artist-b"),
            makeTrack("b-2", "artist-b"),
            makeTrack("c-1", "artist-c"),
        ];

        const first = applyArtistCap(input, {
            maxPerArtist: 2,
            targetCount: 7,
            rng: makeSeededRng(303),
            fallback: {
                enabled: true,
                maxRelaxedPerArtist: 3,
                refillFromExcludedAfterMaxRelaxation: true,
            },
        }).map((track) => track.id);

        const second = applyArtistCap(input, {
            maxPerArtist: 2,
            targetCount: 7,
            rng: makeSeededRng(303),
            fallback: {
                enabled: true,
                maxRelaxedPerArtist: 3,
                refillFromExcludedAfterMaxRelaxation: true,
            },
        }).map((track) => track.id);

        expect(first).toEqual(second);
    });
});
