"use client";

import { useCallback, useEffect, useState } from "react";
import { usePanelLoader, type PanelLoaderState } from "./usePanelLoader";

export interface InsightPanelLoaderState<T> extends PanelLoaderState<T> {
    /** Wire to InsightPanel.onFirstExpand; arms the loader effect. */
    onFirstExpand: () => void;
}

/**
 * Panel loader driven by expansion state: nothing is fetched until the panel
 * first expands, the panel refetches whenever its fetcher changes (tab or
 * filter selection), and a section-level refreshToken bump reloads every
 * panel that has been expanded.
 */
export function useInsightPanelLoader<T>(
    fetcher: () => Promise<T>,
    errorMessage: string,
    refreshToken: number,
): InsightPanelLoaderState<T> {
    const page = usePanelLoader(fetcher, errorMessage);
    const [hasExpanded, setHasExpanded] = useState(false);
    const { load } = page;

    useEffect(() => {
        if (hasExpanded) load();
    }, [hasExpanded, load, refreshToken]);

    const onFirstExpand = useCallback(() => {
        setHasExpanded(true);
    }, []);

    return { ...page, onFirstExpand };
}
