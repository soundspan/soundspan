import test from "node:test";
import assert from "node:assert/strict";
import {
    resolveSegmentedPrewarmMaxRetries,
    shouldAttemptProactiveSegmentedHandoff,
} from "../../lib/audio-engine/segmentedStartupPolicy.ts";

test("resolveSegmentedPrewarmMaxRetries returns larger budget for startup background", () => {
    assert.equal(resolveSegmentedPrewarmMaxRetries("startup_background"), 12);
    assert.equal(resolveSegmentedPrewarmMaxRetries("next_track"), 5);
});

test("shouldAttemptProactiveSegmentedHandoff allows eligible direct-track promotion", () => {
    assert.equal(
        shouldAttemptProactiveSegmentedHandoff({
            playbackType: "track",
            isListenTogether: false,
            currentTrackId: "track-1",
            targetTrackId: "track-1",
            activeSegmentedTrackId: null,
            attemptedTrackId: null,
            isCurrentlyPlaying: true,
        }),
        true,
    );
});

test("shouldAttemptProactiveSegmentedHandoff blocks invalid promotion scenarios", () => {
    const base = {
        playbackType: "track",
        isListenTogether: false,
        currentTrackId: "track-1",
        targetTrackId: "track-1",
        activeSegmentedTrackId: null,
        attemptedTrackId: null,
        isCurrentlyPlaying: true,
    };

    assert.equal(
        shouldAttemptProactiveSegmentedHandoff({
            ...base,
            playbackType: "podcast",
        }),
        false,
    );
    assert.equal(
        shouldAttemptProactiveSegmentedHandoff({
            ...base,
            isListenTogether: true,
        }),
        false,
    );
    assert.equal(
        shouldAttemptProactiveSegmentedHandoff({
            ...base,
            currentTrackId: "other-track",
        }),
        false,
    );
    assert.equal(
        shouldAttemptProactiveSegmentedHandoff({
            ...base,
            activeSegmentedTrackId: "track-1",
        }),
        false,
    );
    assert.equal(
        shouldAttemptProactiveSegmentedHandoff({
            ...base,
            attemptedTrackId: "track-1",
        }),
        false,
    );
    assert.equal(
        shouldAttemptProactiveSegmentedHandoff({
            ...base,
            isCurrentlyPlaying: false,
        }),
        false,
    );
});
