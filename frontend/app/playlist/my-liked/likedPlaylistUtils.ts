import type { LikedPlaylistTrack } from "@/lib/api";
import type { Track as AudioTrack } from "@/lib/audio-state-context";

// Re-export the type for test convenience
export type { LikedPlaylistTrack };

/**
 * Converts a LikedPlaylistTrack to an AudioTrack for playback.
 * Preserves streaming fields (streamSource, youtubeVideoId, tidalTrackId)
 * so remote liked tracks are playable via the appropriate provider.
 */
export function toAudioTrack(track: LikedPlaylistTrack): AudioTrack {
    const streamSource =
        track.streamSource ??
        (track.source === "tidal" || track.source === "youtube"
            ? track.source
            : undefined);
    const providerTidalId =
        typeof track.provider?.tidalTrackId === "number"
            ? track.provider.tidalTrackId
            : null;
    const providerYtId =
        typeof track.provider?.youtubeVideoId === "string"
            ? track.provider.youtubeVideoId
            : null;

    return {
        id: track.id,
        title: track.title,
        artist: {
            id: track.artist.id ?? undefined,
            name: track.artist.name,
        },
        album: {
            id: track.album.id ?? undefined,
            title: track.album.title,
            coverArt: track.album.coverArt,
        },
        duration: track.duration,
        filePath: track.filePath || undefined,
        streamSource,
        youtubeVideoId: track.youtubeVideoId ?? providerYtId ?? undefined,
        tidalTrackId:
            track.tidalTrackId != null
                ? Number(track.tidalTrackId)
                : providerTidalId ?? undefined,
    };
}
