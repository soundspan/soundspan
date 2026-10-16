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
import type { CreateMusicRequestInput } from "@/lib/api/requests";

/** Submits one album request and reports the outcome in a toast. */
export async function submitAlbumRequest(
    createRequest: (input: CreateMusicRequestInput) => Promise<unknown>,
    input: CreateMusicRequestInput,
): Promise<void> {
    const toastId = `music-request-${input.rgMbid}`;
    toast.loading(`Requesting ${input.albumTitle}...`, { id: toastId });
    try {
        await createRequest(input);
        toast.success(
            `Requested ${input.albumTitle} — an admin will review it`,
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
}

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
        await submitAlbumRequest(create.mutateAsync, {
            artistName: album.artist?.name || "Unknown Artist",
            albumTitle: album.title,
            rgMbid,
            ...(album.artist?.mbid ? { artistMbid: album.artist.mbid } : {}),
        });
    };

    return {
        requestsEnabled,
        isRequestedAlbum,
        isSubmittingRequest: create.isPending,
        requestAlbum,
    };
}
