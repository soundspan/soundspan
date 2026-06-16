"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

function subscribeToVisibility(onStoreChange: () => void): () => void {
    document.addEventListener("visibilitychange", onStoreChange);
    return () => {
        document.removeEventListener("visibilitychange", onStoreChange);
    };
}

function getVisibilitySnapshot(): boolean {
    return document.visibilityState === "visible";
}

function getVisibilityServerSnapshot(): boolean {
    return true;
}

/**
 * Returns true while the document is visible, re-rendering on
 * visibilitychange. Always true during SSR.
 */
export function useDocumentVisible(): boolean {
    return useSyncExternalStore(
        subscribeToVisibility,
        getVisibilitySnapshot,
        getVisibilityServerSnapshot
    );
}

/**
 * Triggers a refetch each time the document returns to visibility after
 * being hidden, so visibility-paused polls resume with fresh data.
 */
export function useRefetchOnVisible(
    enabled: boolean,
    refetch: () => Promise<unknown>
): void {
    const isDocumentVisible = useDocumentVisible();
    const wasHiddenRef = useRef(false);

    useEffect(() => {
        if (!isDocumentVisible) {
            wasHiddenRef.current = true;
            return;
        }
        if (wasHiddenRef.current && enabled) {
            wasHiddenRef.current = false;
            void refetch();
        }
    }, [isDocumentVisible, enabled, refetch]);
}
