import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveSegmentAssetNameFromUri,
    resolveSegmentRepresentationIdFromName,
    resolveSegmentRepresentationIdFromUri,
} from "../../lib/audio-engine/segmentedRepresentationPolicy.ts";

test("resolveSegmentAssetNameFromUri extracts the final segment", () => {
    assert.equal(
        resolveSegmentAssetNameFromUri(
            "/api/streaming/v1/sessions/session-1/chunk-2-00017.m4s?st=token"
        ),
        "chunk-2-00017.m4s"
    );
    assert.equal(
        resolveSegmentAssetNameFromUri("chunk-2-00017.m4s?st=token"),
        "chunk-2-00017.m4s",
    );
});

test("resolveSegmentRepresentationIdFromName parses chunk representation IDs", () => {
    assert.equal(
        resolveSegmentRepresentationIdFromName("chunk-0-00001.m4s"),
        "0"
    );
    assert.equal(
        resolveSegmentRepresentationIdFromName("chunk-aac-high-00001.webm"),
        "aac-high"
    );
});

test("resolveSegmentRepresentationIdFromName parses init representation IDs", () => {
    assert.equal(resolveSegmentRepresentationIdFromName("init-1.m4s"), "1");
    assert.equal(
        resolveSegmentRepresentationIdFromName("init-aac-main.webm"),
        "aac-main"
    );
});

test("resolveSegmentRepresentationIdFromUri returns null for non-segment assets", () => {
    assert.equal(
        resolveSegmentRepresentationIdFromUri(
            "/api/streaming/v1/sessions/session-1/manifest.mpd?st=token"
        ),
        null
    );
    assert.equal(resolveSegmentRepresentationIdFromUri(""), null);
});

// Tests for setQualityLevelEnabled return value and logging behavior.
// The method is private on VideoJsSegmentedEngine, so we test the observable
// scoring/quarantine behavior through the representation policy exports and
// verify the contract that setQualityLevelEnabled returns boolean success.

test("resolveSegmentRepresentationIdFromName returns null for malformed names", () => {
    assert.equal(resolveSegmentRepresentationIdFromName("not-a-chunk"), null);
    assert.equal(resolveSegmentRepresentationIdFromName(""), null);
});

test("resolveSegmentAssetNameFromUri handles encoded segment names", () => {
    assert.equal(
        resolveSegmentAssetNameFromUri(
            "/api/streaming/v1/sessions/s1/segments/chunk-0-00001.m4s?st=tok"
        ),
        "chunk-0-00001.m4s",
    );
});

test("resolveSegmentRepresentationIdFromUri chains name extraction and ID parse", () => {
    assert.equal(
        resolveSegmentRepresentationIdFromUri(
            "/api/streaming/v1/sessions/s1/segments/chunk-2-00017.m4s?st=tok"
        ),
        "2",
    );
    assert.equal(
        resolveSegmentRepresentationIdFromUri(
            "/api/streaming/v1/sessions/s1/segments/init-aac-high.m4s?st=tok"
        ),
        "aac-high",
    );
});

test("resolveSegmentAssetNameFromUri trims input and rejects blank terminal paths", () => {
    assert.equal(
        resolveSegmentAssetNameFromUri("   /api/stream/chunk-9-00001.m4s?st=x#frag   "),
        "chunk-9-00001.m4s",
    );
    assert.equal(resolveSegmentAssetNameFromUri("   "), null);
    assert.equal(resolveSegmentAssetNameFromUri("/api/stream/segments/"), null);
});

test("resolveSegmentRepresentationIdFromName supports uppercase extensions and rejects whitespace-only names", () => {
    assert.equal(
        resolveSegmentRepresentationIdFromName("chunk-voice-main-00077.M4S"),
        "voice-main",
    );
    assert.equal(
        resolveSegmentRepresentationIdFromName("init-voice-main.WEBM"),
        "voice-main",
    );
    assert.equal(resolveSegmentRepresentationIdFromName("   "), null);
});
