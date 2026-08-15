import {
    applyArtistCap,
    type ArtistCapTrack,
} from "../services/programmaticPlaylistArtistCap";

type TestTrack = ArtistCapTrack & { id: string };

function makeTrack(id: string, artistId?: string): TestTrack {
    return {
        id,
        album: artistId
            ? {
                  artist: {
                      id: artistId,
                  },
              }
            : {
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
    it("returns an empty selection for a non-array track input", () => {
        expect(
            applyArtistCap(null as unknown as TestTrack[], {
                maxPerArtist: 1,
            }),
        ).toEqual([]);
    });

    it("uses a custom artist identity before the album artist path", () => {
        const input = [
            { ...makeTrack("a-1", "album-a"), artistId: "artist-a" },
            { ...makeTrack("a-2", "album-b"), artistId: "artist-a" },
            { ...makeTrack("u-1", "album-u"), artistId: "" },
            { ...makeTrack("u-2", "album-u"), artistId: "" },
        ];

        const selected = applyArtistCap(input, {
            maxPerArtist: 1,
            preserveInputOrder: true,
            getArtistId: (track) => track.artistId,
        });

        expect(selected.map((track) => track.id)).toEqual([
            "a-1",
            "u-1",
            "u-2",
        ]);
    });

    it("carries artist counts from tracks selected by an earlier pass", () => {
        const selected = applyArtistCap(
            [
                makeTrack("a-new-1", "artist-a"),
                makeTrack("a-new-2", "artist-a"),
                makeTrack("b-new-1", "artist-b"),
            ],
            {
                maxPerArtist: 2,
                targetCount: 3,
                preserveInputOrder: true,
                alreadySelected: [makeTrack("a-existing", "artist-a")],
            },
        );

        expect(selected.map((track) => track.id)).toEqual([
            "a-new-1",
            "b-new-1",
        ]);
    });

    it("counts already-selected artists against relaxed fallback caps", () => {
        const selected = applyArtistCap(
            [
                makeTrack("a-new-1", "artist-a"),
                makeTrack("a-new-2", "artist-a"),
                makeTrack("b-new-1", "artist-b"),
                makeTrack("b-new-2", "artist-b"),
            ],
            {
                maxPerArtist: 1,
                targetCount: 4,
                preserveInputOrder: true,
                alreadySelected: [makeTrack("a-existing", "artist-a")],
                fallback: {
                    enabled: true,
                    maxRelaxedPerArtist: 2,
                },
            },
        );

        expect(selected.map((track) => track.id)).toEqual([
            "b-new-1",
            "a-new-1",
            "b-new-2",
        ]);
    });

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
        const unknownOneCount = selectedIds.filter(
            (id) => id === "unknown-1",
        ).length;
        const knownArtistCount = selected.filter(
            (track) => track.album?.artist?.id === "artist-a",
        ).length;

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

    it("refill after max relaxation keeps a hard ceiling instead of un-capping (GH #46)", () => {
        // 5 of 6 candidates are one artist. The old refill returned all
        // six -- an 83%-dominated "playlist". The refill now respects a
        // hard ceiling, preferring a shorter diverse result.
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

        const counts = countByArtist(selected);
        expect(counts.get("artist-a")).toBeLessThanOrEqual(3);
        expect(selected).toHaveLength(4); // 3 x artist-a + 1 x artist-b
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
