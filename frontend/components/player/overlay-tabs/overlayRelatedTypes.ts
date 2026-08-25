/** Row shapes for the overlay Related tab (GH #787). */

export interface RelatedTrack {
    id?: string;
    title: string;
    artist?: string;
    similarity?: number;
    inLibrary?: boolean;
    matchConfidence?: number;
    duration?: number;
    filePath?: string;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    lastFmUrl?: string;
    album?: {
        id?: string;
        title?: string;
        coverArt?: string;
        coverUrl?: string;
        artist?: { id?: string; name?: string; mbid?: string };
    };
}

export interface RelatedArtist {
    name: string;
    mbid?: string;
    image?: string;
}

export interface RelatedAlbum {
    id: string;
    title: string;
    year?: number;
    coverArt?: string | null;
}
