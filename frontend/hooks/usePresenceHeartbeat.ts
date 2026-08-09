"use client";

import { useCallback, useEffect } from "react";
import { useVisibilityGatedInterval } from "@/hooks/useVisibilityGatedInterval";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const PRESENCE_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Executes usePresenceHeartbeat.
 */
export function usePresenceHeartbeat() {
    const { isAuthenticated } = useAuth();
    const sendHeartbeat = useCallback(async () => {
        try {
            await api.post("/social/presence/heartbeat");
        } catch {
            // Intentionally silent: social presence should not interrupt playback/navigation.
        }
    }, []);

    useVisibilityGatedInterval(sendHeartbeat, PRESENCE_HEARTBEAT_INTERVAL_MS, {
        enabled: isAuthenticated,
    });

    useEffect(() => {
        if (!isAuthenticated) {
            return;
        }

        void sendHeartbeat();
    }, [isAuthenticated, sendHeartbeat]);
}
