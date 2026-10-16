"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

/** Status shape shared by the TIDAL and YouTube Music status endpoints. */
export interface RemoteProviderStatus {
    enabled: boolean;
    available: boolean;
    authenticated: boolean;
}

/** Which streaming providers the current user can play from right now. */
export interface RemoteProviderConnections {
    tidal: boolean;
    youtube: boolean;
    /** True when at least one provider is connected. */
    any: boolean;
}

const STATUS_STALE_MS = 5 * 60 * 1000;
const YT_AUTH_CHANGED_EVENT = "ytmusic-auth-changed";

/**
 * A provider is connected when it is enabled and reachable. TIDAL also needs
 * the user's own sign-in; YouTube Music streams without one.
 */
export function isRemoteProviderConnected(
    status: RemoteProviderStatus | undefined,
    requiresSignIn: boolean,
): boolean {
    if (!status?.enabled || !status.available) return false;
    return requiresSignIn ? status.authenticated : true;
}

/** Combines both provider statuses into one connection summary. */
export function deriveRemoteProviderConnections(
    tidal: RemoteProviderStatus | undefined,
    youtube: RemoteProviderStatus | undefined,
): RemoteProviderConnections {
    const tidalConnected = isRemoteProviderConnected(tidal, true);
    const youtubeConnected = isRemoteProviderConnected(youtube, false);
    return {
        tidal: tidalConnected,
        youtube: youtubeConnected,
        any: tidalConnected || youtubeConnected,
    };
}

function useRefreshYtMusicStatusOnAuthChange(): void {
    const queryClient = useQueryClient();
    useEffect(() => {
        const refresh = () => {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.ytMusicStatus(),
            });
        };
        window.addEventListener(YT_AUTH_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(YT_AUTH_CHANGED_EVENT, refresh);
    }, [queryClient]);
}

/**
 * Reports which streaming providers are connected for the current user.
 * Both report "not connected" while their status is loading.
 */
export function useRemoteProviderConnections(): RemoteProviderConnections {
    const tidalStatus = useQuery({
        queryKey: queryKeys.tidalStreamingStatus(),
        queryFn: () => api.getTidalStreamingStatus(),
        staleTime: STATUS_STALE_MS,
    });
    const ytMusicStatus = useQuery({
        queryKey: queryKeys.ytMusicStatus(),
        queryFn: () => api.getYtMusicStatus(),
        staleTime: STATUS_STALE_MS,
    });
    useRefreshYtMusicStatusOnAuthChange();
    return deriveRemoteProviderConnections(
        tidalStatus.data,
        ytMusicStatus.data,
    );
}
