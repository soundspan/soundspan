import type { SpotifyTrack } from "../spotify";

/**
 * Spotify Import Service
 *
 * Handles matching Spotify tracks to local library and managing imports
 */

export interface MatchedTrack {
    spotifyTrack: SpotifyTrack;
    localTrack: {
        id: string;
        title: string;
        albumId: string;
        albumTitle: string;
        artistName: string;
    } | null;
    matchType: "exact" | "fuzzy" | "none";
    matchConfidence: number; // 0-100
}

export interface AlbumToDownload {
    spotifyAlbumId: string;
    albumName: string;
    artistName: string;
    artistMbid: string | null;
    albumMbid: string | null;
    coverUrl: string | null;
    trackCount: number;
    tracksNeeded: SpotifyTrack[];
}

export interface ImportPreview {
    playlist: {
        id: string;
        name: string;
        description: string | null;
        owner: string;
        imageUrl: string | null;
        trackCount: number;
    };
    matchedTracks: MatchedTrack[];
    albumsToDownload: AlbumToDownload[];
    summary: {
        total: number;
        inLibrary: number;
        downloadable: number;
        notFound: number;
    };
}

export interface ImportJob {
    id: string;
    userId: string;
    spotifyPlaylistId: string;
    playlistName: string;
    status:
        | "pending"
        | "downloading"
        | "scanning"
        | "creating_playlist"
        | "matching_tracks"
        | "completed"
        | "failed"
        | "cancelled";
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number; // Tracks from albums being downloaded
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    // Store the original track list so we can match after downloads
    pendingTracks: Array<{
        artist: string;
        title: string;
        album: string;
        albumMbid: string | null;
        artistMbid: string | null;
        preMatchedTrackId: string | null; // Track ID if already matched in preview
    }>;
}
