"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useFeatures } from "@/lib/features-context";
import { queryKeys } from "@/lib/queryKeys";

const PEER_PLAYLISTS_STALE_MS = 60_000;

/** Browses public playlists across social-scoped federation peers. */
export function usePeerPlaylists() {
    const { isAuthenticated } = useAuth();
    const { federation } = useFeatures();
    const enabled = isAuthenticated && federation;
    const query = useQuery({
        queryKey: queryKeys.peerPlaylistsBrowse(),
        queryFn: () => api.getPeerPlaylists(),
        enabled,
        staleTime: PEER_PLAYLISTS_STALE_MS,
        refetchOnWindowFocus: false,
    });
    return {
        ...query,
        playlists: query.data?.playlists ?? [],
        peerErrors: query.data?.errors ?? [],
        enabled,
    };
}

/** Fetches one peer playlist with resolved, playable track rows. */
export function usePeerPlaylist(peerId: string, remoteId: string) {
    const { isAuthenticated } = useAuth();
    const { federation } = useFeatures();
    return useQuery({
        queryKey: queryKeys.peerPlaylistDetail(peerId, remoteId),
        queryFn: () => api.getPeerPlaylist(peerId, remoteId),
        enabled: isAuthenticated && federation && !!peerId && !!remoteId,
        staleTime: PEER_PLAYLISTS_STALE_MS,
        refetchOnWindowFocus: false,
    });
}

/** Lists the caller's followed peer playlists with live state. */
export function useFollowedPeerPlaylists() {
    const { isAuthenticated } = useAuth();
    const { federation } = useFeatures();
    return useQuery({
        queryKey: queryKeys.peerPlaylistsFollowed(),
        queryFn: () => api.getFollowedPeerPlaylists(),
        enabled: isAuthenticated && federation,
        staleTime: PEER_PLAYLISTS_STALE_MS,
        refetchOnWindowFocus: false,
    });
}
