import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
    consumePlaybackAdvanceOrigin,
    playbackAdvanceOriginRef,
    writePlaybackAdvanceOrigin,
} from "@/lib/audio-engine/playbackAdvanceOrigin";

describe("playback advance origin", () => {
    afterEach(() => {
        playbackAdvanceOriginRef.current = null;
    });

    it("lets a manual action replace an outstanding error marker", () => {
        writePlaybackAdvanceOrigin("error", "track-a");
        writePlaybackAdvanceOrigin("manual", "track-b");

        assert.deepEqual(consumePlaybackAdvanceOrigin(), {
            origin: "manual",
            originatingTrackId: "track-b",
        });
    });

    it("consumes an error marker exactly once", () => {
        writePlaybackAdvanceOrigin("error", "track-a");

        assert.deepEqual(consumePlaybackAdvanceOrigin(), {
            origin: "error",
            originatingTrackId: "track-a",
        });
        assert.equal(consumePlaybackAdvanceOrigin(), null);
    });
});
