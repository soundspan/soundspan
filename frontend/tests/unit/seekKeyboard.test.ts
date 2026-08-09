import assert from "node:assert/strict";
import test from "node:test";
import { resolveSeekTime } from "../../components/player/seekKeyboard";

const baseOptions = { currentTime: 30, duration: 200 };

test("arrow keys seek by the default five-second step", () => {
    assert.equal(resolveSeekTime("ArrowRight", baseOptions), 35);
    assert.equal(resolveSeekTime("ArrowUp", baseOptions), 35);
    assert.equal(resolveSeekTime("ArrowLeft", baseOptions), 25);
    assert.equal(resolveSeekTime("ArrowDown", baseOptions), 25);
});

test("page keys seek by the default ten-second large step", () => {
    assert.equal(resolveSeekTime("PageUp", baseOptions), 40);
    assert.equal(resolveSeekTime("PageDown", baseOptions), 20);
});

test("Home and End seek to the duration boundaries", () => {
    assert.equal(resolveSeekTime("Home", baseOptions), 0);
    assert.equal(resolveSeekTime("End", baseOptions), 200);
});

test("relative seeks clamp at both duration boundaries", () => {
    assert.equal(
        resolveSeekTime("ArrowLeft", { currentTime: 2, duration: 200 }),
        0,
    );
    assert.equal(
        resolveSeekTime("ArrowRight", { currentTime: 198, duration: 200 }),
        200,
    );
});

test("custom step values override the defaults", () => {
    assert.equal(
        resolveSeekTime("ArrowRight", { ...baseOptions, step: 7 }),
        37,
    );
    assert.equal(
        resolveSeekTime("PageUp", { ...baseOptions, largeStep: 25 }),
        55,
    );
});

test("unknown keys do not resolve a seek time", () => {
    assert.equal(resolveSeekTime("Enter", baseOptions), null);
});

test("invalid durations do not resolve a seek time", () => {
    for (const duration of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(resolveSeekTime("ArrowRight", { currentTime: 30, duration }), null);
    }
});

test("a non-finite current time does not resolve a seek time", () => {
    assert.equal(
        resolveSeekTime("ArrowRight", { currentTime: Number.NaN, duration: 200 }),
        null,
    );
});
