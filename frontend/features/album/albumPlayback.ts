import type { Album, Track } from "./types";

/** Maps an album-page track into the player queue shape without losing provider artwork. */
export function toAlbumPlaybackTrack(track: Track, album: Album) {
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        artist: {
            name: track.artist?.name || album.artist?.name || "",
            id: track.artist?.id || album.artist?.id || "",
        },
        album: {
            title: album.title,
            id: album.id,
            coverArt:
                track.album?.coverArt ??
                track.thumbnailUrl ??
                album.coverArt ??
                album.coverUrl,
            albumLoudnessLufs: album.albumLoudnessLufs ?? null,
            albumTruePeakDb: album.albumTruePeakDb ?? null,
        },
        loudnessLufs: track.loudnessLufs ?? null,
        truePeakDb: track.truePeakDb ?? null,
        filePath: track.filePath,
        source: track.source,
        peer: track.peer,
        ...(track.streamSource === "tidal" && {
            streamSource: "tidal" as const,
            tidalTrackId: track.tidalTrackId,
        }),
        ...(track.streamSource === "youtube" && {
            streamSource: "youtube" as const,
            youtubeVideoId: track.youtubeVideoId,
        }),
        ...(track.streamSource === "peer" && {
            streamSource: "peer" as const,
        }),
    };
}
