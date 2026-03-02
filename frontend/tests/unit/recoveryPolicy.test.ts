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

test("recovery policy uses server resume when local resume is zero", () => {
    const decision = resolveLocalAuthoritativeRecovery(
        {
            positionSec: 0,
            shouldPlay: true,
        },
        {
            resumeAtSec: 120,
            shouldPlay: true,
        },
    );

    assert.equal(decision.resumeAtSec, 120);
    assert.equal(decision.shouldPlay, true);
    assert.equal(decision.authority, "server");
});

test("recovery policy clamps local position to non-negative when server has no resume", () => {
    const decision = resolveLocalAuthoritativeRecovery(
        {
            positionSec: -7,
            shouldPlay: true,
        },
    );

    assert.equal(decision.resumeAtSec, 0);
    assert.equal(decision.shouldPlay, true);
    assert.equal(decision.authority, "local");
});

test("recovery policy ignores non-finite server resume values", () => {
    const decision = resolveLocalAuthoritativeRecovery(
        {
            positionSec: 0,
            shouldPlay: false,
        },
        {
            resumeAtSec: Number.POSITIVE_INFINITY,
            shouldPlay: true,
        },
    );

    assert.equal(decision.resumeAtSec, 0);
    assert.equal(decision.shouldPlay, false);
    assert.equal(decision.authority, "local");
});

test("recovery policy keeps local authority when server resume is not positive", () => {
    const decision = resolveLocalAuthoritativeRecovery(
        {
            positionSec: 0,
            shouldPlay: true,
        },
        {
            resumeAtSec: 0,
            shouldPlay: false,
        },
    );

    assert.equal(decision.resumeAtSec, 0);
    assert.equal(decision.shouldPlay, true);
    assert.equal(decision.authority, "local");
});

test("recovery policy falls back to zero if server resume changes between reads", () => {
    let readCount = 0;
    const volatileServer: { resumeAtSec?: number } = {};

    Object.defineProperty(volatileServer, "resumeAtSec", {
        get() {
            readCount += 1;
            return readCount === 1 ? 42 : undefined;
        },
    });

    const decision = resolveLocalAuthoritativeRecovery(
        {
            positionSec: 0,
            shouldPlay: true,
        },
        volatileServer,
    );

    assert.equal(decision.resumeAtSec, 0);
    assert.equal(decision.shouldPlay, true);
    assert.equal(decision.authority, "local");
    assert.equal(readCount, 2);
});
