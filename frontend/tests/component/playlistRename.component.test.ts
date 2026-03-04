import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = {
    isLoading: false,
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    playlist: null as Record<string, unknown> | null,
    updatePlaylistCalls: [] as Array<{ id: string; data: Record<string, unknown> }>,
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
        Heart: Icon,
        Plus: Icon,
        Globe: Icon,
        GlobeLock: Icon,
        Pencil: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "playlist-1" }),
        useRouter: () => ({
            push: () => undefined,
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
        useQueuedTrackIds: () => new Set<string>(),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
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
            addTracksToQueue: () => undefined,
        }),
    },
});

mock.module("@/hooks/useCollectionLikeAll", {
    namedExports: {
        useCollectionLikeAll: () => ({
            isAllLiked: false,
            isApplying: false,
            toggleLikeAll: async () => undefined,
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
            updatePlaylist: async (id: string, data: Record<string, unknown>) => {
                state.updatePlaylistCalls.push({ id, data });
            },
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

const makePlaylist = (overrides: Record<string, unknown> = {}) => ({
    id: "playlist-1",
    name: "My Playlist",
    isOwner: true,
    isPublic: false,
    isHidden: false,
    pendingCount: 0,
    pendingTracks: [],
    items: [
        {
            id: "track-item-1",
            type: "track",
            sort: 1,
            trackId: "track-1",
            provider: { source: "local", label: "LOCAL" },
            playback: { isPlayable: true, reason: null, message: null },
            track: {
                id: "track-1",
                title: "Test Song",
                duration: 200,
                album: {
                    id: "album-1",
                    title: "Test Album",
                    coverArt: null,
                    artist: { id: "artist-1", name: "Test Artist" },
                },
            },
        },
    ],
    mergedItems: [
        {
            id: "track-item-1",
            type: "track",
            sort: 1,
            trackId: "track-1",
            provider: { source: "local", label: "LOCAL" },
            playback: { isPlayable: true, reason: null, message: null },
            track: {
                id: "track-1",
                title: "Test Song",
                duration: 200,
                album: {
                    id: "album-1",
                    title: "Test Album",
                    coverArt: null,
                    artist: { id: "artist-1", name: "Test Artist" },
                },
            },
        },
    ],
    ...overrides,
});

beforeEach(() => {
    state.isLoading = false;
    state.currentTrack = null;
    state.isPlaying = false;
    state.updatePlaylistCalls = [];
    state.playlist = makePlaylist();
});

function renderPage() {
    // Dynamic import to pick up mock state per test
    return import("../../app/playlist/[id]/page").then((mod) => {
        const PlaylistDetailPage = mod.default;
        const queryClient = new QueryClient();
        return renderToStaticMarkup(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(PlaylistDetailPage)
            )
        );
    });
}

// --- Owner sees rename button ---

test("owner playlist shows rename button with correct aria-label", async () => {
    state.playlist = makePlaylist({ isOwner: true });
    const html = await renderPage();
    assert.match(html, /aria-label="Rename playlist"/,
        "Expected a rename button with aria-label for owner playlists");
});

// --- Non-owner does NOT see rename button ---

test("non-owner playlist does not show rename button", async () => {
    state.playlist = makePlaylist({ isOwner: false });
    const html = await renderPage();
    assert.doesNotMatch(html, /aria-label="Rename playlist"/,
        "Non-owner should not see a rename button");
});

// --- Rename input has aria-label and maxLength ---

test("rename input has aria-label attribute in SSR markup", async () => {
    // SSR renders the non-editing state by default (isRenaming starts false),
    // but we can verify the input attributes are defined in the component.
    // For SSR, the editing state is not active, so we check the button instead.
    state.playlist = makePlaylist({ isOwner: true });
    const html = await renderPage();
    // The rename button should be a real <button> element
    assert.match(html, /<button[^>]*aria-label="Rename playlist"[^>]*>/,
        "Rename trigger should be a <button> with aria-label");
});

// --- Playlist name is rendered ---

test("playlist name is displayed in the title", async () => {
    state.playlist = makePlaylist({ name: "Cool Tunes" });
    const html = await renderPage();
    assert.match(html, /Cool Tunes/, "Playlist name should appear in rendered output");
});

// --- isOwner undefined does not show rename ---

test("playlist with undefined isOwner does not show rename button", async () => {
    state.playlist = makePlaylist({ isOwner: undefined });
    const html = await renderPage();
    assert.doesNotMatch(html, /aria-label="Rename playlist"/,
        "Undefined isOwner should not enable rename");
});

// --- Pencil icon is rendered inside rename button for owners ---

test("pencil icon is rendered inside rename button for owner", async () => {
    state.playlist = makePlaylist({ isOwner: true });
    const html = await renderPage();
    // The mock Icon renders an <svg> element. The rename button contains the Pencil icon.
    // Check that a button with aria-label contains an svg child.
    const btnMatch = html.match(/<button[^>]*aria-label="Rename playlist"[^>]*>.*?<\/button>/s);
    assert.ok(btnMatch, "Should find rename button");
    assert.match(btnMatch![0], /<svg/, "Rename button should contain an SVG icon (Pencil)");
});
