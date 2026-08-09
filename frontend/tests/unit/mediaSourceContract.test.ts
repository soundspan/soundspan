import assert from "node:assert/strict";
import test from "node:test";
import {
    CANONICAL_MEDIA_SOURCE_VALUES,
    normalizeCanonicalMediaSource,
    resolveCanonicalMediaSource,
    toAudioEngineSourceType,
    toLegacyStreamFields,
} from "@soundspan/media-metadata-contract";
import type {
    CanonicalMediaSource,
    RemoteMediaSource,
    ResolvedMediaSource,
} from "@soundspan/media-metadata-contract";

const _canonicalSource: CanonicalMediaSource = "local";
const _r1: RemoteMediaSource = "youtube-direct";
const _r2: RemoteMediaSource = "tidal";
const _s1: ResolvedMediaSource = "local";
const _s2: ResolvedMediaSource = "youtube";
// @ts-expect-error RemoteMediaSource excludes local media.
const _rBad: RemoteMediaSource = "local";
// @ts-expect-error ResolvedMediaSource excludes direct YouTube media.
const _sBad: ResolvedMediaSource = "youtube-direct";

void _canonicalSource;
void _r1;
void _r2;
void _s1;
void _s2;
void _rBad;
void _sBad;

test("CANONICAL_MEDIA_SOURCE_VALUES lists every canonical media source", () => {
    assert.deepEqual(CANONICAL_MEDIA_SOURCE_VALUES, [
        "local",
        "tidal",
        "youtube",
        "youtube-direct",
    ]);
});

test("normalizeCanonicalMediaSource normalizes supported source values", () => {
    assert.equal(normalizeCanonicalMediaSource("ytmusic"), "youtube");
    assert.equal(normalizeCanonicalMediaSource("local"), "local");
    assert.equal(normalizeCanonicalMediaSource("tidal"), "tidal");
    assert.equal(normalizeCanonicalMediaSource("youtube"), "youtube");
    assert.equal(
        normalizeCanonicalMediaSource("youtube-direct"),
        "youtube-direct",
    );
    assert.equal(normalizeCanonicalMediaSource("unknown"), null);
    assert.equal(normalizeCanonicalMediaSource(null), null);
    assert.equal(normalizeCanonicalMediaSource(5), null);
});

test("resolveCanonicalMediaSource resolves explicit and inferred sources", () => {
    assert.equal(resolveCanonicalMediaSource({ mediaSource: "tidal" }), "tidal");
    assert.equal(
        resolveCanonicalMediaSource({ streamSource: "ytmusic" }),
        "youtube",
    );
    assert.equal(resolveCanonicalMediaSource({ tidalTrackId: 5 }), "tidal");
    assert.equal(
        resolveCanonicalMediaSource({ youtubeVideoId: "abc" }),
        "youtube",
    );
    assert.equal(resolveCanonicalMediaSource({}), "local");
    assert.equal(
        resolveCanonicalMediaSource({
            mediaSource: "youtube",
            streamSource: "tidal",
        }),
        "youtube",
    );
});

test("toLegacyStreamFields maps canonical identities to legacy fields", () => {
    assert.deepEqual(toLegacyStreamFields({ source: "tidal", tidalTrackId: 5 }), {
        streamSource: "tidal",
        tidalTrackId: 5,
    });
    assert.deepEqual(
        toLegacyStreamFields({ source: "youtube", youtubeVideoId: "x" }),
        {
            streamSource: "youtube",
            youtubeVideoId: "x",
        },
    );
    assert.deepEqual(
        toLegacyStreamFields({
            source: "youtube-direct",
            youtubeVideoId: "x",
            youtubeAudioFormat: "webm",
        }),
        {
            streamSource: "youtube-direct",
            youtubeVideoId: "x",
            youtubeAudioFormat: "webm",
        },
    );
    assert.deepEqual(toLegacyStreamFields({ source: "local" }), {});
    assert.deepEqual(toLegacyStreamFields(null), {});
});

test("toAudioEngineSourceType maps canonical sources to engine sources", () => {
    assert.equal(toAudioEngineSourceType("youtube"), "ytmusic");
    assert.equal(toAudioEngineSourceType("youtube-direct"), "ytmusic");
    assert.equal(toAudioEngineSourceType("local"), "local");
    assert.equal(toAudioEngineSourceType("tidal"), "tidal");
});
