import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const marker = (label: string) =>
    function Marker({
        children,
    }: {
        children?: React.ReactNode;
    }) {
        return React.createElement("div", null, label, children);
    };

const Icon = () => React.createElement("i");

const albumState = {
    loading: false,
    detailsLoading: false,
    source: "library" as "library" | "discovery" | null,
    album: {
        id: "album-1",
        title: "Album One",
        coverArt: "cover-1",
        artist: { id: "artist-1", name: "Artist One" },
        tracks: [
            {
                id: "track-1",
                title: "Track One",
                duration: 180,
            },
        ],
        similarAlbums: [] as Array<{ id: string; title: string }>,
    } as Record<string, unknown> | null,
    tidalGapFill: {
        enrichedTracks: null as unknown[] | null,
        isMatching: false,
        isStatusResolved: true,
    },
    ytGapFill: {
        enrichedTracks: null as unknown[] | null,
        isMatching: false,
        isStatusResolved: true,
    },
};

const artistState = {
    loading: false,
    detailsLoading: false,
    error: null as Error | null,
    source: "library" as "library" | "discovery" | null,
    sortBy: "year",
    artist: {
        id: "artist-1",
        name: "Artist One",
        coverArt: "artist-cover-1",
        topTracks: [
            {
                id: "top-1",
                title: "Top Track",
                duration: 200,
                album: { id: "album-top-1", title: "Top Album" },
            },
        ],
        similarArtists: [{ id: "similar-1", name: "Similar Artist" }],
    } as Record<string, unknown> | null,
    albums: [
        { id: "owned-1", title: "Owned Album", owned: true },
        { id: "available-1", title: "Available Album", owned: false },
    ] as Array<Record<string, unknown>>,
    tidalTopTracks: {
        enrichedTopTracks: null as unknown[] | null,
        isMatching: false,
        isStatusResolved: true,
    },
    ytTopTracks: {
        enrichedTopTracks: null as unknown[] | null,
        isMatching: false,
        isStatusResolved: true,
    },
};

const discoverState = {
    loading: false,
    isGenerating: false,
    batchStatus: null as
        | {
              status: "scanning" | "generating";
              completed: number;
              total: number;
          }
        | null,
    config: {
        playlistSize: 30,
        exclusionMonths: 6,
        downloadRatio: 1.2,
        enabled: true,
        lastGeneratedAt: null as string | null,
    },
    playlist: {
        weekStart: "2026-02-16",
        weekEnd: "2026-02-23",
        tracks: [
            {
                id: "discover-1",
                title: "Discover Track",
                artist: "Discover Artist",
                album: "Discover Album",
                albumId: "discover-album-1",
                similarity: 0.9,
                tier: "high",
                coverUrl: null,
                available: true,
                duration: 220,
                isLiked: false,
                likedAt: null,
            },
        ],
        unavailable: [] as Array<Record<string, unknown>>,
        totalCount: 1,
        unavailableCount: 0,
    } as Record<string, unknown> | null,
    providerTracks: null as Array<Record<string, unknown>> | null,
    providerCounts: {
        local: 1,
        tidal: 0,
        youtube: 0,
    },
    providerMatching: false,
};

const capture = {
    albumTrackList: null as Record<string, unknown> | null,
    albumActionBar: null as Record<string, unknown> | null,
    artistPopularTracks: null as Record<string, unknown> | null,
    artistActionBar: null as Record<string, unknown> | null,
    discoverActionBar: null as Record<string, unknown> | null,
};

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
            back: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: null,
        }),
        useAudioPlayback: () => ({
            isPlaying: false,
        }),
        useAudioControls: () => ({
            pause: () => undefined,
            playTracks: () => undefined,
            playNow: () => undefined,
        }),
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            isPendingByMbid: () => false,
            downloadsEnabled: true,
        }),
    },
});

mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({
            isInGroup: false,
        }),
    },
});

mock.module("@/hooks/useImageColor", {
    namedExports: {
        useImageColor: () => ({
            colors: {
                vibrant: "#4488ee",
                darkVibrant: "#223355",
            },
        }),
    },
});

mock.module("@/hooks/useTrackPreview", {
    namedExports: {
        useTrackPreview: () => ({
            previewTrack: null,
            previewPlaying: false,
            handlePreview: () => undefined,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (id: string, size: number) =>
                `/cover/${encodeURIComponent(id)}?size=${size}`,
            addTrackToPlaylist: async () => undefined,
            getAlbum: async () => ({
                id: "album-1",
                title: "Album One",
                coverArt: null,
                artist: { id: "artist-1", name: "Artist One" },
                tracks: [],
            }),
            getRadioTracks: async () => ({ tracks: [] }),
        },
    },
});

mock.module("@/components/ui/LoadingScreen", {
    namedExports: {
        LoadingScreen: ({ message }: { message?: string }) =>
            React.createElement("div", null, "loading-screen", message ?? ""),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: marker("gradient-spinner"),
    },
});

mock.module("lucide-react", {
    namedExports: {
        RefreshCw: Icon,
        Music2: Icon,
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            error: () => undefined,
            info: () => undefined,
        },
    },
});

mock.module("@/features/album/hooks/useAlbumData", {
    namedExports: {
        useAlbumData: () => ({
            album: albumState.album,
            source: albumState.source,
            loading: albumState.loading,
            detailsLoading: albumState.detailsLoading,
            reloadAlbum: () => undefined,
        }),
    },
});

mock.module("@/features/album/hooks/useTidalGapFill", {
    namedExports: {
        useTidalGapFill: () => ({
            enrichedTracks: albumState.tidalGapFill.enrichedTracks,
            isMatching: albumState.tidalGapFill.isMatching,
            isStatusResolved: albumState.tidalGapFill.isStatusResolved,
        }),
    },
});

mock.module("@/features/album/hooks/useYtMusicGapFill", {
    namedExports: {
        useYtMusicGapFill: () => ({
            enrichedTracks: albumState.ytGapFill.enrichedTracks,
            isMatching: albumState.ytGapFill.isMatching,
            isStatusResolved: albumState.ytGapFill.isStatusResolved,
        }),
    },
});

mock.module("@/features/album/hooks/useAlbumActions", {
    namedExports: {
        useAlbumActions: () => ({
            playAlbum: () => undefined,
            shufflePlay: () => undefined,
            playTrackNow: () => undefined,
            addAllToQueue: () => undefined,
            downloadAlbum: () => undefined,
            setAlbumPreference: async () => undefined,
            isApplyingAlbumPreference: false,
        }),
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: marker("playlist-selector"),
    },
});

mock.module("@/features/album/components/AlbumHero", {
    namedExports: {
        AlbumHero: marker("album-hero"),
    },
});

mock.module("@/features/album/components/AlbumActionBar", {
    namedExports: {
        AlbumActionBar: (props: Record<string, unknown>) => {
            capture.albumActionBar = props;
            return React.createElement("div", null, "album-action-bar");
        },
    },
});

mock.module("@/features/album/components/TrackList", {
    namedExports: {
        TrackList: (props: Record<string, unknown>) => {
            capture.albumTrackList = props;
            return React.createElement("div", null, "album-track-list");
        },
    },
});

mock.module("@/features/album/components/SimilarAlbums", {
    namedExports: {
        SimilarAlbums: marker("similar-albums"),
    },
});

mock.module("@/features/artist/hooks/useArtistData", {
    namedExports: {
        useArtistData: () => ({
            artist: artistState.artist,
            albums: artistState.albums,
            loading: artistState.loading,
            detailsLoading: artistState.detailsLoading,
            error: artistState.error,
            source: artistState.source,
            sortBy: artistState.sortBy,
            setSortBy: () => undefined,
            reloadArtist: () => undefined,
        }),
    },
});

mock.module("@/features/artist/hooks/useArtistActions", {
    namedExports: {
        useArtistActions: () => ({
            playAll: () => undefined,
            shufflePlay: () => undefined,
            addAllToQueue: () => undefined,
        }),
    },
});

mock.module("@/features/artist/hooks/useDownloadActions", {
    namedExports: {
        useDownloadActions: () => ({
            downloadArtist: () => undefined,
            downloadAlbum: () => undefined,
        }),
    },
});

mock.module("@/features/artist/hooks/useTidalTopTracks", {
    namedExports: {
        useTidalTopTracks: () => ({
            enrichedTopTracks: artistState.tidalTopTracks.enrichedTopTracks,
            isMatching: artistState.tidalTopTracks.isMatching,
            isStatusResolved: artistState.tidalTopTracks.isStatusResolved,
        }),
    },
});

mock.module("@/features/artist/hooks/useYtMusicTopTracks", {
    namedExports: {
        useYtMusicTopTracks: () => ({
            enrichedTopTracks: artistState.ytTopTracks.enrichedTopTracks,
            isMatching: artistState.ytTopTracks.isMatching,
            isStatusResolved: artistState.ytTopTracks.isStatusResolved,
        }),
    },
});

mock.module("@/features/artist/components/ArtistHero", {
    namedExports: {
        ArtistHero: marker("artist-hero"),
    },
});

mock.module("@/features/artist/components/ArtistActionBar", {
    namedExports: {
        ArtistActionBar: (props: Record<string, unknown>) => {
            capture.artistActionBar = props;
            return React.createElement("div", null, "artist-action-bar");
        },
    },
});

mock.module("@/features/artist/components/ArtistBio", {
    namedExports: {
        ArtistBio: marker("artist-bio"),
    },
});

mock.module("@/features/artist/components/PopularTracks", {
    namedExports: {
        PopularTracks: (props: Record<string, unknown>) => {
            capture.artistPopularTracks = props;
            return React.createElement("div", null, "popular-tracks");
        },
    },
});

mock.module("@/features/artist/components/Discography", {
    namedExports: {
        Discography: marker("discography"),
    },
});

mock.module("@/features/artist/components/AvailableAlbums", {
    namedExports: {
        AvailableAlbums: marker("available-albums"),
    },
});

mock.module("@/features/artist/components/SimilarArtists", {
    namedExports: {
        SimilarArtists: marker("similar-artists"),
    },
});

mock.module("@/components/ui/ReleaseSelectionModal", {
    namedExports: {
        ReleaseSelectionModal: marker("release-selection-modal"),
    },
});

mock.module("@/features/discover/hooks/useDiscoverData", {
    namedExports: {
        useDiscoverData: () => ({
            playlist: discoverState.playlist,
            config: discoverState.config,
            setConfig: () => undefined,
            loading: discoverState.loading,
            reloadData: async () => undefined,
            batchStatus: discoverState.batchStatus,
            refreshBatchStatus: async () => undefined,
            setPendingGeneration: () => undefined,
            isGenerating: discoverState.isGenerating,
        }),
    },
});

mock.module("@/features/discover/hooks/useDiscoverProviderGapFill", {
    namedExports: {
        useDiscoverProviderGapFill: () => ({
            tracks:
                discoverState.providerTracks ||
                ((discoverState.playlist?.tracks as Array<Record<string, unknown>>) ??
                    []),
            providerCounts: discoverState.providerCounts,
            isMatching: discoverState.providerMatching,
        }),
    },
});

mock.module("@/features/discover/hooks/useDiscoverActions", {
    namedExports: {
        useDiscoverActions: () => ({
            handleGenerate: () => undefined,
            handlePlayPlaylist: () => undefined,
            handlePlayTrack: () => undefined,
            handleTogglePlay: () => undefined,
        }),
    },
});

mock.module("@/features/discover/hooks/usePreviewPlayer", {
    namedExports: {
        usePreviewPlayer: () => ({
            currentPreview: null,
            handleTogglePreview: () => undefined,
        }),
    },
});

mock.module("@/features/discover/components/DiscoverHero", {
    namedExports: {
        DiscoverHero: marker("discover-hero"),
    },
});

mock.module("@/features/discover/components/DiscoverActionBar", {
    namedExports: {
        DiscoverActionBar: (props: Record<string, unknown>) => {
            capture.discoverActionBar = props;
            return React.createElement("div", null, "discover-action-bar");
        },
    },
});

mock.module("@/features/discover/components/DiscoverSettings", {
    namedExports: {
        DiscoverSettings: marker("discover-settings"),
    },
});

mock.module("@/features/discover/components/TrackList", {
    namedExports: {
        TrackList: marker("discover-track-list"),
    },
});

mock.module("@/features/discover/components/UnavailableAlbums", {
    namedExports: {
        UnavailableAlbums: marker("unavailable-albums"),
    },
});

mock.module("@/features/discover/components/HowItWorks", {
    namedExports: {
        HowItWorks: marker("how-it-works"),
    },
});

beforeEach(() => {
    albumState.loading = false;
    albumState.detailsLoading = false;
    albumState.source = "library";
    albumState.album = {
        id: "album-1",
        title: "Album One",
        coverArt: "cover-1",
        artist: { id: "artist-1", name: "Artist One" },
        tracks: [{ id: "track-1", title: "Track One", duration: 180 }],
        similarAlbums: [],
    };
    albumState.tidalGapFill = {
        enrichedTracks: null,
        isMatching: false,
        isStatusResolved: true,
    };
    albumState.ytGapFill = {
        enrichedTracks: null,
        isMatching: false,
        isStatusResolved: true,
    };

    artistState.loading = false;
    artistState.detailsLoading = false;
    artistState.error = null;
    artistState.source = "library";
    artistState.artist = {
        id: "artist-1",
        name: "Artist One",
        coverArt: "artist-cover-1",
        topTracks: [
            {
                id: "top-1",
                title: "Top Track",
                duration: 200,
                album: { id: "album-top-1", title: "Top Album" },
            },
        ],
        similarArtists: [{ id: "similar-1", name: "Similar Artist" }],
    };
    artistState.albums = [
        { id: "owned-1", title: "Owned Album", owned: true },
        { id: "available-1", title: "Available Album", owned: false },
    ];
    artistState.tidalTopTracks = {
        enrichedTopTracks: null,
        isMatching: false,
        isStatusResolved: true,
    };
    artistState.ytTopTracks = {
        enrichedTopTracks: null,
        isMatching: false,
        isStatusResolved: true,
    };

    discoverState.loading = false;
    discoverState.isGenerating = false;
    discoverState.batchStatus = null;
    discoverState.config.lastGeneratedAt = null;
    discoverState.playlist = {
        weekStart: "2026-02-16",
        weekEnd: "2026-02-23",
        tracks: [
            {
                id: "discover-1",
                title: "Discover Track",
                artist: "Discover Artist",
                album: "Discover Album",
                albumId: "discover-album-1",
                similarity: 0.9,
                tier: "high",
                coverUrl: null,
                available: true,
                duration: 220,
                isLiked: false,
                likedAt: null,
            },
        ],
        unavailable: [],
        totalCount: 1,
        unavailableCount: 0,
    };
    discoverState.providerTracks = null;
    discoverState.providerCounts = { local: 1, tidal: 0, youtube: 0 };
    discoverState.providerMatching = false;

    capture.albumTrackList = null;
    capture.albumActionBar = null;
    capture.artistPopularTracks = null;
    capture.artistActionBar = null;
    capture.discoverActionBar = null;
});

function resolvedParams(id: string) {
    return {
        status: "fulfilled",
        value: { id },
        then: () => undefined,
    } as unknown as Promise<{ id: string }>;
}

test("album route shows loading screen while album data is loading", async () => {
    albumState.loading = true;

    const AlbumPage = (await import("../../app/album/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(
        React.createElement(AlbumPage, { params: resolvedParams("album-1") })
    );

    assert.match(html, /loading-screen/);
});

test("album route shows error state when album payload is missing", async () => {
    albumState.album = null;

    const AlbumPage = (await import("../../app/album/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(
        React.createElement(AlbumPage, { params: resolvedParams("album-404") })
    );

    assert.match(html, /Error Loading Album/);
    assert.match(html, /Album not found/);
    assert.match(html, /Back to Albums/);
});

test("album route renders placeholders while details are loading without tracks", async () => {
    albumState.album = {
        id: "album-1",
        title: "Album One",
        artist: { id: "artist-1", name: "Artist One" },
        tracks: [],
        similarAlbums: [],
    };
    albumState.detailsLoading = true;

    const AlbumPage = (await import("../../app/album/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(
        React.createElement(AlbumPage, { params: resolvedParams("album-1") })
    );

    assert.match(html, /animate-pulse/);
    assert.doesNotMatch(html, /album-track-list/);
});

test("album route forwards provider matching and discovery fallback source to child components", async () => {
    albumState.source = null;
    albumState.album = {
        id: "album-1",
        title: "Album One",
        artist: { id: "artist-1", name: "Artist One" },
        coverArt: "cover-1",
        tracks: [{ id: "track-1", title: "Track One", duration: 180 }],
        similarAlbums: [{ id: "sim-1", title: "Similar One" }],
    };
    albumState.tidalGapFill.isStatusResolved = false;

    const AlbumPage = (await import("../../app/album/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(
        React.createElement(AlbumPage, { params: resolvedParams("album-1") })
    );

    assert.match(html, /album-track-list/);
    assert.match(html, /similar-albums/);
    assert.equal(capture.albumTrackList?.isProviderMatching, true);
    assert.equal(capture.albumTrackList?.source, "discovery");
    assert.equal(capture.albumActionBar?.source, "discovery");
});

test("artist route shows loading state for initial artist request", async () => {
    artistState.loading = true;

    const ArtistPage = (await import("../../app/artist/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(ArtistPage));

    assert.match(html, /loading-screen/);
    assert.match(html, /Loading artist/);
});

test("artist route shows not-found fallback when data fails", async () => {
    artistState.error = new Error("not found");
    artistState.artist = null;

    const ArtistPage = (await import("../../app/artist/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(ArtistPage));

    assert.match(html, /Artist Not Found/);
    assert.match(html, /Go Back/);
});

test("artist route shows progressive placeholders for library artist with details still loading", async () => {
    artistState.source = "library";
    artistState.detailsLoading = true;
    artistState.artist = {
        id: "artist-1",
        name: "Artist One",
        topTracks: [],
        similarArtists: [],
    };
    artistState.albums = [{ id: "owned-1", title: "Owned Album", owned: true }];

    const ArtistPage = (await import("../../app/artist/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(ArtistPage));

    assert.match(html, /Popular/);
    assert.match(html, /Albums Available/);
    assert.match(html, /Fans Also Like/);
    assert.doesNotMatch(html, /popular-tracks/);
});

test("artist route renders popular tracks and provider matching metadata", async () => {
    artistState.source = null;
    artistState.artist = {
        id: "artist-1",
        name: "Artist One",
        topTracks: [
            {
                id: "top-1",
                title: "Top Track",
                duration: 200,
                album: { id: "album-top-1", title: "Top Album" },
            },
        ],
        similarArtists: [{ id: "similar-1", name: "Similar Artist" }],
    };
    artistState.albums = [
        { id: "owned-1", title: "Owned Album", owned: true },
        { id: "available-1", title: "Available Album", owned: false },
    ];
    artistState.ytTopTracks.isStatusResolved = false;

    const ArtistPage = (await import("../../app/artist/[id]/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(ArtistPage));

    assert.match(html, /popular-tracks/);
    assert.match(html, /available-albums/);
    assert.match(html, /similar-artists/);
    assert.equal(capture.artistPopularTracks?.isProviderMatching, true);
    assert.equal(capture.artistPopularTracks?.popularHref, "/artist/artist-1/popular");
    assert.equal(capture.artistActionBar?.source, "discovery");
});

test("discover route shows spinner while loading", async () => {
    discoverState.loading = true;

    const DiscoverPage = (await import("../../app/discover/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(DiscoverPage));

    assert.match(html, /gradient-spinner/);
});

test("discover route renders source mix and track list when playlist has tracks", async () => {
    discoverState.providerCounts = {
        local: 1,
        tidal: 2,
        youtube: 3,
    };

    const DiscoverPage = (await import("../../app/discover/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(DiscoverPage));

    assert.match(html, /Source mix: 1 local/);
    assert.match(html, /2 TIDAL gap-fill/);
    assert.match(html, /3 YouTube Music gap-fill/);
    assert.match(html, /discover-track-list/);
    assert.match(html, /how-it-works/);
});

test("discover route keeps unavailable albums visible while tracks are still resolving", async () => {
    discoverState.playlist = {
        weekStart: "2026-02-16",
        weekEnd: "2026-02-23",
        tracks: [],
        unavailable: [{ id: "missing-1", album: "Missing Album" }],
        totalCount: 1,
        unavailableCount: 1,
    };
    discoverState.providerTracks = [];

    const DiscoverPage = (await import("../../app/discover/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(DiscoverPage));

    assert.match(html, /still finishing this week&#x27;s track list/);
    assert.match(html, /unavailable-albums/);
});

test("discover route shows resolving state when generation is recent but playlist hydration is pending", async () => {
    discoverState.playlist = {
        weekStart: "2026-02-16",
        weekEnd: "2026-02-23",
        tracks: [],
        unavailable: [],
        totalCount: 0,
        unavailableCount: 0,
    };
    discoverState.providerTracks = [];
    discoverState.config.lastGeneratedAt = new Date().toISOString();

    const DiscoverPage = (await import("../../app/discover/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(DiscoverPage));

    assert.match(html, /Loading your latest Discover Weekly/);
});

test("discover route shows empty-call-to-action when no playlist exists yet", async () => {
    discoverState.playlist = {
        weekStart: "2026-02-16",
        weekEnd: "2026-02-23",
        tracks: [],
        unavailable: [],
        totalCount: 0,
        unavailableCount: 0,
    };
    discoverState.providerTracks = [];
    discoverState.config.lastGeneratedAt = "2026-01-01T00:00:00.000Z";

    const DiscoverPage = (await import("../../app/discover/page.tsx")).default;
    const html = renderToStaticMarkup(React.createElement(DiscoverPage));

    assert.match(html, /No Discover Weekly Yet/);
    assert.match(html, /Generate Now/);
    assert.equal(capture.discoverActionBar?.isGenerating, false);
});
