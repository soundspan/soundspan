const test = require("node:test");
const assert = require("node:assert/strict");

const contract = require("../dist/index.js");

test("peer is a canonical media source and audio-engine source", () => {
    assert.equal(contract.CANONICAL_MEDIA_SOURCE_VALUES.includes("peer"), true);
    assert.equal(contract.normalizeCanonicalMediaSource("peer"), "peer");
    assert.equal(contract.toAudioEngineSourceType("peer"), "peer");
});

test("peer legacy stream fields remain a playback-only concern", () => {
    assert.deepEqual(contract.toLegacyStreamFields({ source: "peer" }), {
        streamSource: "peer",
    });
});
