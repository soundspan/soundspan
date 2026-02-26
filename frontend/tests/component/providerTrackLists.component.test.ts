import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    queuedTrackIds: new Set<string>(),
    overflowTracks: [] as Array<Record<string, unknown>>,
};

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        Volume2: Icon,
        Disc: Icon,
        Music: Icon,
        ListPlus: Icon,
    },
});

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    },
});

mock.module("@/utils/formatNumber", {
    namedExports: {
        formatNumber: (value: number) => `#${value}`,
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => state.queuedTrackIds,
    },
});

mock.module("@/components/ui/Card", {
    namedExports: {
        Card: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "card" }, children),
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YT"),
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: ({ trackId }: { trackId: string }) =>
            React.createElement("div", { "data-track-id": trackId }, "prefs"),
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: (props: Record<string, unknown>) => {
            state.overflowTracks.push(props);
            return React.createElement(
                "button",
                { "aria-label": "Track actions", type: "button" },
                "actions"
            );
        },
    },
});

mock.module("next/image", {
    defaultExport: ({
        src,
        alt,
        ...rest
    }: {
        src: string;
        alt: string;
    }) => React.createElement("img", { src, alt, ...rest }),
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) => React.createElement("a", { href, ...rest }, children),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string, size: number) =>
                `/cover/${encodeURIComponent(value)}?size=${size}`,
        },
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: () => undefined,
        },
    },
});

beforeEach(() => {
    state.queuedTrackIds = new Set();
    state.overflowTracks = [];
});

test("album TrackList renders disc separators and provider loading badges for unmatched tracks", async () => {
    const { TrackList } = await import(
        "../../features/album/components/TrackList.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            tracks: [
                {
                    id: "a-1",
                    title: "Unmatched Disc 1",
                    duration: 120,
                    discNumber: 1,
                    trackNumber: 1,
                    album: {},
                },
                {
                    id: "a-2",
                    title: "Unmatched Disc 2",
                    duration: 130,
                    discNumber: 2,
                    trackNumber: 1,
                    album: {},
                },
            ],
            album: {
                id: "album-1",
                title: "Album One",
                artist: { id: "artist-1", name: "Artist One" },
            },
            source: "discovery",
            currentTrackId: undefined,
            colors: null,
            onPlayTrack: () => undefined,
            previewTrack: null,
            previewPlaying: false,
            onPreview: () => undefined,
            isProviderMatching: true,
        })
    );

    assert.match(html, /Disc 1/);
    assert.match(html, /Disc 2/);
    assert.match(html, /LOADING/);
    assert.equal(
        (html.match(/Track actions/g) || []).length,
        0,
        "non-playable unmatched rows should not render overflow menu"
    );
});

test("album TrackList shows preview controls, queue badges, and provider badges", async () => {
    state.queuedTrackIds = new Set(["a-tidal"]);
    const { TrackList } = await import(
        "../../features/album/components/TrackList.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            tracks: [
                {
                    id: "a-preview",
                    title: "Preview Track",
                    duration: 90,
                    trackNumber: 1,
                    album: {},
                },
                {
                    id: "a-yt",
                    title: "YT Track",
                    duration: 210,
                    trackNumber: 2,
                    streamSource: "youtube",
                    youtubeVideoId: "yt-id",
                    album: {},
                },
                {
                    id: "a-tidal",
                    title: "Tidal Track",
                    duration: 240,
                    trackNumber: 3,
                    streamSource: "tidal",
                    tidalTrackId: 42,
                    playCount: 7,
                    album: {},
                },
            ],
            album: {
                id: "album-1",
                title: "Album One",
                artist: { id: "artist-1", name: "Artist One" },
            },
            source: "discovery",
            currentTrackId: undefined,
            colors: null,
            onPlayTrack: () => undefined,
            previewTrack: "a-preview",
            previewPlaying: true,
            onPreview: () => undefined,
            isInListenTogetherGroup: false,
            isProviderMatching: false,
        })
    );

    assert.match(html, /PREVIEW/);
    assert.match(html, /Pause preview/);
    assert.match(html, /IN QUEUE/);
    assert.match(html, /TIDAL/);
    assert.match(html, /YT/);
    assert.match(html, /#7/);
    assert.equal(
        (html.match(/Track actions/g) || []).length,
        2
    );
});

test("album TrackList marks streaming tracks as LOCAL ONLY inside Listen Together groups", async () => {
    const { TrackList } = await import(
        "../../features/album/components/TrackList.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            tracks: [
                {
                    id: "a-group-1",
                    title: "Group Blocked",
                    duration: 210,
                    trackNumber: 1,
                    streamSource: "youtube",
                    youtubeVideoId: "yt-group",
                    album: {},
                },
            ],
            album: {
                id: "album-1",
                title: "Album One",
                artist: { id: "artist-1", name: "Artist One" },
            },
            source: "discovery",
            currentTrackId: undefined,
            colors: null,
            onPlayTrack: () => undefined,
            previewTrack: null,
            previewPlaying: false,
            onPreview: () => undefined,
            isInListenTogetherGroup: true,
            isProviderMatching: false,
        })
    );

    assert.match(html, /LOCAL ONLY/);
    assert.match(html, /Track actions/);
});

test("artist PopularTracks limits visible items and renders provider/listen-together states", async () => {
    state.queuedTrackIds = new Set(["p-in-queue"]);
    const { PopularTracks } = await import(
        "../../features/artist/components/PopularTracks.tsx"
    );

    const tracks = [
        {
            id: "p-loading",
            title: "Needs Match",
            duration: 200,
            album: { id: "unknown", title: "Unknown Album", coverArt: null },
        },
        {
            id: "p-preview",
            title: "Preview Only",
            duration: 180,
            album: { id: "", title: "Unknown Album", coverArt: null },
        },
        {
            id: "p-yt",
            title: "YT Track",
            duration: 210,
            streamSource: "youtube",
            youtubeVideoId: "yt-id",
            album: { id: "", title: "Unknown Album", coverArt: null },
        },
        {
            id: "p-in-queue",
            title: "Tidal Track",
            duration: 220,
            streamSource: "tidal",
            tidalTrackId: 101,
            playCount: 12,
            album: { id: "album-1", title: "Album One", coverArt: "cover-1" },
        },
        {
            id: "p-blocked",
            title: "Blocked Track",
            duration: 170,
            streamSource: "youtube",
            youtubeVideoId: "blocked-yt",
            album: { id: "", title: "Unknown Album", coverArt: null },
        },
        {
            id: "p-hidden",
            title: "Hidden Sixth",
            duration: 123,
            album: { id: "album-2", title: "Album Two", coverArt: null },
        },
    ];

    const html = renderToStaticMarkup(
        React.createElement(PopularTracks, {
            tracks,
            artist: { id: "artist-1", name: "Artist One" },
            currentTrackId: "p-loading",
            colors: null,
            onPlayTrack: () => undefined,
            previewTrack: "p-preview",
            previewPlaying: true,
            onPreview: () => undefined,
            isInListenTogetherGroup: true,
            isProviderMatching: true,
            popularHref: "/artist/artist-1/popular",
            onAddAllToQueue: () => undefined,
        })
    );

    assert.match(html, /Add All to Queue/);
    assert.match(html, /href=\"\/artist\/artist-1\/popular\"/);
    assert.match(html, /LOADING/);
    assert.match(html, /YT MUSIC/);
    assert.match(html, /LOCAL ONLY/);
    assert.match(html, /IN QUEUE/);
    assert.match(html, /#12/);
    assert.doesNotMatch(html, /Hidden Sixth/);
});

test("artist PopularTracks renders PREVIEW state when provider matching is complete", async () => {
    const { PopularTracks } = await import(
        "../../features/artist/components/PopularTracks.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(PopularTracks, {
            tracks: [
                {
                    id: "preview-1",
                    title: "Preview Candidate",
                    duration: 140,
                    album: { id: "", title: "Unknown Album", coverArt: null },
                },
            ],
            artist: { id: "artist-1", name: "Artist One" },
            currentTrackId: undefined,
            colors: null,
            onPlayTrack: () => undefined,
            previewTrack: "preview-1",
            previewPlaying: true,
            onPreview: () => undefined,
            isInListenTogetherGroup: false,
            isProviderMatching: false,
        })
    );

    assert.match(html, /PREVIEW/);
});

test("discover TrackList renders source badges, tier aliases, queue badges, and album-link fallback behavior", async () => {
    state.queuedTrackIds = new Set(["d-queue"]);
    const { TrackList } = await import(
        "../../features/discover/components/TrackList.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            tracks: [
                {
                    id: "d-tidal",
                    title: "Tidal Source",
                    artist: "A Tidal",
                    album: "Album Tidal",
                    albumId: "album-tidal",
                    sourceType: "tidal",
                    tier: "high",
                    similarity: 0.95,
                    coverUrl: "cover-1",
                    available: true,
                    duration: 240,
                    isLiked: false,
                    likedAt: null,
                },
                {
                    id: "d-yt",
                    title: "YouTube Source",
                    artist: "A YT",
                    album: "Album YT",
                    albumId: "album-yt",
                    sourceType: "youtube",
                    tier: "medium",
                    similarity: 0.88,
                    coverUrl: null,
                    available: true,
                    duration: 230,
                    isLiked: false,
                    likedAt: null,
                },
                {
                    id: "d-loading",
                    title: "Still Matching",
                    artist: "A Loading",
                    album: "Album Loading",
                    albumId: "album-loading",
                    tier: "low",
                    similarity: 0.8,
                    coverUrl: null,
                    available: false,
                    duration: 180,
                    isLiked: false,
                    likedAt: null,
                },
                {
                    id: "d-preview",
                    title: "Preview Source",
                    artist: "A Preview",
                    album: "Album Preview",
                    albumId: "album-preview",
                    tier: "wild",
                    similarity: 0.7,
                    coverUrl: null,
                    available: false,
                    duration: 175,
                    isLiked: false,
                    likedAt: null,
                },
                {
                    id: "d-queue",
                    title: "Queued Local",
                    artist: "A Local",
                    album: "Album Local",
                    albumId: "",
                    tier: "explore",
                    similarity: 0.6,
                    coverUrl: null,
                    available: true,
                    duration: 165,
                    isLiked: false,
                    likedAt: null,
                },
            ],
            isMatching: true,
            currentTrack: { id: "d-tidal" },
            isPlaying: true,
            onPlayTrack: () => undefined,
            onTogglePlay: () => undefined,
        })
    );

    assert.match(html, /TIDAL/);
    assert.match(html, /YT Music/);
    assert.match(html, /LOADING/);
    assert.match(html, /Local/);
    assert.match(html, /IN QUEUE/);
    assert.match(html, /Explore/);
    assert.match(html, /Wild/);
    assert.match(html, /href=\"\/artist\/A%20Tidal\"/);
    assert.equal(
        state.overflowTracks.some(
            (entry) =>
                (entry.track as { id?: string })?.id === "d-queue" &&
                entry.showGoToAlbum === false
        ),
        true
    );
});
