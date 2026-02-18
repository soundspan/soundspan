"use client";

import { ReactNode } from "react";

interface PullToRefreshProps {
    children: ReactNode;
    threshold?: number;
}

/**
 * HOTFIX v1.3.2: Pull-to-refresh temporarily disabled - was blocking mobile scrolling
 * TODO: Re-implement in v1.4 with fixes:
 *   1) h-full breaks flex layout - use "relative flex-1 flex flex-col min-h-0" instead
 *   2) Touch handlers may interfere with normal scroll
 * See git history for full implementation.
 */
export function PullToRefresh({ children }: PullToRefreshProps) {
    return <>{children}</>;
}
