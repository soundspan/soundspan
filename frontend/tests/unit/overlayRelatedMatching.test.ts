import assert from "node:assert/strict";
import { test } from "node:test";
import {
    buildStreamMatchQuery,
    getRelatedTrackKey,
    partitionTidalBatchMatches,
    selectTracksNeedingStreamMatch,
    sortRelatedTracksByRelevance,
} from "../../lib/overlay-related-matching";

test("library rows key on id; external rows on normalized artist and title", () => {
    assert.equal(getRelatedTrackKey({ id: "t1", title: "Song" }), "lib:t1");
    assert.equal(
        getRelatedTrackKey({ title: "  Song  ", artist: " The Band " }),
        "ext:the band::song",
    );
    assert.equal(
        getRelatedTrackKey({
            title: "Song",
            album: { artist: { name: "Album Artist" } },
        }),
        "ext:album artist::song",
    );
    assert.equal(getRelatedTrackKey({ title: "" }), "ext:unknown::unknown");
});

test("relevance sorting puts library rows first, then confidence and similarity", () => {
    const sorted = sortRelatedTracksByRelevance([
        { title: "external-strong", similarity: 0.9, matchConfidence: 50 },
        { title: "library", inLibrary: true },
        { title: "external-weak", similarity: 0.1 },
    ]);
    assert.deepEqual(
        sorted.map((t) => t.title),
        ["library", "external-strong", "external-weak"],
    );
});

test("relevance sorting ignores non-finite scores and does not mutate input", () => {
    const input = [
        { title: "nan", similarity: Number.NaN, matchConfidence: Number.NaN },
        { title: "scored", similarity: 0.5 },
    ];
    const sorted = sortRelatedTracksByRelevance(input);
    assert.deepEqual(
        sorted.map((t) => t.title),
        ["scored", "nan"],
    );
    assert.equal(input[0].title, "nan");
});

test("stream matching skips library rows, unidentified rows, and matched rows", () => {
    const tracks = [
        { title: "in-library", inLibrary: true },
        { title: "", artist: "A" },
        { title: "no-artist" },
        { title: "already-matched", artist: "A" },
        { title: "needs-match", artist: "B" },
    ];
    const missing = selectTracksNeedingStreamMatch(tracks, {
        "ext:a::already-matched": { streamSource: "tidal" },
    });
    assert.deepEqual(
        missing.map((t) => t.title),
        ["needs-match"],
    );
});

test("stream-match queries prefer the row artist and carry album context", () => {
    assert.deepEqual(
        buildStreamMatchQuery({
            title: "Song",
            artist: "Row Artist",
            duration: 200,
            album: { title: "Album", artist: { name: "Album Artist" } },
        }),
        {
            artist: "Row Artist",
            title: "Song",
            albumTitle: "Album",
            duration: 200,
        },
    );
    assert.equal(
        buildStreamMatchQuery({
            title: "Song",
            album: { artist: { name: "Album Artist" } },
        }).artist,
        "Album Artist",
    );
});

test("tidal batch partition records hits and queues misses for youtube", () => {
    const missing = [
        { title: "hit", artist: "A" },
        { title: "miss", artist: "B", duration: 90 },
        { title: "null-slot", artist: "C" },
    ];
    const { foundMatches, youtubePayload, youtubeTrackKeys } =
        partitionTidalBatchMatches(missing, [
            { id: 42, title: "hit", artist: "A", duration: 180 },
            null,
        ]);

    assert.deepEqual(foundMatches, {
        "ext:a::hit": {
            streamSource: "tidal",
            tidalTrackId: 42,
            title: "hit",
            artist: "A",
            duration: 180,
        },
    });
    assert.deepEqual(
        youtubePayload.map((q) => q.title),
        ["miss", "null-slot"],
    );
    assert.deepEqual(youtubeTrackKeys, ["ext:b::miss", "ext:c::null-slot"]);
});
