"use client";

import { useInlineStatus } from "@/components/ui/InlineStatus";

/** Result shape returned by settings connection tests. */
export interface ConnectionTestResult {
    success: boolean;
    error?: string;
}

/** Message configuration for a connection-test status machine. */
export interface ConnectionTestMessages<T extends ConnectionTestResult> {
    loadingMessage?: string;
    successMessage: string | ((result: T) => string);
    failureMessage?: string;
}

/**
 * Pure mapping from a probe result to the status/message the button shows.
 * Kept side-effect free so message derivation is unit-testable.
 */
export function resolveConnectionTestOutcome<T extends ConnectionTestResult>(
    result: T,
    {
        successMessage,
        failureMessage = "Connection failed",
    }: ConnectionTestMessages<T>,
): { status: "success" | "error"; message: string } {
    if (result.success) {
        return {
            status: "success",
            message:
                typeof successMessage === "function"
                    ? successMessage(result)
                    : successMessage,
        };
    }
    return { status: "error", message: result.error || failureMessage };
}

/**
 * Shared state machine for the settings sections' "Test connection" buttons:
 * loading while the probe runs, then a success label (static or derived from
 * the probe result, e.g. a version string) or the probe's error.
 */
export function useConnectionTest<T extends ConnectionTestResult>(
    messages: ConnectionTestMessages<T>,
) {
    const { status, message, setSuccess, setError, setLoading, reset } =
        useInlineStatus();

    const runTest = async (test: () => Promise<T>): Promise<T> => {
        setLoading(messages.loadingMessage ?? "Connecting...");
        const result = await test();
        const outcome = resolveConnectionTestOutcome(result, messages);
        if (outcome.status === "success") {
            setSuccess(outcome.message);
        } else {
            setError(outcome.message);
        }
        return result;
    };

    return { status, message, runTest, reset };
}
