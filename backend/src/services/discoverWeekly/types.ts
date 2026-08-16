/** Artist used to seed a Discover Weekly recommendation run. */
export interface SeedArtist {
    name: string;
    mbid?: string;
}

/** Album candidate selected for a Discover Weekly batch. */
export interface RecommendedAlbum {
    artistName: string;
    artistMbid?: string;
    albumTitle: string;
    albumMbid: string;
    similarity: number;
    tier?: "high" | "medium" | "explore" | "wildcard";
}

/** Persisted discovery-batch log entry. */
export interface BatchLogEntry {
    timestamp: string;
    level: "info" | "warn" | "error";
    message: string;
}

/** Pre-fetched artist membership decisions keyed by MBID and name. */
export interface ArtistLibraryMembership {
    mbidHasAlbum: Map<string, boolean>;
    nameHasAlbum: Map<string, boolean>;
}
