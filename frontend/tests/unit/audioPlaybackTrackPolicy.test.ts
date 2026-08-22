import assert from "node:assert/strict";
import test from "node:test";
import {
    getNextTrackInfo,
    isLikelyTransientStreamError,
    resolveDirectTrackSourceType,
} from "../../lib/audio-engine/audioPlaybackTrackPolicy";

test("selects the next music track in queue order", () => {
    const nextTrack = getNextTrackInfo(
        [{ id: "first" }, { id: "second" }],
        0,
        false,
        [],
        "off",
    );

    assert.equal(nextTrack?.id, "second");
});

test("does not preload a podcast episode from a mixed-media queue", () => {
    const nextTrack = getNextTrackInfo(
        [{ id: "track" }, { id: "episode", itemType: "episode" }],
        0,
        false,
        [],
        "off",
    );

    assert.equal(nextTrack, null);
});

test("wraps a shuffled queue only for repeat-all playback", () => {
    const queue = [{ id: "first" }, { id: "second" }];

    assert.equal(getNextTrackInfo(queue, 0, true, [1, 0], "off"), null);
    assert.equal(getNextTrackInfo(queue, 0, true, [1, 0], "all")?.id, "second");
});

test("classifies bounded transport failures as transient", () => {
    assert.equal(
        isLikelyTransientStreamError(new Error("network timeout")),
        true,
    );
    assert.equal(
        isLikelyTransientStreamError(new Error("decode failed")),
        false,
    );
});

test("resolves peer tracks to the peer engine source type", () => {
    assert.equal(
        resolveDirectTrackSourceType({ streamSource: "peer" }),
        "peer",
    );
    assert.equal(resolveDirectTrackSourceType({}), "local");
    assert.equal(
        resolveDirectTrackSourceType({
            streamSource: "tidal",
            tidalTrackId: 42,
        }),
        "tidal",
    );
});
