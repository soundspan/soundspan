import type { PlaylistDetailTrackItem } from "@/lib/api";
import type { Track as AudioTrack } from "@/lib/audio-context";

export const TRACK_REMOVED_TOOLTIP =
    "File removed from library — restore the file to bring it back";

/** Playlist row whose track is present and currently playable. */
export interface PlayablePlaylistItem extends PlaylistDetailTrackItem {
    track: NonNullable<PlaylistDetailTrackItem["track"]>;
}

/** Returns whether a playlist row can be played right now. */
export function isPlayableTrackItem(
    item: PlaylistDetailTrackItem,
): item is PlayablePlaylistItem {
    return Boolean(item.track && item.playback?.isPlayable !== false);
}

/** Returns whether a playlist row is a locally sourced playable track. */
export function isLocalPlayableTrackItem(
    item: PlaylistDetailTrackItem,
): item is PlayablePlaylistItem {
    if (!isPlayableTrackItem(item)) return false;
    return (
        item.track.source !== "federated" &&
        (item.provider?.source || "local") === "local"
    );
}

/** Explains why a playlist row cannot be played. */
export function getUnplayableMessage(item: PlaylistDetailTrackItem): string {
    if (item.playback?.reason === "track_removed") {
        return TRACK_REMOVED_TOOLTIP;
    }
    if (item.playback?.reason === "peer_offline") {
        return "This peer is offline.";
    }
    return (
        item.playback?.message ||
        "Playback is unavailable for this track right now."
    );
}

/** Maps a playable playlist row onto the audio-context track shape. */
export function toAudioTrack(item: PlayablePlaylistItem): AudioTrack {
    const track = item.track;
    return {
        id: track.id,
        title: track.title,
        artist: {
            name: track.album.artist.name,
            id: track.album.artist.id,
        },
        album: {
            title: track.album.title,
            coverArt: track.album.coverArt || undefined,
            id: track.album.id,
        },
        duration: track.duration,
        source: track.source,
        peer: track.peer,
        ...(track.streamSource === "tidal"
            ? {
                  streamSource: "tidal" as const,
                  tidalTrackId: track.tidalTrackId,
              }
            : {}),
        ...(track.streamSource === "youtube"
            ? {
                  streamSource: "youtube" as const,
                  youtubeVideoId: track.youtubeVideoId,
              }
            : {}),
        ...(track.streamSource === "peer"
            ? { streamSource: "peer" as const }
            : {}),
    };
}
