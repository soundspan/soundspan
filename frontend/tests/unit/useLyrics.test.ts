import assert from "node:assert/strict";
import test from "node:test";
import {
    LYRICS_EMPTY_RESULT_STALE_TIME,
    LYRICS_QUERY_STALE_TIME,
    resolveLyricsQueryStaleTime,
    type LyricsCachePolicyInput,
} from "../../lib/lyrics-cache-policy.ts";

test("resolveLyricsQueryStaleTime keeps successful lyrics cached long-term", () => {
    const synced: LyricsCachePolicyInput = {
        syncedLyrics: "[00:01.00] line",
        plainLyrics: null,
        source: "lrclib",
    };

    const plain: LyricsCachePolicyInput = {
        syncedLyrics: null,
        plainLyrics: "line",
        source: "embedded",
    };

    assert.equal(resolveLyricsQueryStaleTime(undefined), LYRICS_QUERY_STALE_TIME);
    assert.equal(resolveLyricsQueryStaleTime(synced), LYRICS_QUERY_STALE_TIME);
    assert.equal(resolveLyricsQueryStaleTime(plain), LYRICS_QUERY_STALE_TIME);
});

test("resolveLyricsQueryStaleTime refreshes empty none responses quickly", () => {
    const emptyNone: LyricsCachePolicyInput = {
        syncedLyrics: null,
        plainLyrics: null,
        source: "none",
    };

    const nonEmptyNone: LyricsCachePolicyInput = {
        syncedLyrics: "[00:01.00] line",
        plainLyrics: null,
        source: "none",
    };

    assert.equal(
        resolveLyricsQueryStaleTime(emptyNone),
        LYRICS_EMPTY_RESULT_STALE_TIME
    );
    assert.equal(
        resolveLyricsQueryStaleTime(nonEmptyNone),
        LYRICS_QUERY_STALE_TIME
    );
});
