import assert from "node:assert/strict";
import { test, describe } from "node:test";

// These tests verify the pure logic patterns used by useTrackPreview
// without importing the hook itself (which depends on React, Audio, toast, etc.)

// ── isAbortError detection ──────────────────────────────────────

// Reproduced from useTrackPreview.ts to test in isolation
function isAbortError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    const code = typeof e.code === "number" ? e.code : undefined;
    const message = typeof e.message === "string" ? e.message : "";
    return (
        name === "AbortError" ||
        code === 20 ||
        message.includes("interrupted by a call to pause")
    );
}

describe("isAbortError", () => {
    test("detects AbortError by name", () => {
        const err = new DOMException("The play() request was interrupted", "AbortError");
        assert.ok(isAbortError(err));
    });

    test("detects abort by code 20", () => {
        const err = { code: 20, message: "aborted" };
        assert.ok(isAbortError(err));
    });

    test("detects abort by message pattern", () => {
        const err = new Error("The play() request was interrupted by a call to pause()");
        assert.ok(isAbortError(err));
    });

    test("returns false for regular errors", () => {
        assert.ok(!isAbortError(new Error("Network error")));
    });

    test("returns false for null/undefined", () => {
        assert.ok(!isAbortError(null));
        assert.ok(!isAbortError(undefined));
    });

    test("returns false for non-object values", () => {
        assert.ok(!isAbortError("string error"));
        assert.ok(!isAbortError(42));
    });

    test("returns false for empty object", () => {
        assert.ok(!isAbortError({}));
    });
});

// ── No-preview deduplication ────────────────────────────────────

describe("no-preview deduplication", () => {
    test("Set-based deduplication prevents repeat toasts", () => {
        const shown = new Set<string>();
        const toastCalls: string[] = [];

        function showNoPreviewToast(trackId: string) {
            if (shown.has(trackId)) return;
            shown.add(trackId);
            toastCalls.push(trackId);
        }

        showNoPreviewToast("track-1");
        showNoPreviewToast("track-1"); // duplicate
        showNoPreviewToast("track-2");
        showNoPreviewToast("track-1"); // duplicate again

        assert.equal(toastCalls.length, 2);
        assert.deepEqual(toastCalls, ["track-1", "track-2"]);
    });
});

// ── videoId response handling ───────────────────────────────────

describe("videoId response flow", () => {
    test("null videoId is treated as no-preview", () => {
        const response = { videoId: null as string | null };
        const hasPreview = !!response.videoId;
        assert.equal(hasPreview, false);
    });

    test("empty string videoId is treated as no-preview", () => {
        const response = { videoId: "" };
        const hasPreview = !!response.videoId;
        assert.equal(hasPreview, false);
    });

    test("valid videoId is treated as preview-available", () => {
        const response = { videoId: "dQw4w9WgXcQ" };
        const hasPreview = !!response.videoId;
        assert.equal(hasPreview, true);
    });
});

// ── Preview-not-found error detection ───────────────────────────

describe("preview-not-found error detection", () => {
    function isPreviewNotFoundError(error: unknown): boolean {
        if (typeof error !== "object" || error === null) return false;
        const e = error as Record<string, unknown>;
        return (
            e.error === "Preview not found" ||
            /preview not found/i.test(String(e.message || ""))
        );
    }

    test("detects { error: 'Preview not found' } response", () => {
        assert.ok(isPreviewNotFoundError({ error: "Preview not found" }));
    });

    test("detects { message: 'Preview not found' } response", () => {
        assert.ok(isPreviewNotFoundError({ message: "Preview not found" }));
    });

    test("case insensitive message match", () => {
        assert.ok(isPreviewNotFoundError({ message: "PREVIEW NOT FOUND" }));
    });

    test("does not match unrelated errors", () => {
        assert.ok(!isPreviewNotFoundError({ error: "Server error" }));
        assert.ok(!isPreviewNotFoundError(new Error("timeout")));
    });

    test("returns false for non-objects", () => {
        assert.ok(!isPreviewNotFoundError(null));
        assert.ok(!isPreviewNotFoundError("string"));
    });
});

// ── Request ID stale-check logic ────────────────────────────────

describe("request ID stale-check", () => {
    test("stale request is detected when ID has advanced", () => {
        let currentRequestId = 0;

        const requestId1 = ++currentRequestId; // 1
        const requestId2 = ++currentRequestId; // 2

        // requestId1 is now stale because currentRequestId moved to 2
        assert.notEqual(requestId1, currentRequestId);
        assert.equal(requestId2, currentRequestId);
    });
});
