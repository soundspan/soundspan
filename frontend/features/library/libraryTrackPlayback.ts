import type { Track as AudioTrack } from "@/lib/audio-state-context";
import type { RemoteLibrarySource, Track } from "./types";

/** Returns the streaming provider behind a Library song row, if any. */
export function getRemoteLibrarySource(
    track: Pick<Track, "source" | "streamSource">,
): RemoteLibrarySource | null {
    if (track.streamSource === "tidal" || track.streamSource === "youtube") {
        return track.streamSource;
    }
    if (track.source === "tidal" || track.source === "youtube") {
        return track.source;
    }
    return null;
}

/** True for local and peer rows; false for liked TIDAL / YouTube Music rows. */
export function isLibraryTrackRow(
    track: Pick<Track, "source" | "streamSource">,
): boolean {
    return getRemoteLibrarySource(track) === null;
}

function toRemoteStreamFields(
    track: Track,
): Pick<AudioTrack, "streamSource" | "tidalTrackId" | "youtubeVideoId"> {
    const streamSource = getRemoteLibrarySource(track);
    if (!streamSource) return {};
    const tidalTrackId = track.tidalTrackId ?? track.provider?.tidalTrackId;
    const youtubeVideoId =
        track.youtubeVideoId ?? track.provider?.youtubeVideoId;
    return {
        streamSource,
        tidalTrackId:
            typeof tidalTrackId === "number" ? tidalTrackId : undefined,
        youtubeVideoId: youtubeVideoId || undefined,
    };
}

/**
 * Converts a Library song row into a playable audio track. Local, peer, and
 * liked TIDAL / YouTube Music rows all keep the fields their stream needs.
 */
export function toLibraryAudioTrack(track: Track): AudioTrack {
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        artist: {
            id: track.album?.artist?.id || undefined,
            name: track.album?.artist?.name || "Unknown Artist",
        },
        album: {
            id: track.album?.id || undefined,
            title: track.album?.title || "Unknown Album",
            coverArt: track.album?.coverArt,
            albumLoudnessLufs: track.album?.albumLoudnessLufs ?? null,
            albumTruePeakDb: track.album?.albumTruePeakDb ?? null,
        },
        source: track.source,
        peer: track.peer,
        loudnessLufs: track.loudnessLufs ?? null,
        truePeakDb: track.truePeakDb ?? null,
        ...toRemoteStreamFields(track),
    };
}
