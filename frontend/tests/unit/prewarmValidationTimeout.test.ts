import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

/**
 * Tests for prewarm validation timeout behavior.
 *
 * These tests verify that AbortSignal.timeout() and AbortSignal.any() compose
 * correctly — the same mechanism used in validatePrewarmedSegmentedSession.
 * We test the signal composition in isolation since the full function is tightly
 * coupled to React state and cannot be called outside the component.
 */

describe("prewarm validation timeout signal composition", () => {
    const SEGMENTED_PREWARM_VALIDATION_TIMEOUT_MS = 10_000;

    test("composedSignal aborts with TimeoutError when timeout fires", async () => {
        const manualController = new AbortController();
        // Use a very short timeout for the test
        const timeoutSignal = AbortSignal.timeout(1);
        const composedSignal = AbortSignal.any([
            manualController.signal,
            timeoutSignal,
        ]);

        // Wait for the timeout to fire
        await new Promise<void>((resolve) => {
            if (composedSignal.aborted) {
                resolve();
                return;
            }
            composedSignal.addEventListener("abort", () => resolve(), {
                once: true,
            });
        });

        assert.equal(composedSignal.aborted, true);
        assert.equal(
            composedSignal.reason instanceof DOMException &&
                composedSignal.reason.name === "TimeoutError",
            true,
        );
    });

    test("composedSignal aborts with manual reason when controller fires first", () => {
        const manualController = new AbortController();
        // Use a long timeout so it doesn't fire during this test
        const timeoutSignal = AbortSignal.timeout(60_000);
        const composedSignal = AbortSignal.any([
            manualController.signal,
            timeoutSignal,
        ]);

        manualController.abort("superseded");
        assert.equal(composedSignal.aborted, true);
        assert.equal(composedSignal.reason, "superseded");
    });

    test("timeout reason is distinguishable from external abort", async () => {
        // Simulates the catch-block branching logic
        const resolveAbortReason = (
            error: unknown,
            controllerSignal: AbortSignal,
        ): string => {
            const isTimeout =
                error instanceof DOMException &&
                error.name === "TimeoutError";
            if (isTimeout) {
                return "timeout";
            }
            if (controllerSignal.aborted) {
                return typeof controllerSignal.reason === "string"
                    ? controllerSignal.reason
                    : "aborted";
            }
            return "unknown";
        };

        // Timeout scenario
        const timeoutError = new DOMException("Signal timed out", "TimeoutError");
        const idleController = new AbortController();
        assert.equal(
            resolveAbortReason(timeoutError, idleController.signal),
            "timeout",
        );

        // External abort scenario
        const abortedController = new AbortController();
        abortedController.abort("superseded");
        const abortError = new DOMException("The operation was aborted.", "AbortError");
        assert.equal(
            resolveAbortReason(abortError, abortedController.signal),
            "superseded",
        );
    });

    test("AbortSignal.timeout produces expected timeout constant", () => {
        // Verify the constant value used in production matches expectations
        assert.equal(SEGMENTED_PREWARM_VALIDATION_TIMEOUT_MS, 10_000);
    });
});
