import { resolveAcquisitionMbid } from "@/features/album/albumActionVisibility";
import { getRemoteLibrarySource } from "./libraryTrackPlayback";
import type { Track } from "./types";

/** One way to turn a liked streaming track into local files. */
export type RemoteTrackAcquisition =
    | {
          kind: "download-album" | "request-album";
          rgMbid: string;
          artistName: string;
          albumTitle: string;
      }
    | { kind: "download-youtube"; videoId: string; title: string }
    | { kind: "download-tidal"; tidalTrackId: number; title: string };

/** What the current viewer is allowed to do. */
export interface RemoteTrackAcquisitionPolicy {
    /** Admin with at least one download source configured. */
    downloadsEnabled: boolean;
    /** Admin with TIDAL set up as a download source. */
    tidalDownloadsEnabled: boolean;
    /** Non-admin with music requests turned on. */
    requestsEnabled: boolean;
}

function resolveAlbumAcquisition(
    track: Track,
    policy: RemoteTrackAcquisitionPolicy,
): RemoteTrackAcquisition | null {
    // A streaming-only album keeps its placeholder id; the background
    // MusicBrainz match is what the download and request flows can use.
    const rgMbid = resolveAcquisitionMbid({
        rgMbid: track.album?.matchedRgMbid || track.album?.rgMbid || undefined,
    });
    const albumTitle = track.album?.title;
    if (!rgMbid || !albumTitle) return null;
    const kind = policy.downloadsEnabled
        ? "download-album"
        : policy.requestsEnabled
          ? "request-album"
          : null;
    if (!kind) return null;
    return {
        kind,
        rgMbid,
        albumTitle,
        artistName: track.album?.artist?.name || "Unknown Artist",
    };
}

function resolveYouTubeAcquisition(
    track: Track,
    policy: RemoteTrackAcquisitionPolicy,
): RemoteTrackAcquisition | null {
    if (!policy.downloadsEnabled) return null;
    const videoId = track.youtubeVideoId ?? track.provider?.youtubeVideoId;
    if (!videoId) return null;
    return { kind: "download-youtube", videoId, title: track.title };
}

function resolveTidalAcquisition(
    track: Track,
    policy: RemoteTrackAcquisitionPolicy,
): RemoteTrackAcquisition | null {
    if (!policy.tidalDownloadsEnabled) return null;
    const tidalTrackId = track.tidalTrackId ?? track.provider?.tidalTrackId;
    if (typeof tidalTrackId !== "number") return null;
    return { kind: "download-tidal", tidalTrackId, title: track.title };
}

/**
 * Picks the "add to library" action for a liked streaming track. The whole
 * album is preferred when it has a real MusicBrainz id; a single song from
 * the same provider is the admin fallback.
 */
export function resolveRemoteTrackAcquisition(
    track: Track,
    policy: RemoteTrackAcquisitionPolicy,
): RemoteTrackAcquisition | null {
    const source = getRemoteLibrarySource(track);
    if (!source) return null;
    const albumAction = resolveAlbumAcquisition(track, policy);
    if (albumAction) return albumAction;
    return source === "youtube"
        ? resolveYouTubeAcquisition(track, policy)
        : resolveTidalAcquisition(track, policy);
}

/** Menu label for an acquisition action. */
export function getRemoteTrackAcquisitionLabel(
    action: RemoteTrackAcquisition,
): string {
    if (action.kind === "download-album") return "Add album to library";
    if (action.kind === "request-album") return "Request album";
    return "Add song to library";
}
