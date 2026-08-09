import assert from "node:assert/strict";
import test from "node:test";
import { isAuthExpiryError } from "../../lib/audio-state-context";

test("detects authentication expiry from an HTTP 401 status", () => {
    const apiError = new Error("Session expired");
    (apiError as Error & { status: number }).status = 401;

    assert.equal(isAuthExpiryError({ status: 401 }), true);
    assert.equal(isAuthExpiryError(apiError), true);
});

test("rejects non-401 and unstructured errors", () => {
    assert.equal(isAuthExpiryError({ status: 500 }), false);
    assert.equal(isAuthExpiryError(new Error("Not authenticated")), false);
    assert.equal(isAuthExpiryError(null), false);
    assert.equal(isAuthExpiryError(undefined), false);
    assert.equal(isAuthExpiryError("401"), false);
    assert.equal(isAuthExpiryError(401), false);
});
