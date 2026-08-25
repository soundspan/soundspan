/**
 * The single source of truth for React Query cache keys.
 *
 * Every queryKey in the app must come from this factory (a lint rule bans
 * literal `queryKey: [...]` arrays elsewhere), so key shapes can change
 * without silently orphaning hand-written twins in invalidation sites
 * (GH #786). `...All()` entries are prefix keys for invalidating every
 * parameterized variant of a domain.
 */

export type AlbumDetailsSource = "library" | "remote" | "discovery";
export const queryKeys = {
    // Artist queries
    artist: (id: string) => ["artist", id] as const,
    artistDetails: (id: string, source?: "library" | "discovery" | null) =>
        ["artist", "details", id, source || "unknown"] as const,
    artistLibrary: (id: string) => ["artist", "library", id] as const,
    artistDiscovery: (id: string) => ["artist", "discovery", id] as const,

    // Album queries
    album: (id: string) => ["album", id] as const,
    albumDetails: (id: string, source?: AlbumDetailsSource | null) =>
        ["album", "details", id, source || "unknown"] as const,
    albumLibrary: (id: string) => ["album", "library", id] as const,
    albumDiscovery: (id: string) => ["album", "discovery", id] as const,
    albums: (filters?: Record<string, unknown>) => ["albums", filters] as const,
    // Library queries
    library: () => ["library"] as const,
    libraryArtists: (params: {
        filter?: string;
        sortBy?: string;
        limit?: number;
        offset?: number;
        origin?: string;
    }) => ["library", "artists", params] as const,
    libraryAlbums: (params: {
        filter?: string;
        sortBy?: string;
        limit?: number;
        offset?: number;
        origin?: string;
    }) => ["library", "albums", params] as const,
    libraryTracks: (params: {
        sortBy?: string;
        limit?: number;
        offset?: number;
        origin?: string;
    }) => ["library", "tracks", params] as const,
    likedPlaylist: (limit: number = 10_000) =>
        ["library", "liked-playlist", limit] as const,
    recentlyListened: (limit?: number) =>
        ["library", "recently-listened", limit] as const,
    recentlyAdded: (limit?: number) =>
        ["library", "recently-added", limit] as const,

    // Recommendations
    recommendations: (limit?: number) => ["recommendations", limit] as const,
    similarArtists: (seedArtistId: string, limit?: number) =>
        ["recommendations", "artists", seedArtistId, limit] as const,
    similarAlbums: (seedAlbumId: string, limit?: number) =>
        ["recommendations", "albums", seedAlbumId, limit] as const,

    // Search
    search: (query: string, type?: string, limit?: number, source?: string) =>
        ["search", query, type, limit, source] as const,
    discoverSearch: (query: string, type?: string, limit?: number) =>
        ["search", "discover", query, type, limit] as const,
    discoverSimilar: (artist: string, mbid: string, limit: number) =>
        ["search", "discover", "similar", artist, mbid, limit] as const,

    // Playlists
    playlists: () => ["playlists"] as const,
    playlist: (id: string) => ["playlist", id] as const,

    // Discover Weekly
    discoverWeekly: () => ["discover", "weekly"] as const,

    // Mixes
    mixes: () => ["mixes"] as const,
    mix: (id: string) => ["mix", id] as const,

    // Popular artists
    popularArtists: (limit?: number) => ["popular-artists", limit] as const,

    // Audiobooks
    audiobooks: (params?: { limit?: number; offset?: number }) =>
        ["audiobooks", params?.limit ?? null, params?.offset ?? null] as const,
    audiobook: (id: string) => ["audiobook", id] as const,

    // Podcasts
    podcasts: () => ["podcasts"] as const,
    podcast: (id: string) => ["podcast", id] as const,
    topPodcasts: (limit?: number, genreId?: number) =>
        ["podcasts", "top", limit, genreId] as const,

    // Home browse feed
    homeFeaturedPlaylists: (limit?: number) =>
        ["home", "featured-playlists", limit] as const,

    // Browse (YT Music) — used by Explore page
    browseHomeShelves: () => ["browse", "ytmusic", "home"] as const,
    browseCharts: () => ["browse", "ytmusic", "charts"] as const,
    browseCategories: () => ["browse", "ytmusic", "categories"] as const,
    browseYtMusicMixes: () => ["browse", "ytmusic", "mixes"] as const,

    // Browse (TIDAL) — used by Explore page
    browseTidalHome: () => ["browse", "tidal", "home"] as const,
    browseTidalExplore: () => ["browse", "tidal", "explore"] as const,
    browseTidalGenres: () => ["browse", "tidal", "genres"] as const,
    browseTidalMoods: () => ["browse", "tidal", "moods"] as const,
    browseTidalMixes: () => ["browse", "tidal", "mixes"] as const,

    // Prefix keys for whole-domain invalidation of the parameterized entries
    libraryArtistsAll: () => ["library", "artists"] as const,
    libraryAlbumsAll: () => ["library", "albums"] as const,
    libraryTracksAll: () => ["library", "tracks"] as const,
    likedPlaylistAll: () => ["library", "liked-playlist"] as const,

    // Library radio aggregates
    libraryGenres: () => ["library", "genres"] as const,
    libraryDecades: () => ["library", "decades"] as const,
    radioMosaic: (
        filterType: string,
        filterValue: string,
        tileCount: number,
        dailySeed: string,
    ) =>
        [
            "radio",
            "mosaic",
            filterType,
            filterValue,
            tileCount,
            dailySeed,
        ] as const,

    // Notifications
    notifications: () => ["notifications"] as const,
    unreadNotificationCount: () => ["unread-notification-count"] as const,

    // Downloads
    downloadHistory: () => ["download-history"] as const,
    activeDownloads: () => ["active-downloads"] as const,

    // Enrichment admin surfaces
    enrichmentFailuresAll: () => ["enrichment-failures"] as const,
    enrichmentFailures: (type: string, page: number) =>
        ["enrichment-failures", type, page] as const,
    enrichmentFailureCounts: () => ["enrichment-failure-counts"] as const,
    enrichmentProgress: () => ["enrichment-progress"] as const,
    enrichmentStatus: () => ["enrichment-status"] as const,
    enrichmentConcurrency: () => ["enrichment-concurrency"] as const,
    analysisWorkers: () => ["analysis-workers"] as const,

    // Peer playlists
    peerPlaylistsAll: () => ["peer-playlists"] as const,
    peerPlaylistsBrowse: () => ["peer-playlists", "browse"] as const,
    peerPlaylistDetail: (peerId: string, remoteId: string) =>
        ["peer-playlists", "detail", peerId, remoteId] as const,
    peerPlaylistsFollowed: () => ["peer-playlists", "followed"] as const,

    // Track preference
    trackPreference: (trackId: string) =>
        ["track-preference", trackId] as const,

    // Music requests
    musicRequests: () => ["music-requests"] as const,

    // Settings
    userSettings: () => ["user-settings"] as const,
    tidalStreamingStatus: () => ["tidal-streaming-status"] as const,

    // Podcast discovery
    podcastDiscoveryGenres: () => ["podcasts", "discovery", "genres"] as const,
    podcastPeers: () => ["podcasts", "peers"] as const,

    // Player overlay related-content
    playerRelatedTracks: (trackId: string | undefined) =>
        ["player-related-tracks", trackId] as const,
    playerRelatedArtists: (
        artistName: string | undefined,
        artistMbid: string | undefined,
    ) => ["player-related-artists", artistName, artistMbid] as const,
    playerRelatedAlbums: (artistId: string | undefined) =>
        ["player-related-albums", artistId] as const,
};
