import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness.ts";

/**
 * Component tests verifying TrackOverflowMenu adoption across priority views.
 *
 * Phase 2 of mass-ui-improvements:
 *   2.1 — Library Songs (TracksList)
 *   2.2 — Discover Weekly (TrackList)
 *   2.3 — Playlist detail (page.tsx track rows)
 *   2.4 — Album TrackList
 *
 * Tests verify:
 * - Each view renders a "Track actions" trigger (the overflow menu)
 * - Inline action buttons (ListPlus/Plus/Trash2) are replaced by the menu
 * - The shared TrackOverflowMenu component is used (checked via aria attributes)
 */

// Shared mutable state for mocks
const state = {
    playbackType: "track" as "track" | "audiobook" | "podcast" | null,
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    routerPushPath: null as string | null,
    isInListenTogetherGroup: false,
    queuedTrackIds: new Set<string>(),
};

// Mock lucide-react icons
mock.module("lucide-react", {
    namedExports: {
        EllipsisVertical: trackOverflowIcon,
        ListEnd: trackOverflowIcon,
        ListPlus: trackOverflowIcon,
        ListMusic: trackOverflowIcon,
        Plus: trackOverflowIcon,
        User: trackOverflowIcon,
        Disc3: trackOverflowIcon,
        Disc: trackOverflowIcon,
        AudioWaveform: trackOverflowIcon,
        Link: trackOverflowIcon,
        Play: trackOverflowIcon,
        Pause: trackOverflowIcon,
        AudioLines: trackOverflowIcon,
        Music: trackOverflowIcon,
        Volume2: trackOverflowIcon,
        Shuffle: trackOverflowIcon,
        Eye: trackOverflowIcon,
        EyeOff: trackOverflowIcon,
        Trash2: trackOverflowIcon,
        RefreshCw: trackOverflowIcon,
        AlertCircle: trackOverflowIcon,
        X: trackOverflowIcon,
        Loader2: trackOverflowIcon,
    },
});

// Mock formatTime
mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    },
});

// Mock formatNumber
mock.module("@/utils/formatNumber", {
    namedExports: {
        formatNumber: (n: number) => String(n),
    },
});

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTrack: () => undefined,
        playTracks: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        startVibeMode: async () => ({ success: true, trackCount: 10 }),
    }),
    useAudioState: () => ({
        playbackType: state.playbackType,
        currentTrack: state.currentTrack,
    }),
});

// Mock audio playback
mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({
            isPlaying: state.isPlaying,
            currentTime: 0,
            duration: 0,
        }),
    },
});

// Mock combined audio context (used by playlist page)
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            playbackType: state.playbackType,
            currentTrack: state.currentTrack,
        }),
        useAudioPlayback: () => ({
            isPlaying: state.isPlaying,
        }),
        useAudioControls: () => ({
            playNext: () => undefined,
            addToQueue: () => undefined,
            playTrack: () => undefined,
            playTracks: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            startVibeMode: async () => ({ success: true, trackCount: 10 }),
        }),
    },
});

// Mock next/navigation
mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: (path: string) => {
                state.routerPushPath = path;
            },
        }),
        useParams: () => ({ id: "playlist-1" }),
    },
});

// Mock api
mock.module("@/lib/api", {
    namedExports: {
        api: {
            addTrackToPlaylist: async () => undefined,
            getCoverArtUrl: (url: string) => url,
            removeTrackFromPlaylist: async () => undefined,
            deletePlaylist: async () => undefined,
            hidePlaylist: async () => undefined,
            unhidePlaylist: async () => undefined,
            getFreshPreviewUrl: async () => ({ previewUrl: "" }),
            retryPendingTrack: async () => ({ success: true }),
            removePendingTrack: async () => undefined,
        },
    },
});

// Mock toast context
mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success: () => undefined,
                error: () => undefined,
                info: () => undefined,
            },
        }),
    },
});

// Mock download context
mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            downloadsEnabled: true,
        }),
    },
});

// Mock useQueuedTrackIds
mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => state.queuedTrackIds,
    },
});

// Mock usePlaylistQuery
mock.module("@/hooks/useQueries", {
    namedExports: {
        usePlaylistQuery: () => ({
            data: {
                name: "Test Playlist",
                items: [
                    {
                        id: "pi-1",
                        track: {
                            id: "track-1",
                            title: "Track One",
                            duration: 200,
                            album: { title: "Album One", coverArt: null, artist: { name: "Artist One", id: "a1" } },
                        },
                    },
                ],
                mergedItems: null,
                pendingTracks: [],
                pendingCount: 0,
                isOwner: true,
                isHidden: false,
            },
            isLoading: false,
        }),
    },
});

// Mock usePlayButtonFeedback
mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

// Mock react-query
mock.module("@tanstack/react-query", {
    namedExports: {
        useQueryClient: () => ({
            invalidateQueries: async () => undefined,
            setQueryData: () => undefined,
        }),
    },
});

// Mock shuffle
mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T,>(arr: T[]) => arr,
    },
});

// Mock next/image
mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
});

// Mock CachedImage
mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: (props: Record<string, unknown>) =>
            React.createElement("img", { src: props.src as string, alt: props.alt as string }),
    },
});

// Mock EmptyState
mock.module("@/components/ui/EmptyState", {
    namedExports: {
        EmptyState: () => React.createElement("div", null, "Empty"),
    },
});

// Mock GradientSpinner
mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("div", null, "Loading"),
    },
});

// Mock Card
mock.module("@/components/ui/Card", {
    namedExports: {
        Card: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "card" }, children),
    },
});

// Mock ConfirmDialog
mock.module("@/components/ui/ConfirmDialog", {
    namedExports: {
        ConfirmDialog: () => null,
    },
});

// Mock YouTubeBadge and TidalBadge
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YT"),
    },
});
mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

// Mock TrackPreferenceButtons
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: () =>
            React.createElement("div", { "data-testid": "track-pref-buttons" }, "thumbs"),
    },
});

beforeEach(() => {
    state.playbackType = "track";
    state.currentTrack = null;
    state.isPlaying = false;
    state.routerPushPath = null;
    state.isInListenTogetherGroup = false;
    state.queuedTrackIds = new Set();
});

// ─── 2.1 Library Songs (TracksList) ─────────────────────────────────

test("Library TracksList renders TrackOverflowMenu trigger on each row", async () => {
    const { TracksList } = await import(
        "../../features/library/components/TracksList.tsx"
    );

    const tracks = [
        {
            id: "t1",
            title: "Song A",
            duration: 180,
            album: { id: "al1", title: "Album A", coverArt: null, artist: { id: "ar1", name: "Artist A" } },
        },
        {
            id: "t2",
            title: "Song B",
            duration: 200,
            album: { id: "al2", title: "Album B", coverArt: null, artist: { id: "ar2", name: "Artist B" } },
        },
    ];

    const html = renderToStaticMarkup(
        React.createElement(TracksList, {
            tracks,
            onPlay: () => undefined,
            onAddToQueue: () => undefined,
            onAddToPlaylist: () => undefined,
            onDelete: () => undefined,
            canDelete: true,
        })
    );

    // Should have overflow menu triggers (aria-haspopup="menu" is unique per trigger button)
    const triggerMatches = html.match(/aria-haspopup="menu"/g);
    assert.ok(triggerMatches, "Should render overflow menu triggers");
    assert.equal(triggerMatches!.length, 2, "Should have one trigger per track row");

    // Should have "Track actions" aria-label
    assert.match(html, /Track actions/, "Should use TrackOverflowMenu component");
});

test("Library TracksList no longer renders inline Add to Queue / Add to Playlist buttons", async () => {
    const { TracksList } = await import(
        "../../features/library/components/TracksList.tsx"
    );

    const tracks = [
        {
            id: "t1",
            title: "Song A",
            duration: 180,
            album: { id: "al1", title: "Album A", coverArt: null, artist: { id: "ar1", name: "Artist A" } },
        },
    ];

    const html = renderToStaticMarkup(
        React.createElement(TracksList, {
            tracks,
            onPlay: () => undefined,
            onAddToQueue: () => undefined,
            onAddToPlaylist: () => undefined,
            onDelete: () => undefined,
            canDelete: false,
        })
    );

    // Old inline buttons had these titles - they should NOT appear as standalone buttons now
    // (they'll be inside the overflow menu which is closed on initial render)
    assert.doesNotMatch(html, /title="Add to Queue"/, "Should not have standalone Add to Queue button");
    assert.doesNotMatch(html, /title="Add to Playlist"/, "Should not have standalone Add to Playlist button");
});

// ─── 2.2 Discover Weekly (TrackList) ─────────────────────────────────

test("Discover TrackList renders TrackOverflowMenu trigger on each row", async () => {
    const { TrackList } = await import(
        "../../features/discover/components/TrackList.tsx"
    );

    const tracks = [
        {
            id: "dt1",
            title: "Discover Track 1",
            artist: "Discover Artist",
            album: "Discover Album",
            albumId: "dal1",
            tier: "high" as const,
            coverUrl: null,
            duration: 240,
            similarity: 0.85,
            isLiked: false,
            likedAt: null,
            available: true,
        },
    ];

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            tracks,
            currentTrack: null,
            isPlaying: false,
            onPlayTrack: () => undefined,
            onTogglePlay: () => undefined,
        })
    );

    // Should have a "Track actions" trigger from TrackOverflowMenu
    assert.match(html, /Track actions/, "Should render overflow menu trigger");
    assert.match(html, /aria-haspopup="menu"/, "Should use TrackOverflowMenu component");
});

// ─── 2.4 Album TrackList ─────────────────────────────────────────────

test("Album TrackList renders TrackOverflowMenu trigger instead of inline menu", async () => {
    const { TrackList } = await import(
        "../../features/album/components/TrackList.tsx"
    );

    const album = {
        id: "album-1",
        title: "Test Album",
        artist: { name: "Test Artist", id: "artist-1" },
        tracks: [],
        coverArt: null,
    };

    const tracks = [
        {
            id: "at1",
            title: "Album Track 1",
            duration: 200,
            trackNumber: 1,
            artist: { name: "Test Artist", id: "artist-1" },
            album: { id: "album-1", title: "Test Album" },
        },
    ];

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            tracks,
            album,
            source: "library",
            currentTrackId: undefined,
            colors: null,
            onPlayTrack: () => undefined,
            onAddToQueue: () => undefined,
            onAddToPlaylist: () => undefined,
            previewTrack: null,
            previewPlaying: false,
            onPreview: () => undefined,
            isInListenTogetherGroup: false,
        })
    );

    // Should have "Track actions" from TrackOverflowMenu component
    assert.match(html, /Track actions/, "Should render overflow menu trigger");
    assert.match(html, /aria-haspopup="menu"/, "Should use TrackOverflowMenu component");
});
