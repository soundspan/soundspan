import assert from "node:assert/strict";
import test from "node:test";
import { resolveJobFailureMessage } from "@/hooks/jobStatus";

test("job failure message returns a non-empty string error verbatim", () => {
    assert.equal(resolveJobFailureMessage({ error: "Scan failed" }), "Scan failed");
});

test("job failure message falls back for an undefined result", () => {
    assert.equal(resolveJobFailureMessage(undefined), "Job failed with unknown error");
});

test("job failure message falls back when the result has no error", () => {
    assert.equal(resolveJobFailureMessage({}), "Job failed with unknown error");
});

test("job failure message falls back for non-string errors", () => {
    assert.equal(resolveJobFailureMessage({ error: 42 }), "Job failed with unknown error");
    assert.equal(resolveJobFailureMessage({ error: { message: "Failed" } }), "Job failed with unknown error");
});

test("job failure message falls back for an empty string error", () => {
    assert.equal(resolveJobFailureMessage({ error: "" }), "Job failed with unknown error");
});
