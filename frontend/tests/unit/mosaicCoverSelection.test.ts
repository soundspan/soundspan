import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    selectMosaicCovers,
    createMosaicCandidates,
    type MosaicCoverCandidate,
} from "../../utils/mosaicCoverSelection";

const c = (
    id: string,
    coverUrl: string,
    artistKey?: string,
    albumKey?: string,
): MosaicCoverCandidate => ({ id, coverUrl, artistKey, albumKey });

// ---------------------------------------------------------------------------
// selectMosaicCovers
// ---------------------------------------------------------------------------

describe("selectMosaicCovers", () => {
    test("returns empty array for empty input", () => {
        assert.deepEqual(selectMosaicCovers([]), []);
    });

    test("returns empty array when count is 0", () => {
        assert.deepEqual(
            selectMosaicCovers([c("1", "url-1")], { count: 0 }),
            [],
        );
    });

    test("phase 1: maximises artist + album + cover diversity", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1", "artist-a", "album-1"),
                c("t2", "cover-2", "artist-b", "album-2"),
                c("t3", "cover-3", "artist-c", "album-3"),
                c("t4", "cover-4", "artist-d", "album-4"),
                // same artist/album as earlier — should be skipped in phase 1
                c("t5", "cover-5", "artist-a", "album-1"),
            ],
            { count: 4 },
        );
        assert.equal(result.length, 4);
        const artists = new Set(
            result.map((r) => {
                const orig = [c("t1", "cover-1", "artist-a", "album-1"),
                    c("t2", "cover-2", "artist-b", "album-2"),
                    c("t3", "cover-3", "artist-c", "album-3"),
                    c("t4", "cover-4", "artist-d", "album-4"),
                    c("t5", "cover-5", "artist-a", "album-1"),
                ].find((x) => x.id === r.candidateId);
                return orig?.artistKey;
            }),
        );
        assert.equal(artists.size, 4, "All 4 tiles should have unique artists");
    });

    test("phase 2: falls back to unique-cover when artist diversity exhausted", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1", "artist-a", "album-1"),
                c("t2", "cover-2", "artist-a", "album-1"), // same artist/album, unique cover
                c("t3", "cover-3", "artist-b", "album-2"),
                c("t4", "cover-4", "artist-b", "album-2"),
            ],
            { count: 4 },
        );
        assert.equal(result.length, 4);
        assert.equal(
            new Set(result.map((r) => r.coverUrl)).size,
            4,
            "Should pick unique covers even if artists repeat",
        );
    });

    test("phase 3: falls back to any remaining when covers exhausted", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1", "artist-a"),
                c("t2", "cover-1", "artist-a"), // duplicate cover+artist
                c("t3", "cover-2", "artist-b"),
            ],
            { count: 4 },
        );
        // Only 3 unique IDs available, no recycle → only 3 results
        assert.equal(result.length, 3);
    });

    test("recycleFallback fills remaining slots by cycling", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1", "artist-a"),
                c("t2", "cover-2", "artist-b"),
            ],
            { count: 6, recycleFallback: true },
        );
        assert.equal(result.length, 6);
        // First two are originals, rest are recycled
        assert.equal(result[0].candidateId, "t1");
        assert.equal(result[1].candidateId, "t2");
        assert.ok(result[2].candidateId.includes("::recycle-"));
    });

    test("missing artistKey treated as always-unique", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1"), // no artistKey
                c("t2", "cover-2"), // no artistKey
                c("t3", "cover-3"),
                c("t4", "cover-4"),
            ],
            { count: 4 },
        );
        assert.equal(result.length, 4);
        // All should be selected in phase 1 since no artist collisions
        assert.deepEqual(
            result.map((r) => r.candidateId),
            ["t1", "t2", "t3", "t4"],
        );
    });

    test("missing albumKey treated as always-unique", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1", "artist-a"), // no albumKey
                c("t2", "cover-2", "artist-b"),
                c("t3", "cover-3", "artist-c"),
                c("t4", "cover-4", "artist-d"),
            ],
            { count: 4 },
        );
        assert.equal(result.length, 4);
    });

    test("deterministic order matches input order", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1", "artist-a"),
                c("t2", "cover-2", "artist-b"),
                c("t3", "cover-3", "artist-c"),
            ],
            { count: 3 },
        );
        assert.deepEqual(
            result.map((r) => r.candidateId),
            ["t1", "t2", "t3"],
        );
    });

    test("album-key collision blocks phase 1 selection", () => {
        const result = selectMosaicCovers(
            [
                c("t1", "cover-1", "artist-a", "album-x"),
                c("t2", "cover-2", "artist-b", "album-x"), // same album
                c("t3", "cover-3", "artist-c", "album-y"),
            ],
            { count: 3 },
        );
        // Phase 1 picks t1 and t3 (unique artist+album+cover), skips t2 (album-x)
        // Phase 2 picks t2 (unique cover)
        assert.equal(result.length, 3);
        assert.deepEqual(
            result.map((r) => r.candidateId),
            ["t1", "t3", "t2"],
        );
    });
});

// ---------------------------------------------------------------------------
// createMosaicCandidates
// ---------------------------------------------------------------------------

describe("createMosaicCandidates", () => {
    test("filters items without cover URL", () => {
        const items = [
            { id: "1", cover: "url-1", artist: "a" },
            { id: "2", cover: null, artist: "b" },
            { id: "3", cover: "url-3", artist: "c" },
        ];
        const result = createMosaicCandidates(items, {
            getId: (t) => t.id,
            getCoverUrl: (t) => t.cover,
            getArtistKey: (t) => t.artist,
        });
        assert.equal(result.length, 2);
        assert.equal(result[0].id, "1");
        assert.equal(result[1].id, "3");
    });

    test("populates artistKey and albumKey when accessors provided", () => {
        const items = [{ id: "1", cover: "url-1", artist: "a", album: "x" }];
        const result = createMosaicCandidates(items, {
            getId: (t) => t.id,
            getCoverUrl: (t) => t.cover,
            getArtistKey: (t) => t.artist,
            getAlbumKey: (t) => t.album,
        });
        assert.equal(result[0].artistKey, "a");
        assert.equal(result[0].albumKey, "x");
    });

    test("omits artistKey/albumKey when accessors not provided", () => {
        const items = [{ id: "1", cover: "url-1" }];
        const result = createMosaicCandidates(items, {
            getId: (t) => t.id,
            getCoverUrl: (t) => t.cover,
        });
        assert.equal(result[0].artistKey, undefined);
        assert.equal(result[0].albumKey, undefined);
    });

    test("skips falsy accessor results (empty string)", () => {
        const items = [{ id: "1", cover: "url-1", artist: "" }];
        const result = createMosaicCandidates(items, {
            getId: (t) => t.id,
            getCoverUrl: (t) => t.cover,
            getArtistKey: (t) => t.artist,
        });
        // Empty string is falsy → artistKey should be omitted
        assert.equal(result[0].artistKey, undefined);
    });
});
