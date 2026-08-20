import assert from "node:assert/strict";
import test from "node:test";
import {
    createPlaybackProgressConfirmationState,
    rearmPlaybackProgressConfirmationOnError,
    restartPlaybackProgressConfirmation,
    transitionPlaybackProgressConfirmation,
    type PlaybackProgressConfirmationEvent,
} from "../../lib/audio-engine/playbackProgressConfirmation";
import { createConsecutiveErrorBreaker } from "../../lib/audio-engine/consecutiveErrorBreaker";

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

test("small backward jitter preserves accumulated forward progress", () => {
    let state = createPlaybackProgressConfirmationState();
    const cases = [
        { currentTimeSeconds: 10, expected: false },
        { currentTimeSeconds: 10.3, expected: false },
        { currentTimeSeconds: 10.299, expected: false },
        { currentTimeSeconds: 10.5, expected: true },
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

test("a substantial backward observation re-baselines progress", () => {
    let state = createPlaybackProgressConfirmationState();
    const cases = [10, 10.3, 5, 5.2, 5.49];

    for (const currentTimeSeconds of cases) {
        const result = transitionPlaybackProgressConfirmation(
            state,
            positionEvent(currentTimeSeconds),
        );
        state = result.nextState;
        assert.equal(result.confirmed, false);
    }
});

test("small oscillations around a frozen position never confirm playback", () => {
    let state = createPlaybackProgressConfirmationState();

    for (const currentTimeSeconds of [10, 10.2, 10, 10.2, 10, 10.2]) {
        const result = transitionPlaybackProgressConfirmation(
            state,
            positionEvent(currentTimeSeconds),
        );
        state = result.nextState;
        assert.equal(result.confirmed, false);
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

    state = restartPlaybackProgressConfirmation("track-1");
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

test("a same-media error re-arms confirmed progress and the next real movement resets the breaker", () => {
    const breaker = createConsecutiveErrorBreaker();
    let state = restartPlaybackProgressConfirmation("track-1");
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(10),
    ).nextState;
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(10.5),
    ).nextState;
    assert.equal(state.confirmed, true);

    assert.equal(breaker.recordError(), false);
    state = rearmPlaybackProgressConfirmationOnError(state, "track-1");
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(20),
    ).nextState;
    const recovered = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(20.5),
    );
    if (recovered.confirmed) breaker.recordSuccess();

    assert.equal(recovered.confirmed, true);
    assert.equal(breaker.getErrorCount(), 0);
});

test("an error for another media item does not re-arm confirmed progress", () => {
    let state = restartPlaybackProgressConfirmation("track-1");
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0),
    ).nextState;
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0.5),
    ).nextState;

    const unchanged = rearmPlaybackProgressConfirmationOnError(
        state,
        "track-2",
    );

    assert.equal(unchanged, state);
    assert.equal(unchanged.confirmed, true);
});

test("three same-media failures separated by confirmed recoveries do not trip the breaker", () => {
    const breaker = createConsecutiveErrorBreaker();
    let state = restartPlaybackProgressConfirmation("track-1");
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0),
    ).nextState;
    state = transitionPlaybackProgressConfirmation(
        state,
        positionEvent(0.5),
    ).nextState;

    for (const baselineSeconds of [10, 20, 30]) {
        assert.equal(breaker.recordError(), false);
        state = rearmPlaybackProgressConfirmationOnError(state, "track-1");
        state = transitionPlaybackProgressConfirmation(
            state,
            positionEvent(baselineSeconds),
        ).nextState;
        const recovered = transitionPlaybackProgressConfirmation(
            state,
            positionEvent(baselineSeconds + 0.5),
        );
        state = recovered.nextState;
        assert.equal(recovered.confirmed, true);
        breaker.recordSuccess();
    }

    assert.equal(breaker.isTripped(), false);
    assert.equal(breaker.getErrorCount(), 0);
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
