"use client";

import { useEffect, useRef } from "react";
import { resolvePollingEnabled } from "./pollingCadence";
import { useDocumentVisible } from "./useDocumentVisibility";

/**
 * Runs a fresh callback on a fixed interval only while polling is enabled and
 * the document is visible. Optionally runs once after a hidden-to-visible
 * transition; it never invokes the callback on initial mount.
 */
export function useVisibilityGatedInterval(
    callback: () => void,
    intervalMs: number,
    options: { enabled?: boolean; leadingOnVisible?: boolean } = {}
): void {
    const isDocumentVisible = useDocumentVisible();
    const enabled = resolvePollingEnabled(options.enabled);
    const leadingOnVisible = options.leadingOnVisible ?? true;
    const callbackRef = useRef(callback);
    const wasHiddenRef = useRef(false);

    useEffect(() => {
        callbackRef.current = callback;
    }, [callback]);

    useEffect(() => {
        if (!isDocumentVisible) {
            wasHiddenRef.current = true;
            return;
        }

        const returnedToVisibility = wasHiddenRef.current;
        wasHiddenRef.current = false;
        if (returnedToVisibility && enabled && leadingOnVisible) {
            callbackRef.current();
        }
    }, [enabled, isDocumentVisible, leadingOnVisible]);

    useEffect(() => {
        if (!enabled || !isDocumentVisible) {
            return;
        }

        const intervalId = window.setInterval(() => {
            callbackRef.current();
        }, intervalMs);
        return () => window.clearInterval(intervalId);
    }, [enabled, intervalMs, isDocumentVisible]);
}
