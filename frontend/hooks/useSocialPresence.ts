"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { socialPresenceSocket } from "@/lib/social-presence-socket";
import {
    resolveAdaptivePollingInterval,
    resolvePollingEnabled,
} from "@/hooks/pollingCadence";

const SOCIAL_POLL_ACTIVE_MS = 10_000;
const SOCIAL_POLL_IDLE_MS = 30_000;
const SOCIAL_PUSH_INVALIDATION_THROTTLE_MS = 1_500;
const SOCIAL_ONLINE_QUERY_KEY = ["social-presence", "online"] as const;
const SOCIAL_CONNECTED_QUERY_KEY = ["social-presence", "connected"] as const;

export interface SocialListeningTrack {
    id: string;
    title: string;
    duration: number;
    artistName: string;
    artistId: string | null;
    albumTitle: string;
    albumId: string | null;
    coverArt: string | null;
}

export type SocialListeningStatus = "playing" | "paused" | "idle";

export interface SocialOnlineUser {
    id: string;
    username: string;
    displayName: string;
    isInListenTogetherGroup: boolean;
    listeningStatus: SocialListeningStatus;
    listeningTrack: SocialListeningTrack | null;
    lastHeartbeatAt: string;
}

export interface AdminConnectedUser {
    id: string;
    username: string;
    displayName: string;
    role: "user" | "admin";
    shareOnlinePresence: boolean;
    shareListeningStatus: boolean;
    lastHeartbeatAt: string;
}

interface SocialOnlineResponse {
    users: SocialOnlineUser[];
}

interface ConnectedUsersResponse {
    users: AdminConnectedUser[];
}

interface SocialPresenceOptions {
    enabled?: boolean;
}

function useSocialPresencePushInvalidation(
    enabled: boolean,
    queryKey:
        | typeof SOCIAL_ONLINE_QUERY_KEY
        | typeof SOCIAL_CONNECTED_QUERY_KEY
) {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const lastInvalidatedAtRef = useRef(0);

    useEffect(() => {
        if (!enabled || !isAuthenticated) {
            return;
        }

        return socialPresenceSocket.subscribe(() => {
            const nowMs = Date.now();
            if (
                nowMs - lastInvalidatedAtRef.current <
                SOCIAL_PUSH_INVALIDATION_THROTTLE_MS
            ) {
                return;
            }

            lastInvalidatedAtRef.current = nowMs;
            void queryClient.invalidateQueries({
                queryKey,
                refetchType: "active",
            });
        });
    }, [enabled, isAuthenticated, queryClient, queryKey]);
}

export function useSocialPresence(options: SocialPresenceOptions = {}) {
    const enabled = resolvePollingEnabled(options.enabled);
    useSocialPresencePushInvalidation(enabled, SOCIAL_ONLINE_QUERY_KEY);
    const query = useQuery<SocialOnlineResponse>({
        queryKey: SOCIAL_ONLINE_QUERY_KEY,
        queryFn: () => api.get<SocialOnlineResponse>("/social/online"),
        enabled,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: (state) => {
            const users = state.state.data?.users;
            return resolveAdaptivePollingInterval({
                enabled,
                hasActiveItems: (users?.length ?? 0) > 0,
                activeIntervalMs: SOCIAL_POLL_ACTIVE_MS,
                idleIntervalMs: SOCIAL_POLL_IDLE_MS,
            });
        },
    });

    return {
        ...query,
        users: query.data?.users ?? [],
    };
}

export function useAdminConnectedUsers(enabled: boolean) {
    useSocialPresencePushInvalidation(enabled, SOCIAL_CONNECTED_QUERY_KEY);
    const query = useQuery<ConnectedUsersResponse>({
        queryKey: SOCIAL_CONNECTED_QUERY_KEY,
        queryFn: () => api.get<ConnectedUsersResponse>("/social/connected"),
        enabled,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: (state) => {
            const users = state.state.data?.users;
            return resolveAdaptivePollingInterval({
                enabled,
                hasActiveItems: (users?.length ?? 0) > 0,
                activeIntervalMs: SOCIAL_POLL_ACTIVE_MS,
                idleIntervalMs: SOCIAL_POLL_IDLE_MS,
            });
        },
    });

    return {
        ...query,
        users: query.data?.users ?? [],
    };
}
