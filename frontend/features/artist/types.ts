import type {
    FederatedTrackPeer,
    UnifiedTrackSource,
} from "@soundspan/media-metadata-contract";

export type ArtistSource = "library" | "discovery";

export interface Artist {
    id: string;
    name: string;
    coverArt?: string | null;
    image?: string;
    heroUrl?: string;
    bio?: string;
    summary?: string;
    mbid?: string;
    url?: string;
    listeners?: number;
    genres?: string[];
    tags?: string[];
    albums?: Album[];
    topTracks?: Track[];
    similarArtists?: SimilarArtist[];
    // User overrides (non-destructive edits)
    displayName?: string | null;
    userSummary?: string | null;
    userHeroUrl?: string | null;
    userGenres?: string[];
    hasUserOverrides?: boolean;
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
}

export interface Album {
    id: string;
    title: string;
    year?: number;
    coverArt?: string | null;
    coverUrl?: string | null;
    trackCount?: number;
    songCount?: number;
    type?: string;
    owned?: boolean;
    mbid?: string;
    rgMbid?: string;
    availability?: string;
    genres?: string[];
    lastSynced?: string;
    // User overrides (non-destructive edits)
    displayTitle?: string | null;
    displayYear?: number | null;
    userCoverUrl?: string | null;
    userGenres?: string[];
    hasUserOverrides?: boolean;
    source?: UnifiedTrackSource;
    provenanceSource?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
}

export interface Track {
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    id: string;
    title: string;
    duration: number;
    isrc?: string;
    filePath?: string;
    playCount?: number;
    userPlayCount?: number;
    listeners?: number;
    album?: {
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
        id?: string;
        title?: string;
        coverArt?: string | null;
    };
    artist?: {
        id?: string;
        name?: string;
    };
    trackNo?: number;
    // User overrides (non-destructive edits)
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    // Streaming fields (gap-fill)
    streamSource?: "local" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
}

export interface SimilarArtist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string | null;
    image?: string;
    albumCount?: number;
    ownedAlbumCount?: number;
    weight?: number;
    inLibrary?: boolean;
}
