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
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollsRef = useRef(0);
    const activeRef = useRef(false);
    const settledRef = useRef(onSettled);
    settledRef.current = onSettled;

    const stop = useCallback(() => {
        activeRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const poll = useCallback(async (): Promise<void> => {
        let status: PurgeRemovedStatusResponse;
        try {
            status = await api.getPurgeRemovedStatus();
        } catch {
            stop();
            return;
        }
        if (!activeRef.current) return;
        setProgress(status);
        pollsRef.current += 1;
        if (!status.purging || pollsRef.current >= POLL_LIMIT) {
            stop();
            settledRef.current(status);
            return;
        }
        timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }, [stop]);

    const startTracking = useCallback(() => {
        if (activeRef.current) return;
        activeRef.current = true;
        pollsRef.current = 0;
        void poll();
    }, [poll]);

    useEffect(() => {
        let cancelled = false;
        void api
            .getPurgeRemovedStatus()
            .then((status) => {
                if (cancelled) return;
                setProgress(status);
                if (status.purging) startTracking();
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            stop();
        };
    }, [startTracking, stop]);

    return { progress, startTracking };
}
