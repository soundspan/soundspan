"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import {
    useCreateMusicRequest,
    useRequestsGate,
} from "@/hooks/useMusicRequests";
import { useStartAlbumDownload } from "@/features/album/hooks/useAlbumAcquisition";
import { submitAlbumRequest } from "@/features/album/hooks/useAlbumRequest";
import type {
    RemoteTrackAcquisition,
    RemoteTrackAcquisitionPolicy,
} from "../remoteTrackAcquisition";

/** Starts a single YouTube Music song download and reports it in a toast. */
async function startYouTubeSongDownload(
    videoId: string,
    title: string,
): Promise<void> {
    const toastId = `youtube-download-${videoId}`;
    toast.loading(`Preparing download: "${title}"...`, { id: toastId });
    try {
        const job = await api.downloadYouTube(videoId);
        if (job.status === "completed") {
            toast.info("Already downloaded — scanning library", {
                id: toastId,
                description: title,
            });
            return;
        }
        toast.success(`Downloading "${title}"`, {
            id: toastId,
            description: "It joins your library when it finishes.",
        });
    } catch {
        toast.error("Failed to start the download", {
            id: toastId,
            description: title,
        });
    }
}

/**
 * Provides the viewer's "add to library" permissions and an action runner for
 * liked streaming tracks.
 */
export function useRemoteTrackAcquisition() {
    const { downloadsEnabled } = useDownloadContext();
    const { requestsEnabled } = useRequestsGate();
    const startAlbumDownload = useStartAlbumDownload();
    const { mutateAsync: createRequest } = useCreateMusicRequest();

    const policy = useMemo<RemoteTrackAcquisitionPolicy>(
        () => ({ downloadsEnabled, requestsEnabled }),
        [downloadsEnabled, requestsEnabled],
    );

    const acquire = useCallback(
        async (action: RemoteTrackAcquisition) => {
            if (action.kind === "download-youtube") {
                await startYouTubeSongDownload(action.videoId, action.title);
                return;
            }
            const album = {
                artistName: action.artistName,
                albumTitle: action.albumTitle,
            };
            if (action.kind === "download-album") {
                await startAlbumDownload({ ...album, mbid: action.rgMbid });
                return;
            }
            await submitAlbumRequest(createRequest, {
                ...album,
                rgMbid: action.rgMbid,
            });
        },
        [createRequest, startAlbumDownload],
    );

    return { policy, acquire };
}
