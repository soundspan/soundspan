"use client";

import { toast } from "sonner";
import {
    openRequestRgMbids,
    useCreateMusicRequest,
    useMyMusicRequests,
    useRequestsGate,
} from "@/hooks/useMusicRequests";
import { isRequestableMbid } from "@/lib/musicRequests";
import type { Album } from "../types";

/**
 * Request-flow state for the artist page's album grids: which albums the
 * caller may request, which already carry an open request, and a
 * toast-wrapped submit. Closed for admins and anonymous viewers.
 */
export function useArtistAlbumRequests(artistName: string) {
    const { requestsEnabled } = useRequestsGate();
    const myRequests = useMyMusicRequests(requestsEnabled);
    const create = useCreateMusicRequest();
    const openRgMbids = openRequestRgMbids(myRequests.data);

    const albumRgMbid = (album: Album): string | null => {
        const candidate = album.rgMbid || album.mbid || null;
        return isRequestableMbid(candidate) ? candidate : null;
    };

    const isRequestedAlbum = (album: Album): boolean => {
        const rgMbid = albumRgMbid(album);
        return Boolean(rgMbid && openRgMbids.has(rgMbid.toLowerCase()));
    };

    const requestAlbum = async (album: Album): Promise<void> => {
        const rgMbid = albumRgMbid(album);
        if (!rgMbid || create.isPending) return;
        const toastId = `music-request-${rgMbid}`;
        toast.loading(`Requesting ${album.title}...`, { id: toastId });
        try {
            await create.mutateAsync({
                artistName,
                albumTitle: album.title,
                rgMbid,
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
        isRequestableAlbum: (album: Album) => albumRgMbid(album) !== null,
        isRequestedAlbum,
        isSubmittingRequest: create.isPending,
        requestAlbum,
    };
}
