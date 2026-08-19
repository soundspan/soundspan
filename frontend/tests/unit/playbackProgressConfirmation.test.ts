import assert from "node:assert/strict";
import test from "node:test";
import { shouldConfirmPlaybackProgress } from "../../lib/audio-engine/playbackProgressConfirmation";

const cases = [
    {
        name: "does not confirm below the progress threshold",
        lastConfirmedMediaId: null,
        currentMediaId: "track-1",
        currentTimeSeconds: 0.49,
        isPlaying: true,
        expected: false,
    },
    {
        name: "confirms when progress reaches the threshold",
        lastConfirmedMediaId: null,
        currentMediaId: "track-1",
        currentTimeSeconds: 0.5,
        isPlaying: true,
        expected: true,
    },
    {
        name: "does not confirm a paused media item",
        lastConfirmedMediaId: null,
        currentMediaId: "track-1",
        currentTimeSeconds: 0.5,
        isPlaying: false,
        expected: false,
    },
    {
        name: "does not confirm the same media twice",
        lastConfirmedMediaId: "track-1",
        currentMediaId: "track-1",
        currentTimeSeconds: 5,
        isPlaying: true,
        expected: false,
    },
    {
        name: "re-arms confirmation when the media changes",
        lastConfirmedMediaId: "track-1",
        currentMediaId: "track-2",
        currentTimeSeconds: 0.5,
        isPlaying: true,
        expected: true,
    },
    {
        name: "does not confirm zero progress",
        lastConfirmedMediaId: null,
        currentMediaId: "track-1",
        currentTimeSeconds: 0,
        isPlaying: true,
        expected: false,
    },
    {
        name: "does not confirm non-finite progress",
        lastConfirmedMediaId: null,
        currentMediaId: "track-1",
        currentTimeSeconds: Number.NaN,
        isPlaying: true,
        expected: false,
    },
] as const;

for (const testCase of cases) {
    test(testCase.name, () => {
        assert.equal(
            shouldConfirmPlaybackProgress(
                testCase.lastConfirmedMediaId,
                testCase.currentMediaId,
                testCase.currentTimeSeconds,
                testCase.isPlaying,
            ),
            testCase.expected,
        );
    });
}

test("crossing the threshold confirms a media item only once", () => {
    let lastConfirmedMediaId: string | null = null;

    assert.equal(
        shouldConfirmPlaybackProgress(
            lastConfirmedMediaId,
            "track-1",
            0.49,
            true,
        ),
        false,
    );
    assert.equal(
        shouldConfirmPlaybackProgress(
            lastConfirmedMediaId,
            "track-1",
            0.5,
            true,
        ),
        true,
    );

    lastConfirmedMediaId = "track-1";
    assert.equal(
        shouldConfirmPlaybackProgress(lastConfirmedMediaId, "track-1", 1, true),
        false,
    );
});

test("repeat-one re-arms only after the restarted media progresses", () => {
    assert.equal(
        shouldConfirmPlaybackProgress("track-1", "track-1", 0.5, true),
        false,
    );
    const restartedLastConfirmedMediaId = null;
    assert.equal(
        shouldConfirmPlaybackProgress(
            restartedLastConfirmedMediaId,
            "track-1",
            0,
            true,
        ),
        false,
    );
    assert.equal(
        shouldConfirmPlaybackProgress(
            restartedLastConfirmedMediaId,
            "track-1",
            0.5,
            true,
        ),
        true,
    );
});
