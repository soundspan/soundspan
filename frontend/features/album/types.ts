import type {
    FederatedTrackPeer,
    UnifiedTrackSource,
} from "@soundspan/media-metadata-contract";

/** Album-page data source used to choose hydration and available controls. */
export type AlbumSource = "library" | "remote" | "discovery";

/** Source values returned by the album API. */
export type AlbumApiSource = "local" | "remote" | "federated";

export interface Album {
    albumLoudnessLufs?: number | null;
    albumTruePeakDb?: number | null;
    id: string;
    title: string;
    artist?: {
        id: string;
        mbid?: string;
        name: string;
    };
    year?: number;
    genre?: string;
    coverArt?: string | null;
    coverUrl?: string | null;
    duration?: number;
    trackCount?: number;
    playCount?: number;
    type?: string;
    mbid?: string;
    rgMbid?: string;
    owned?: boolean;
    tracks?: Track[];
    similarAlbums?: SimilarAlbum[];
    source?: AlbumApiSource;
    peer?: FederatedTrackPeer;
}

export interface Track {
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    id: string;
    title: string;
    duration: number;
    isrc?: string;
    trackNumber?: number;
    trackNo?: number; // Backend field name (Prisma)
    discNumber?: number;
    discNo?: number; // Backend field name (Prisma)
    playCount?: number;
    artist?: {
        id?: string;
        name?: string;
    };
    album?: {
        id?: string;
        title?: string;
        coverArt?: string | null;
    };
    // Metadata override fields
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    // Streaming fields (gap-fill)
    streamSource?: "local" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    thumbnailUrl?: string;
    // Local file path (present for owned/library tracks)
    filePath?: string;
    source?: UnifiedTrackSource;
    peer?: FederatedTrackPeer;
}

/** Resolves the album-page state without conflating remote-library visibility with ownership. */
export function resolveAlbumSource(
    album: Pick<Album, "owned" | "source"> | null | undefined,
): AlbumSource | null {
    if (!album) return null;
    if (album.source === "remote") return "remote";
    return album.owned === true ? "library" : "discovery";
}

export interface SimilarAlbum {
    id: string;
    title: string;
    artist?: {
        id: string;
        name: string;
    };
    coverArt?: string | null;
    coverUrl?: string | null;
    year?: number;
    owned?: boolean;
    mbid?: string;
}
