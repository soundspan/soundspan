import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCompensatedTargetMs } from "../../lib/listenTogetherPlaybackSync";

test("compensation subtracts positive client clock skew", () => {
    const targetMs = computeCompensatedTargetMs(
        2_000,
        9_000,
        13_000,
        3_000,
        5_000,
    );

    assert.equal(targetMs, 3_000);
});

test("compensation floors negative age and caps network delay", () => {
    assert.equal(
        computeCompensatedTargetMs(2_000, 10_000, 9_000, 0, 5_000),
        2_000,
    );
    assert.equal(
        computeCompensatedTargetMs(2_000, 1_000, 10_000, 0, 5_000),
        7_000,
    );
});
