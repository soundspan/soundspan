import { useAudioControls } from "@/lib/audio-context";
import { shuffleArray } from "@/utils/shuffle";
import { toast } from "sonner";
import type { Album, Track } from "../types";
import { toAlbumPlaybackTrack } from "../albumPlayback";

type AudioControls = ReturnType<typeof useAudioControls>;

function requireAlbum(album: Album | null): album is Album {
    if (album) return true;
    toast.error("Album data not available");
    return false;
}

function availablePlaybackTracks(album: Album) {
    return (album.tracks || [])
        .filter((track) => track.source !== "federated" || track.peer?.online)
        .map((track) => toAlbumPlaybackTrack(track, album));
}

function playAlbum(
    album: Album | null,
    startIndex: number,
    controls: AudioControls,
): void {
    if (!requireAlbum(album)) return;
    if (!album.tracks) return;
    controls.playTracks(availablePlaybackTracks(album), startIndex);
}

function shufflePlay(album: Album | null, controls: AudioControls): void {
    if (!requireAlbum(album)) return;
    if (!album.tracks) return;
    controls.playTracks(shuffleArray(availablePlaybackTracks(album)), 0);
}

function playTrack(
    track: Track,
    album: Album | null,
    play: AudioControls["playTrack"],
): void {
    if (!requireAlbum(album)) return;
    play(toAlbumPlaybackTrack(track, album));
}

function addAllToQueue(album: Album | null, controls: AudioControls): void {
    if (!requireAlbum(album)) return;
    const tracks = (album.tracks || []).map((track) =>
        toAlbumPlaybackTrack(track, album),
    );
    if (tracks.length === 0) {
        toast.info("No tracks available to add");
        return;
    }
    controls.addTracksToQueue(tracks);
}

/** Provides focused album playback and queue operations. */
export function useAlbumPlaybackActions() {
    const controls = useAudioControls();
    return {
        playAlbum: (album: Album | null, startIndex = 0) =>
            playAlbum(album, startIndex, controls),
        shufflePlay: (album: Album | null) => shufflePlay(album, controls),
        playTrack: (track: Track, album: Album | null) =>
            playTrack(track, album, controls.playTrack),
        playTrackNow: (track: Track, album: Album | null) =>
            playTrack(track, album, controls.playNow),
        addToQueue: (track: Track, album: Album | null) =>
            playTrack(track, album, controls.addToQueue),
        addAllToQueue: (album: Album | null) => addAllToQueue(album, controls),
    };
}
