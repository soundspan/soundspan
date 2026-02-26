import test from "node:test";
import assert from "node:assert/strict";
import {
    resolveProactiveSegmentedHandoffEligibility,
    resolveSegmentedPrewarmMaxRetries,
} from "../../lib/audio-engine/segmentedStartupPolicy.ts";

test("resolveSegmentedPrewarmMaxRetries returns larger budget for startup background", () => {
    assert.equal(resolveSegmentedPrewarmMaxRetries("startup_background"), 12);
    assert.equal(resolveSegmentedPrewarmMaxRetries("next_track"), 2);
});

test("resolveProactiveSegmentedHandoffEligibility allows eligible direct-track promotion", () => {
    const result = resolveProactiveSegmentedHandoffEligibility({
        playbackType: "track",
        isListenTogether: false,
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        activeSegmentedTrackId: null,
        attemptedTrackId: null,
    });

    assert.equal(result.eligible, true);
    assert.equal(result.reason, "eligible");
});

test("resolveProactiveSegmentedHandoffEligibility provides deterministic skip reasons", () => {
    const base = {
        playbackType: "track",
        isListenTogether: false,
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        activeSegmentedTrackId: null,
        attemptedTrackId: null,
    };

    let result = resolveProactiveSegmentedHandoffEligibility({
        ...base,
        playbackType: "podcast",
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "playback_not_track");

    result = resolveProactiveSegmentedHandoffEligibility({
        ...base,
        isListenTogether: true,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "listen_together_active");

    result = resolveProactiveSegmentedHandoffEligibility({
        ...base,
        currentTrackId: "other-track",
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "track_mismatch");

    result = resolveProactiveSegmentedHandoffEligibility({
        ...base,
        currentTrackId: null,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "track_mismatch");

    result = resolveProactiveSegmentedHandoffEligibility({
        ...base,
        activeSegmentedTrackId: "track-1",
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "already_segmented_active");

    result = resolveProactiveSegmentedHandoffEligibility({
        ...base,
        attemptedTrackId: "track-1",
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "already_attempted_this_track");
});
