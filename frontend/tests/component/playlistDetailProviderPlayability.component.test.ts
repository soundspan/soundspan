import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = {
    isLoading: false,
    queuedTrackIds: new Set<string>(),
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    playlist: null as Record<string, unknown> | null,
    routerPushPath: null as string | null,
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        Trash2: Icon,
        Shuffle: Icon,
        Eye: Icon,
        EyeOff: Icon,
        ListMusic: Icon,
        Music: Icon,
        Volume2: Icon,
        RefreshCw: Icon,
        AlertCircle: Icon,
        X: Icon,
        Loader2: Icon,
        Radio: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "playlist-1" }),
        useRouter: () => ({
            push: (path: string) => {
                state.routerPushPath = path;
            },
        }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
});

mock.module("@/components/ui/ConfirmDialog", {
    namedExports: {
        ConfirmDialog: () => null,
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: () =>
            React.createElement("button", { type: "button" }, "prefs"),
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: () =>
            React.createElement("button", { type: "button", "aria-label": "Track actions" }, "actions"),
        TrackMenuButton: ({ label }: { label: string }) =>
            React.createElement("span", null, label),
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YOUTUBE"),
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        usePlaylistQuery: () => ({
            data: state.playlist,
            isLoading: state.isLoading,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => state.queuedTrackIds,
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
        useAudioPlayback: () => ({
            isPlaying: state.isPlaying,
        }),
        useAudioControls: () => ({
            playTracks: () => undefined,
            playNow: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
        }),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
                success: () => undefined,
                info: () => undefined,
            },
        }),
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            downloadsEnabled: true,
        }),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("div", null, "Loading"),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            getRadioTracks: async () => ({ tracks: [] }),
            removeTrackFromPlaylist: async () => undefined,
            deletePlaylist: async () => undefined,
            hidePlaylist: async () => undefined,
            unhidePlaylist: async () => undefined,
            getFreshPreviewUrl: async () => ({ previewUrl: "https://preview.local" }),
            retryPendingTrack: async () => ({ success: true }),
            removePendingTrack: async () => undefined,
        },
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T,>(arr: T[]) => arr,
    },
});

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) =>
            `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        },
    },
});

beforeEach(() => {
    state.isLoading = false;
    state.currentTrack = null;
    state.isPlaying = false;
    state.queuedTrackIds = new Set();
    state.routerPushPath = null;
    state.playlist = {
        id: "playlist-1",
        name: "Mixed Playlist",
        isOwner: true,
        isHidden: false,
        pendingCount: 0,
        pendingTracks: [],
        items: [
            {
                id: "local-1",
                type: "track",
                sort: 1,
                trackId: "track-local-1",
                provider: { source: "local", label: "LOCAL" },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "track-local-1",
                    title: "Local Song",
                    duration: 180,
                    album: {
                        id: "album-1",
                        title: "Local Album",
                        coverArt: null,
                        artist: { id: "artist-1", name: "Local Artist" },
                    },
                },
            },
            {
                id: "tidal-1",
                type: "track",
                sort: 2,
                provider: { source: "tidal", label: "TIDAL", tidalTrackId: 991 },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "tidal:991",
                    title: "Tidal Song",
                    duration: 245,
                    streamSource: "tidal",
                    tidalTrackId: 991,
                    album: {
                        title: "Tidal Album",
                        coverArt: null,
                        artist: { name: "Tidal Artist" },
                    },
                },
            },
            {
                id: "yt-1",
                type: "track",
                sort: 3,
                provider: {
                    source: "youtube",
                    label: "YOUTUBE",
                    youtubeVideoId: "yt-video-7",
                },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "yt:yt-video-7",
                    title: "YouTube Song",
                    duration: 210,
                    streamSource: "youtube",
                    youtubeVideoId: "yt-video-7",
                    album: {
                        title: "YT Album",
                        coverArt: null,
                        artist: { name: "YT Artist" },
                    },
                },
            },
            {
                id: "missing-1",
                type: "track",
                sort: 4,
                provider: { source: "unknown", label: "UNKNOWN" },
                playback: {
                    isPlayable: false,
                    reason: "missing_provider_track",
                    message: "Track mapping missing for this import.",
                },
                track: null,
            },
        ],
        mergedItems: [
            {
                id: "local-1",
                type: "track",
                sort: 1,
                trackId: "track-local-1",
                provider: { source: "local", label: "LOCAL" },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "track-local-1",
                    title: "Local Song",
                    duration: 180,
                    album: {
                        id: "album-1",
                        title: "Local Album",
                        coverArt: null,
                        artist: { id: "artist-1", name: "Local Artist" },
                    },
                },
            },
            {
                id: "tidal-1",
                type: "track",
                sort: 2,
                provider: { source: "tidal", label: "TIDAL", tidalTrackId: 991 },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "tidal:991",
                    title: "Tidal Song",
                    duration: 245,
                    streamSource: "tidal",
                    tidalTrackId: 991,
                    album: {
                        title: "Tidal Album",
                        coverArt: null,
                        artist: { name: "Tidal Artist" },
                    },
                },
            },
            {
                id: "yt-1",
                type: "track",
                sort: 3,
                provider: {
                    source: "youtube",
                    label: "YOUTUBE",
                    youtubeVideoId: "yt-video-7",
                },
                playback: { isPlayable: true, reason: null, message: null },
                track: {
                    id: "yt:yt-video-7",
                    title: "YouTube Song",
                    duration: 210,
                    streamSource: "youtube",
                    youtubeVideoId: "yt-video-7",
                    album: {
                        title: "YT Album",
                        coverArt: null,
                        artist: { name: "YT Artist" },
                    },
                },
            },
            {
                id: "missing-1",
                type: "track",
                sort: 4,
                provider: { source: "unknown", label: "UNKNOWN" },
                playback: {
                    isPlayable: false,
                    reason: "missing_provider_track",
                    message: "Track mapping missing for this import.",
                },
                track: null,
            },
        ],
    };
});

test("playlist detail renders provider badges and unplayable fallback messaging", async () => {
    const mod = await import("../../app/playlist/[id]/page.tsx");
    const PlaylistDetailPage = mod.default;

    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PlaylistDetailPage)
        )
    );

    assert.match(html, /1 local \/ 1 TIDAL \/ 1 YouTube/);
    assert.match(html, /Local Song/);
    assert.match(html, /TIDAL/);
    assert.match(html, /YOUTUBE/);
    assert.match(html, /Unplayable/);
    assert.match(html, /Track mapping missing for this import\./);
    assert.match(html, /currently not playable/);
    assert.match(html, /Cannot play/);
});
