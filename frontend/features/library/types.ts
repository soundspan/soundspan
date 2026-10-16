import type {
    FederatedTrackPeer,
    UnifiedTrackSource,
} from "@soundspan/media-metadata-contract";

export type Tab = "artists" | "albums" | "tracks";

/** Streaming providers whose liked tracks can appear in the Library. */
export type RemoteLibrarySource = "tidal" | "youtube";

/** Where a Library artist or album comes from; "remote" means streaming-only. */
export type LibraryItemSource = UnifiedTrackSource | "remote";

export interface Artist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string | null;
    albumCount?: number;
    trackCount?: number;
    source?: LibraryItemSource;
    peer?: FederatedTrackPeer;
    /** Streaming providers holding this artist's liked, not-yet-local tracks. */
    remoteSources?: RemoteLibrarySource[];
}

export interface Album {
    id: string;
    title: string;
    coverArt?: string | null;
    year?: number;
    artist?: {
        id: string;
        mbid?: string;
        name: string;
    };
    source?: LibraryItemSource;
    peer?: FederatedTrackPeer;
    remoteSources?: RemoteLibrarySource[];
}

export interface Track {
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    id: string;
    title: string;
    duration: number;
    trackNumber?: number;
    album?: {
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
        id: string;
        title: string;
        coverArt?: string | null;
        /** Release-group MBID; remote albums may carry a synthetic `remote:` id. */
        rgMbid?: string | null;
        artist?: {
            id: string;
            name: string;
        };
    };
    // Metadata override fields
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
    /** Streaming fields present on liked TIDAL / YouTube Music rows. */
    streamSource?: "local" | "peer" | RemoteLibrarySource;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    provider?: {
        tidalTrackId?: number | null;
        youtubeVideoId?: string | null;
    };
}

export interface DeleteDialogState {
    isOpen: boolean;
    type: "track" | "album" | "artist";
    id: string;
    title: string;
}
