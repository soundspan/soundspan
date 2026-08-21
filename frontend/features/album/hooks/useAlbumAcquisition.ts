import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { toast } from "sonner";
import type { Album } from "../types";
import { resolveAcquisitionMbid } from "../albumActionVisibility";

interface AlbumAcquisitionRequest {
    artistName: string;
    albumTitle: string;
    mbid: string;
}

function getAlbumAcquisitionRequest(
    album: Album | null,
): AlbumAcquisitionRequest | null {
    if (!album) {
        toast.error("Album data not available");
        return null;
    }
    const mbid = resolveAcquisitionMbid(album);
    if (!mbid) {
        toast.error("Album MBID not available");
        return null;
    }
    return {
        artistName: album.artist?.name || "Unknown Artist",
        albumTitle: album.title,
        mbid,
    };
}

async function startAlbumDownload(
    request: AlbumAcquisitionRequest,
    addPendingDownload: ReturnType<
        typeof useDownloadContext
    >["addPendingDownload"],
): Promise<void> {
    addPendingDownload("album", request.albumTitle, request.mbid);
    toast.loading(`Preparing download: "${request.albumTitle}"...`, {
        id: `download-${request.mbid}`,
    });
    try {
        await api.downloadAlbum(
            request.artistName,
            request.albumTitle,
            request.mbid,
        );
        toast.success(`Downloading "${request.albumTitle}"`, {
            id: `download-${request.mbid}`,
        });
    } catch {
        toast.error("Failed to start album download", {
            id: `download-${request.mbid}`,
        });
    }
}

/** Provides album acquisition with synthetic-MBID rejection. */
export function useAlbumAcquisition() {
    const { addPendingDownload, isPendingByMbid } = useDownloadContext();
    return async (album: Album | null, event?: React.MouseEvent) => {
        event?.stopPropagation();
        const request = getAlbumAcquisitionRequest(album);
        if (!request) return;
        if (isPendingByMbid(request.mbid)) {
            toast.info("Album is already being downloaded");
            return;
        }
        await startAlbumDownload(request, addPendingDownload);
    };
}
