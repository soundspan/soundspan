"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const SOCIAL_POLL_ACTIVE_MS = 10_000;
const SOCIAL_POLL_IDLE_MS = 30_000;

export interface SocialListeningTrack {
    id: string;
    title: string;
    duration: number;
    artistName: string;
    albumTitle: string;
    coverArt: string | null;
}

export interface SocialOnlineUser {
    id: string;
    username: string;
    displayName: string;
    isInListenTogetherGroup: boolean;
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

export function useSocialPresence() {
    const query = useQuery<SocialOnlineResponse>({
        queryKey: ["social-presence", "online"],
        queryFn: () => api.get<SocialOnlineResponse>("/social/online"),
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: (state) => {
            const users = state.state.data?.users;
            return users && users.length > 0
                ? SOCIAL_POLL_ACTIVE_MS
                : SOCIAL_POLL_IDLE_MS;
        },
    });

    return {
        ...query,
        users: query.data?.users ?? [],
    };
}

export function useAdminConnectedUsers(enabled: boolean) {
    const query = useQuery<ConnectedUsersResponse>({
        queryKey: ["social-presence", "connected"],
        queryFn: () => api.get<ConnectedUsersResponse>("/social/connected"),
        enabled,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: (state) => {
            const users = state.state.data?.users;
            return users && users.length > 0
                ? SOCIAL_POLL_ACTIVE_MS
                : SOCIAL_POLL_IDLE_MS;
        },
    });

    return {
        ...query,
        users: query.data?.users ?? [],
    };
}
