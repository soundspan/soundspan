"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { resolvePollingJitter } from "@/hooks/pollingCadence";
import { useVisibilityGatedInterval } from "@/hooks/useVisibilityGatedInterval";

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Polls the backend for the count of active Listen Together groups.
 * Returns whether any sessions are currently active.
 */
export function useActiveListenSessions(): boolean {
    const { isAuthenticated } = useAuth();
    const [hasActiveSessions, setHasActiveSessions] = useState(false);
    const [jitterElapsed, setJitterElapsed] = useState(false);
    const mountedRef = useRef(true);

    const fetchCount = useCallback(async () => {
        try {
            const data = await api.getActiveListenGroupCount();
            if (mountedRef.current) {
                setHasActiveSessions((data?.count ?? 0) > 0);
            }
        } catch {
            // Silently fail — sidebar indicator is optional
        }
    }, []);

    useVisibilityGatedInterval(fetchCount, POLL_INTERVAL_MS, {
        enabled: isAuthenticated && jitterElapsed,
    });

    useEffect(() => {
        mountedRef.current = true;
        setJitterElapsed(false);

        if (!isAuthenticated) {
            return () => {
                mountedRef.current = false;
            };
        }

        // Defer initial fetch to avoid synchronous setState in effect body
        const initialTimeout = setTimeout(() => fetchCount(), 0);

        // Start polling with jitter to prevent alignment with other intervals
        const jitterDelay = resolvePollingJitter(5000);
        const jitterTimeout = setTimeout(() => {
            setJitterElapsed(true);
        }, jitterDelay);

        return () => {
            mountedRef.current = false;
            clearTimeout(initialTimeout);
            clearTimeout(jitterTimeout);
        };
    }, [isAuthenticated, fetchCount]);

    return hasActiveSessions;
}
