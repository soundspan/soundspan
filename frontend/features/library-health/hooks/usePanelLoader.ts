"use client";

import { useCallback, useRef, useState } from "react";

export interface PanelLoaderState<T> {
    data: T | null;
    isLoading: boolean;
    error: string | null;
    load: () => void;
}

/**
 * Lazy loader for one dashboard drill-down panel: nothing is fetched until
 * the first load() call, and stale responses from superseded loads are
 * dropped so rapid re-loads cannot render out of order.
 */
export function usePanelLoader<T>(
    fetcher: () => Promise<T>,
    errorMessage: string,
): PanelLoaderState<T> {
    const [data, setData] = useState<T | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const loadSequence = useRef(0);

    const load = useCallback(() => {
        loadSequence.current += 1;
        const sequence = loadSequence.current;
        setIsLoading(true);
        setError(null);
        void fetcher()
            .then((value) => {
                if (sequence !== loadSequence.current) return;
                setData(value);
            })
            .catch(() => {
                if (sequence !== loadSequence.current) return;
                setError(errorMessage);
            })
            .finally(() => {
                if (sequence !== loadSequence.current) return;
                setIsLoading(false);
            });
    }, [fetcher, errorMessage]);

    return { data, isLoading, error, load };
}
