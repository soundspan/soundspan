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
        Heart: icon("heart"),
        Loader2: icon("loader-2"),
        Music: icon("music"),
        Pause: icon("pause"),
        Play: icon("play"),
        Shuffle: icon("shuffle"),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
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

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
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

test("renders empty-state copy and disables Play All and Shuffle when there are no tracks", async () => {
    const mod = await import("../../app/playlist/my-liked/page.tsx");
    const MyLikedPlaylistPage = mod.default;

    const html = renderWithQueryClient(MyLikedPlaylistPage);

    assert.match(html, /No liked tracks yet/);
    assert.match(html, /Tap the heart on any song to add it here\./);
    assert.match(html, /<span>Play All<\/span>/);

    const disabledButtons = html.match(/<button[^>]*\bdisabled\b[^>]*>/g) ?? [];
    assert.equal(
        disabledButtons.length,
        2,
        "expected Play All and Shuffle controls to be disabled"
    );
    assert.match(
        html,
        /<button(?=[^>]*title="Shuffle")(?=[^>]*\bdisabled\b)[^>]*>/,
        "expected disabled Shuffle control"
    );
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

    const mod = await import("../../app/playlist/my-liked/page.tsx");
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
