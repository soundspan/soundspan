import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { AudioErrorBoundary } from "../../components/providers/AudioErrorBoundary.tsx";

type BoundaryState = {
    hasError: boolean;
    error: Error | null;
};

function setBoundaryState(
    boundary: AudioErrorBoundary,
    state: BoundaryState,
): void {
    (boundary as unknown as { state: BoundaryState }).state = state;
}

test("AudioErrorBoundary renders children when no error has been captured", () => {
    const children = React.createElement("div", null, "children");
    const boundary = new AudioErrorBoundary({ children });

    assert.equal(boundary.render(), children);
});

test("AudioErrorBoundary renders explicit fallback when error state is set", () => {
    const children = React.createElement("div", null, "children");
    const fallback = React.createElement("div", null, "fallback");
    const boundary = new AudioErrorBoundary({ children, fallback });
    setBoundaryState(boundary, { hasError: true, error: new Error("boom") });

    assert.equal(boundary.render(), fallback);
});

test("AudioErrorBoundary renders null when error state is set without fallback", () => {
    const children = React.createElement("div", null, "children");
    const boundary = new AudioErrorBoundary({ children });
    setBoundaryState(boundary, { hasError: true, error: new Error("boom") });

    assert.equal(boundary.render(), null);
});

test("AudioErrorBoundary derives error state from thrown errors", () => {
    const error = new Error("init failure");
    assert.deepEqual(AudioErrorBoundary.getDerivedStateFromError(error), {
        hasError: true,
        error,
    });
});
