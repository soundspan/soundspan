"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const PRESENCE_HEARTBEAT_INTERVAL_MS = 25_000;

export function usePresenceHeartbeat() {
    const { isAuthenticated } = useAuth();

    useEffect(() => {
        if (!isAuthenticated) {
            return;
        }

        const sendHeartbeat = async () => {
            try {
                await api.post("/social/presence/heartbeat");
            } catch {
                // Intentionally silent: social presence should not interrupt playback/navigation.
            }
        };

        void sendHeartbeat();

        const intervalId = setInterval(() => {
            void sendHeartbeat();
        }, PRESENCE_HEARTBEAT_INTERVAL_MS);

        const handleVisibilityChange = () => {
            if (!document.hidden) {
                void sendHeartbeat();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            clearInterval(intervalId);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange
            );
        };
    }, [isAuthenticated]);
}

