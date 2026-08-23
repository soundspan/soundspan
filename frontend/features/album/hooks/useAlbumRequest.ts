"use client";

import { toast } from "sonner";
import {
    openRequestRgMbids,
    useCreateMusicRequest,
    useMyMusicRequests,
    useRequestsGate,
} from "@/hooks/useMusicRequests";
import { isSyntheticRgMbid } from "../albumActionVisibility";
import type { Album } from "../types";

/**
 * Request-flow state and submit action for the album page. Only meaningful
 * for non-admin viewers; the gate stays closed for everyone else.
 */
export function useAlbumRequest(album: Album | null | undefined) {
    const { requestsEnabled } = useRequestsGate();
    const myRequests = useMyMusicRequests(requestsEnabled);
    const create = useCreateMusicRequest();

    const candidate = album?.rgMbid || album?.mbid || null;
    const rgMbid =
        candidate && !isSyntheticRgMbid(candidate) ? candidate : null;
    const isRequestedAlbum = Boolean(
        rgMbid && openRequestRgMbids(myRequests.data).has(rgMbid.toLowerCase()),
    );

    const requestAlbum = async () => {
        if (!album || !rgMbid || create.isPending) return;
        const toastId = `music-request-${rgMbid}`;
        toast.loading(`Requesting ${album.title}...`, { id: toastId });
        try {
            await create.mutateAsync({
                artistName: album.artist?.name || "Unknown Artist",
                albumTitle: album.title,
                rgMbid,
                ...(album.artist?.mbid
                    ? { artistMbid: album.artist.mbid }
                    : {}),
            });
            toast.success(
                `Requested ${album.title} — an admin will review it`,
                { id: toastId },
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to submit the request",
                { id: toastId },
            );
        }
    };

    return {
        requestsEnabled,
        isRequestedAlbum,
        isSubmittingRequest: create.isPending,
        requestAlbum,
    };
}
