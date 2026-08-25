import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    played: [] as Array<{ tracks: unknown[]; index: number }>,
    routed: [] as string[],
    tidalAvailable: true,
    tidalMatches: [] as Array<{
        id: number;
        title: string;
        artist: string;
        duration: number;
    } | null>,
};

mock.module("lucide-react", {
    namedExports: {
        Play: trackOverflowIcon,
        Pause: trackOverflowIcon,
        Music: trackOverflowIcon,
        EllipsisVertical: trackOverflowIcon,
        Link: trackOverflowIcon,
        ListEnd: trackOverflowIcon,
        ListPlus: trackOverflowIcon,
        Map: trackOverflowIcon,
        Plus: trackOverflowIcon,
        Share2: trackOverflowIcon,
        User: trackOverflowIcon,
        Disc3: trackOverflowIcon,
        AudioWaveform: trackOverflowIcon,
        Radio: trackOverflowIcon,
    },
});

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTrack: () => undefined,
        playTracks: (tracks: unknown[], index: number) => {
            state.played.push({ tracks, index });
        },
        startVibeMode: async () => ({ success: true, trackCount: 10 }),
    }),
    useAudioState: () => ({
        playbackType: "track",
        currentTrack: null,
    }),
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackStatus: () => ({ isPlaying: false }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            addTrackToPlaylist: async () => undefined,
            getTidalStreamingStatus: async () => ({
                enabled: state.tidalAvailable,
                available: state.tidalAvailable,
                authenticated: state.tidalAvailable,
                credentialsConfigured: state.tidalAvailable,
            }),
            getYtMusicStatus: async () => ({
                enabled: false,
                available: false,
                authenticated: false,
                credentialsConfigured: false,
            }),
            matchTidalBatch: async () => ({ matches: state.tidalMatches }),
            matchYtMusicBatch: async () => ({ matches: [] }),
        },
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
        }),
});
mock.module("next/link", {
    defaultExport: ({
        children,
        href,
        ...props
    }: {
        children: React.ReactNode;
        href: string;
        [key: string]: unknown;
    }) => React.createElement("a", { href, ...props }, children),
});
mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: (path: string) => {
                state.routed.push(path);
            },
        }),
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
mock.module("@/components/ui/PeerBadge", {
    namedExports: {
        PeerBadge: () => React.createElement("span", null, "PEER"),
    },
});
mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: { useQueuedTrackIds: () => new Set<string>() },
});
mock.module("@tanstack/react-query", {
    namedExports: {
        useQueryClient: () => ({
            invalidateQueries: async () => undefined,
            setQueryData: () => undefined,
        }),
    },
});
mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        buildPreferenceMetadata: () => undefined,
        useTrackPreference: () => ({
            signal: null,
            isSaving: false,
            toggleLike: async () => undefined,
        }),
    },
});
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: () =>
            React.createElement("div", {
                "data-testid": "track-preference-buttons",
            }),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    state.played.length = 0;
    state.routed.length = 0;
    state.tidalAvailable = true;
    state.tidalMatches = [];
});

async function render(element: React.ReactElement): Promise<{
    container: HTMLElement;
    unmount: () => void;
}> {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(element);
    });
    await React.act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    return {
        container,
        unmount: () => {
            void React.act(() => {
                root.unmount();
            });
        },
    };
}

test("matched discover rows play in place with a provider badge", async () => {
    state.tidalMatches = [
        {
            id: 42,
            title: "Every Light In The House",
            artist: "Trace Adkins",
            duration: 221,
        },
    ];
    const { DiscoverTracksList } =
        await import("../../features/search/components/DiscoverTracksList");
    const { container, unmount } = await render(
        React.createElement(DiscoverTracksList, {
            tracks: [
                {
                    type: "track" as const,
                    name: "Every Light In The House",
                    artist: "Trace Adkins",
                },
            ],
        }),
    );

    assert.match(container.innerHTML, /TIDAL/);
    const row = container.querySelector('[role="button"]');
    assert.ok(row, "row not found");
    await React.act(async () => {
        (row as HTMLElement).click();
    });

    assert.equal(state.routed.length, 0);
    assert.equal(state.played.length, 1);
    const played = state.played[0].tracks[0] as {
        streamSource: string;
        tidalTrackId: number;
        title: string;
    };
    assert.equal(played.streamSource, "tidal");
    assert.equal(played.tidalTrackId, 42);
    assert.equal(played.title, "Every Light In The House");
    unmount();
});

test("unmatched discover rows navigate to the artist page", async () => {
    state.tidalMatches = [null];
    const { DiscoverTracksList } =
        await import("../../features/search/components/DiscoverTracksList");
    const { container, unmount } = await render(
        React.createElement(DiscoverTracksList, {
            tracks: [
                {
                    type: "track" as const,
                    name: "Unmatched Song One Of A Kind",
                    artist: "Some Artist",
                },
            ],
        }),
    );

    const row = container.querySelector('[role="button"]');
    assert.ok(row, "row not found");
    await React.act(async () => {
        (row as HTMLElement).click();
    });

    assert.equal(state.played.length, 0);
    assert.equal(state.routed.length, 1);
    assert.match(state.routed[0], /^\/artist\//);
    unmount();
});

test("discover rows always carry an overflow menu trigger", async () => {
    state.tidalMatches = [null];
    const { DiscoverTracksList } =
        await import("../../features/search/components/DiscoverTracksList");
    const { container, unmount } = await render(
        React.createElement(DiscoverTracksList, {
            tracks: [
                {
                    type: "track" as const,
                    name: "Menu Song",
                    artist: "Menu Artist",
                },
            ],
        }),
    );

    assert.ok(container.querySelector('[aria-haspopup="menu"]'));
    unmount();
});

test("library search rows render preference buttons and an overflow menu", async () => {
    const { LibraryTracksList } =
        await import("../../features/search/components/LibraryTracksList");
    const { container, unmount } = await render(
        React.createElement(LibraryTracksList, {
            tracks: [
                {
                    id: "lt1",
                    title: "Library Song",
                    duration: 200,
                    album: {
                        id: "al1",
                        title: "Library Album",
                        coverUrl: null,
                        artist: { id: "ar1", name: "Library Artist" },
                    },
                },
            ] as never,
        }),
    );

    assert.ok(
        container.querySelector('[data-testid="track-preference-buttons"]'),
        "preference buttons missing",
    );
    assert.ok(
        container.querySelector('[aria-haspopup="menu"]'),
        "overflow menu missing",
    );
    unmount();
});
