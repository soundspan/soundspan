import assert from "node:assert/strict";
import test from "node:test";

import { vibeErrorMessage } from "../../lib/api/vibe";

function apiError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

test("maps provider-unavailable errors to configuration guidance", () => {
    assert.equal(
        vibeErrorMessage(apiError(503, "provider unavailable"), "fallback"),
        "Vibe matching is unavailable. Enable or check the DCLAP vibe provider, then try again.",
    );
});

test("maps provider timeouts to transient retry guidance", () => {
    assert.equal(
        vibeErrorMessage(apiError(504, "provider timed out"), "fallback"),
        "Vibe matching timed out. Try again in a moment.",
    );
});

test("preserves other API errors and the non-error fallback", () => {
    assert.equal(
        vibeErrorMessage(new Error("bad request"), "fallback"),
        "bad request",
    );
    assert.equal(vibeErrorMessage("unknown", "fallback"), "fallback");
});
