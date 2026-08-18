"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PurgeRemovedStatusResponse } from "@/lib/api";

const POLL_INTERVAL_MS = 4000;
const POLL_LIMIT = 450;

/**
 * Track removed-track purge progress: polls the purge status endpoint while
 * a sweep is queued or running, and reports the final snapshot when it
 * settles. Also detects a purge already in flight on mount (page reloads).
 */
export function usePurgeProgress(
    onSettled: (finalStatus: PurgeRemovedStatusResponse) => void,
): {
    progress: PurgeRemovedStatusResponse | null;
    startTracking: () => void;
} {
    const [progress, setProgress] = useState<PurgeRemovedStatusResponse | null>(
        null,
    );
    const [tracking, setTracking] = useState(false);
    const settledRef = useRef(onSettled);

    useEffect(() => {
        settledRef.current = onSettled;
    }, [onSettled]);

    useEffect(() => {
        let cancelled = false;
        void api
            .getPurgeRemovedStatus()
            .then((status) => {
                if (cancelled) return;
                setProgress(status);
                if (status.purging) setTracking(true);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!tracking) return;
        let cancelled = false;
        let polls = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const poll = async (): Promise<void> => {
            let status: PurgeRemovedStatusResponse;
            try {
                status = await api.getPurgeRemovedStatus();
            } catch {
                if (!cancelled) setTracking(false);
                return;
            }
            if (cancelled) return;
            setProgress(status);
            polls += 1;
            if (!status.purging || polls >= POLL_LIMIT) {
                setTracking(false);
                settledRef.current(status);
                return;
            }
            timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        };

        void poll();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [tracking]);

    const startTracking = useCallback(() => {
        setTracking(true);
    }, []);

    return { progress, startTracking };
}
