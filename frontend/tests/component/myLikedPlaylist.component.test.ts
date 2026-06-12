import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type MockLikedTrack = {
    id: string;
    title: string;
    duration: number;
    filePath: string | null;
    artist: {
        id: string;
        name: string;
    };
    album: {
        id: string;
        title: string;
        coverArt: string | null;
    };
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    source?: string;
    provider?: Record<string, unknown>;
};

type MockLikedPlaylistData = {
    playlist: {
        id: string;
        name: string;
    };
    tracks: MockLikedTrack[];
    total: number;
};

const state = {
    likedData: null as MockLikedPlaylistData | null,
    isLoading: false,
    isError: false,
    isPlaying: false,
    unlikePending: false,
    currentTrack: null as { id: string } | null,
};

const icon =
    (name: string) => {
        const MockIcon = (props: Record<string, unknown> = {}) =>
            React.createElement("svg", { ...props, "data-icon": name });
        MockIcon.displayName = `MockIcon${name.replace(/[^a-zA-Z0-9]/g, "")}`;
        return MockIcon;
    };

mock.module("lucide-react", {
    namedExports: {
        AudioLines: icon("audio-lines"),
        Heart: icon("heart"),
        ListMusic: icon("list-music"),
        Loader2: icon("loader-2"),
        Music: icon("music"),
        Pause: icon("pause"),
        Play: icon("play"),
        Plus: icon("plus"),
        Radio: icon("radio"),
        Shuffle: icon("shuffle"),
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: (props: Record<string, unknown>) =>
            React.createElement("img", { src: props.src as string, alt: props.alt as string }),
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
            replace: () => undefined,
            back: () => undefined,
            prefetch: () => undefined,
        }),
        usePathname: () => "/playlist/my-liked",
        useSearchParams: () => new URLSearchParams(),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: state.currentTrack,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => new Set<string>(),
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

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: () => null,
    },
});

mock.module("@/lib/trackRef", {
    namedExports: {
        toAddToPlaylistRef: (track: Record<string, unknown>) => track,
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            debug: () => undefined,
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            getBrowseImageUrl: (url: string) => url,
            getTidalBrowseImageUrl: (url: string) => `tidal:${url}`,
            setTrackPreference: async () => ({ trackId: "track-1", signal: "clear" }),
        },
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        queryKeys: {
            likedPlaylist: () => ["liked-playlist"],
        },
        useLikedPlaylistQuery: () => ({
            data: state.likedData,
            isLoading: state.isLoading,
            isError: state.isError,
        }),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) =>
            `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    },
});

mock.module("@/utils/shuffle", {
    namedExports: {
        shuffleArray: <T,>(arr: T[]) => arr,
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: (props: {
            trackId?: string;
            mode?: string;
            signal?: string;
            resolveFromQuery?: boolean;
            buttonSizeClassName?: string;
            iconSizeClassName?: string;
        }) =>
            React.createElement("button", {
                type: "button",
                title: "Like",
                "data-testid": "liked-track-thumb",
                "data-track-id": props.trackId,
                "data-mode": props.mode,
                "data-signal": props.signal,
                "data-resolve-from-query": String(props.resolveFromQuery),
                "data-button-size": props.buttonSizeClassName,
                "data-icon-size": props.iconSizeClassName,
            }),
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: (props: {
            track?: { id?: string };
            showGoToArtist?: boolean;
            showGoToAlbum?: boolean;
            showMatchVibe?: boolean;
            showStartRadio?: boolean;
        }) =>
            React.createElement("div", {
                "data-testid": "overflow-menu",
                "data-track-id": props.track?.id,
                "data-show-go-to-artist": String(props.showGoToArtist ?? true),
                "data-show-start-radio": String(props.showStartRadio ?? true),
            }),
    },
});

mock.module("@/components/layout/PageHeader", {
    namedExports: {
        PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) =>
            React.createElement(
                "div",
                { "data-testid": "page-header" },
                React.createElement("h1", null, title),
                subtitle ? React.createElement("p", null, subtitle) : null
            ),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                success: () => undefined,
                error: () => undefined,
            },
        }),
    },
});

function makeTrack(id: string, title: string): MockLikedTrack {
    return {
        id,
        title,
        duration: 180,
        filePath: null,
        artist: {
            id: "artist-1",
            name: "Test Artist",
        },
        album: {
            id: "album-1",
            title: "Test Album",
            coverArt: null,
        },
    };
}

function renderWithQueryClient(Component: React.ComponentType) {
    const queryClient = new QueryClient();

    return renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Component)
        )
    );
}

beforeEach(() => {
    state.likedData = {
        playlist: {
            id: "my-liked",
            name: "My Liked",
        },
        tracks: [],
        total: 0,
    };
    state.isLoading = false;
    state.isError = false;
    state.isPlaying = false;
    state.unlikePending = false;
    state.currentTrack = null;
});

test("renders empty-state copy and hides action buttons when there are no tracks", async () => {
    const mod = await import("../../app/playlist/my-liked/page");
    const MyLikedPlaylistPage = mod.default;

    const html = renderWithQueryClient(MyLikedPlaylistPage);

    assert.match(html, /No liked tracks yet/);
    assert.match(html, /Tap the heart on any song to add it here\./);

    // Action buttons should be hidden when there are no tracks
    assert.doesNotMatch(html, /<span>Play All<\/span>/);
    assert.doesNotMatch(html, /title="Shuffle/);
    assert.doesNotMatch(html, /title="Add all to queue/);
});

test("renders consolidated action bar buttons when tracks exist", async () => {
    state.likedData = {
        playlist: { id: "my-liked", name: "My Liked" },
        tracks: [makeTrack("track-1", "First"), makeTrack("track-2", "Second")],
        total: 2,
    };

    const mod = await import("../../app/playlist/my-liked/page");
    const html = renderWithQueryClient(mod.default);

    // Canonical order: Play, Shuffle, Add to Queue, Add to Playlist, Radio
    assert.match(html, /<span>Play All<\/span>/);
    assert.match(html, /title="Shuffle play"/);
    assert.match(html, /title="Add all to queue"/);
    assert.match(html, /title="Add all to playlist"/);
    assert.match(html, /title="Start playlist radio"/);
});

test("shows Pause primary action and active like controls when a liked track is currently playing", async () => {
    state.likedData = {
        playlist: {
            id: "my-liked",
            name: "My Liked",
        },
        tracks: [makeTrack("track-1", "First Track"), makeTrack("track-2", "Second Track")],
        total: 2,
    };
    state.currentTrack = { id: "track-2" };
    state.isPlaying = true;

    const mod = await import("../../app/playlist/my-liked/page");
    const MyLikedPlaylistPage = mod.default;
    const html = renderWithQueryClient(MyLikedPlaylistPage);

    assert.match(html, /<span>Pause<\/span>/);
    assert.match(html, /data-icon="pause"/);

    const thumbButtons = html.match(/data-testid="liked-track-thumb"/g) ?? [];
    assert.equal(thumbButtons.length, 2, "expected one thumb control per liked track");
    assert.match(html, /data-track-id="track-1"/);
    assert.match(html, /data-track-id="track-2"/);
    assert.match(html, /data-mode="up-only"/);
    assert.match(html, /data-signal="thumbs_up"/);
    assert.match(html, /data-resolve-from-query="false"/);
    assert.match(html, /data-button-size="h-8 w-8"/);
    assert.match(html, /data-icon-size="h-4 w-4"/);

    assert.doesNotMatch(html, /Delete Playlist/i);
});

test("overflow menu for remote liked tracks enables Go to Artist and Start Radio", async () => {
    const remoteTidalTrack: MockLikedTrack = {
        id: "tidal:991",
        title: "Remote Tidal Song",
        duration: 200,
        filePath: null,
        artist: { id: "remote-artist-cuid", name: "Tidal Artist" },
        album: { id: "remote-album-cuid", title: "Tidal Album", coverArt: null },
        streamSource: "tidal",
        tidalTrackId: 991,
    };
    state.likedData = {
        playlist: { id: "my-liked", name: "My Liked" },
        tracks: [makeTrack("track-1", "Local Song"), remoteTidalTrack],
        total: 2,
    };

    const mod = await import("../../app/playlist/my-liked/page");
    const html = renderWithQueryClient(mod.default);

    // Both tracks should have overflow menus
    const menus = html.match(/data-testid="overflow-menu"/g) ?? [];
    assert.equal(menus.length, 2, "Expected 2 overflow menus (local + remote)");

    // The remote track's overflow menu should have showGoToArtist=true
    assert.match(
        html,
        /data-track-id="tidal:991"[^>]*data-show-go-to-artist="true"/,
        "Remote track overflow menu should enable Go to Artist"
    );
    assert.match(
        html,
        /data-track-id="tidal:991"[^>]*data-show-start-radio="true"/,
        "Remote track overflow menu should enable Start Radio"
    );
});

test("resolveLikedTrackCoverUrl uses provider-specific proxies for remote sources", async () => {
    const { resolveLikedTrackCoverUrl } = await import("../../app/playlist/my-liked/page");

    const tidalTrack = {
        ...makeTrack("tidal-track", "Tidal Track"),
        streamSource: "tidal" as const,
        album: { id: "a1", title: "Album", coverArt: "https://img.tidal.com/cover.jpg" },
    };
    const ytTrack = {
        ...makeTrack("yt-track", "YT Track"),
        streamSource: "youtube" as const,
        album: { id: "a2", title: "Album", coverArt: "https://i.ytimg.com/cover.jpg" },
    };
    const localTrack = {
        ...makeTrack("local-track", "Local Track"),
        album: { id: "a3", title: "Album", coverArt: "/cover/local.jpg" },
    };

    assert.equal(
        resolveLikedTrackCoverUrl(tidalTrack as any, 200),
        "tidal:https://img.tidal.com/cover.jpg"
    );
    assert.equal(
        resolveLikedTrackCoverUrl(ytTrack as any, 200),
        "https://i.ytimg.com/cover.jpg"
    );
    assert.equal(
        resolveLikedTrackCoverUrl(localTrack as any, 200),
        "/cover/local.jpg"
    );
});
