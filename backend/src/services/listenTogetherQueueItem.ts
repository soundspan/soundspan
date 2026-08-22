/**
 * Shared queue-item shape for Listen Together group state.
 *
 * Extracted from listenTogetherManager.ts (which re-exports it) so the
 * manager stays inside its file-size baseline.
 */

import type {
    CanonicalMediaProviderIdentity,
    CanonicalMediaSource,
    RemoteMediaSource,
    ResolvedMediaSource,
} from "@soundspan/media-metadata-contract";

export interface SyncQueueItem {
    id: string;
    title: string;
    duration: number;
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    artist: { id: string; name: string };
    album: {
        id: string;
        title: string;
        coverArt: string | null;
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
    };
    mediaSource?: CanonicalMediaSource;
    provider?: CanonicalMediaProviderIdentity;
    streamSource?: RemoteMediaSource;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    /** Audio container hint for "youtube-direct" streams (webm for opus, mp4 for AAC). */
    youtubeAudioFormat?: "mp4" | "webm";
    localTrackId?: string;
    trackTidalId?: string;
    trackYtMusicId?: string;
    trackMappingId?: string;
    originSource?: ResolvedMediaSource;
    /** Current owning-peer reachability captured when the queue item was built. */
    peerOnline?: boolean;
}
