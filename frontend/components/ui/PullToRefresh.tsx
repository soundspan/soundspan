"use client";

import { ReactNode } from "react";

interface PullToRefreshProps {
    children: ReactNode;
    threshold?: number;
}

/**
 * Pull-to-refresh has been disabled since v1.3.2 - it was blocking mobile scrolling.
 * The full implementation is preserved in git history. Re-implementation is currently
 * unscheduled. Notes for whoever revives it:
 *   1) h-full breaks flex layout - use "relative flex-1 flex flex-col min-h-0" instead
 *   2) Touch handlers may interfere with normal scroll
 */
export function PullToRefresh({ children }: PullToRefreshProps) {
    return <>{children}</>;
}
