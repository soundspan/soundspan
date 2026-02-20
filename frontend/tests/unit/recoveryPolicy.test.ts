import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveLocalAuthoritativeRecovery,
} from "../../lib/audio-engine/recoveryPolicy.ts";

test("recovery policy keeps local player as authority over server hints", () => {
    const decision = resolveLocalAuthoritativeRecovery(
        {
            positionSec: 83.2,
            shouldPlay: false,
        },
        {
            resumeAtSec: 12.5,
            shouldPlay: true,
        },
    );

    assert.equal(decision.resumeAtSec, 83.2);
    assert.equal(decision.shouldPlay, false);
    assert.equal(decision.authority, "local");
});

test("recovery policy clamps local position to non-negative", () => {
    const decision = resolveLocalAuthoritativeRecovery(
        {
            positionSec: -7,
            shouldPlay: true,
        },
        {
            resumeAtSec: 120,
            shouldPlay: true,
        },
    );

    assert.equal(decision.resumeAtSec, 0);
    assert.equal(decision.shouldPlay, true);
    assert.equal(decision.authority, "local");
});
