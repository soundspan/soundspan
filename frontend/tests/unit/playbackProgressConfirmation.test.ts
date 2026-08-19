import assert from "node:assert/strict";
import test from "node:test";
import {
    createPlaybackProgressConfirmationState,
    transitionPlaybackProgressConfirmation,
    type PlaybackProgressConfirmationEvent,
} from "../../lib/audio-engine/playbackProgressConfirmation";

const positionEvent = (
    currentTimeSeconds: number,
    overrides: Partial<PlaybackProgressConfirmationEvent> = {},
): PlaybackProgressConfirmationEvent => ({
    type: "position",
    mediaId: "track-1",
    currentTimeSeconds,
    isPlaying: true,
    ...overrides,
});

test("frozen positions never confirm playback", () => {
    let state = createPlaybackProgressConfirmationState();

    for (const currentTimeSeconds of [30, 30, 30, 30]) {
        const result = transitionPlaybackProgressConfirmation(
            state,
            positionEvent(currentTimeSeconds),
        );
        state = result.nextState;
        assert.equal(result.confirmed, false);
    }
});

test("strictly increasing positions confirm once cumulative movement reaches the threshold", () => {
    let state = createPlaybackProgressConfirmationState();
    const cases = [
        { currentTimeSeconds: 10, expected: false },
        { currentTimeSeconds: 10.2, expected: false },
        { currentTimeSeconds: 10.49, expected: false },
        { currentTimeSeconds: 10.5, expected: true },
        { currentTimeSeconds: 11, expected: false },
    ] as const;

    for (const testCase of cases) {
        const result = transitionPlaybackProgressConfirmation(
            state,
            positionEvent(testCase.currentTimeSeconds),
        );
        state = result.nextState;
        assert.equal(result.confirmed, testCase.expected);
    }
});

test("a seek jump re-baselines and frozen positions after it never confirm", () => {
    let state = createPlaybackProgressConfirmationState();

    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(2),
    ).nextState;
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(2.25),
    ).nextState;

    const seekResult = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(30, { type: "seek" }),
    );
    state = seekResult.nextState;
    assert.equal(seekResult.confirmed, false);

    for (const currentTimeSeconds of [30, 30]) {
        const frozenResult = transitionPlaybackProgressConfirmation(
            state,
            positionEvent(currentTimeSeconds),
        );
        state = frozenResult.nextState;
        assert.equal(frozenResult.confirmed, false);
    }
});

test("media change resets confirmation and requires a fresh baseline", () => {
    let state = createPlaybackProgressConfirmationState();

    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0),
    ).nextState;
    const firstConfirmation = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0.5),
    );
    assert.equal(firstConfirmation.confirmed, true);

    const changedMedia = transitionPlaybackProgressConfirmation(
        firstConfirmation.nextState,
        positionEvent(40, { mediaId: "track-2" }),
    );
    assert.equal(changedMedia.confirmed, false);

    const frozenChangedMedia = transitionPlaybackProgressConfirmation(
        changedMedia.nextState,
        positionEvent(40, { mediaId: "track-2" }),
    );
    assert.equal(frozenChangedMedia.confirmed, false);
});

test("repeat-one restart resets confirmation for the same media", () => {
    let state = createPlaybackProgressConfirmationState();
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0),
    ).nextState;
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0.5),
    ).nextState;

    state = createPlaybackProgressConfirmationState();
    const baseline = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0),
    );
    assert.equal(baseline.confirmed, false);
    const confirmed = transitionPlaybackProgressConfirmation(
        baseline.nextState,
        positionEvent(0.5),
    );
    assert.equal(confirmed.confirmed, true);
});

test("invalid positions and non-playing movement do not confirm", () => {
    let state = createPlaybackProgressConfirmationState();
    const cases = [
        positionEvent(Number.NaN),
        positionEvent(-1),
        positionEvent(0),
        positionEvent(1, { isPlaying: false }),
        positionEvent(1, { mediaId: null }),
    ];

    for (const event of cases) {
        const result = transitionPlaybackProgressConfirmation(state, event);
        state = result.nextState;
        assert.equal(result.confirmed, false);
    }
});
