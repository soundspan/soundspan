export type AlbumSource = "library" | "discovery";

export interface Album {
    id: string;
    title: string;
    artist?: {
        id: string;
        mbid?: string;
        name: string;
    };
    year?: number;
    genre?: string;
    coverArt?: string;
    coverUrl?: string;
    duration?: number;
    trackCount?: number;
    playCount?: number;
    type?: string;
    mbid?: string;
    rgMbid?: string;
    owned?: boolean;
    tracks?: Track[];
    similarAlbums?: SimilarAlbum[];
}

export interface Track {
    id: string;
    title: string;
    duration: number;
    isrc?: string;
    trackNumber?: number;
    trackNo?: number;       // Backend field name (Prisma)
    discNumber?: number;
    discNo?: number;        // Backend field name (Prisma)
    playCount?: number;
    artist?: {
        id?: string;
        name?: string;
    };
    album?: {
        id?: string;
        title?: string;
        coverArt?: string;
    };
    // Metadata override fields
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    // Streaming fields (gap-fill)
    streamSource?: "local" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    // Local file path (present for owned/library tracks)
    filePath?: string;
}

export interface SimilarAlbum {
    id: string;
    title: string;
    artist?: {
        id: string;
        name: string;
    };
    coverArt?: string;
    coverUrl?: string;
    year?: number;
    owned?: boolean;
    mbid?: string;
}
