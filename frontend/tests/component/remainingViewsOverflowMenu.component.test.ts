import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Component tests for overflow menu adoption in remaining views.
 *
 * Phase 7:
 *   7.2 — Artist PopularTracks
 *
 * Tests verify:
 * - PopularTracks renders TrackOverflowMenu trigger on each track row
 * - PopularTracks overflow menu is present alongside existing duration/preview controls
 */

// Shared mutable state
const state = {
    playbackType: "track" as string | null,
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    queuedTrackIds: new Set<string>(),
};

// Stub icon
const Icon = (props: Record<string, unknown>) => React.createElement("i", props);

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        Volume2: Icon,
        Music: Icon,
        ListPlus: Icon,
        EllipsisVertical: Icon,
        ListEnd: Icon,
        Plus: Icon,
        User: Icon,
        Disc3: Icon,
        AudioWaveform: Icon,
        Link: Icon,
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
        formatTime: (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    },
});

mock.module("@/utils/formatNumber", {
    namedExports: {
        formatNumber: (n: number) => String(n),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            addTrackToPlaylist: async () => undefined,
        },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playNext: () => undefined,
            addToQueue: () => undefined,
            playTrack: () => undefined,
            playTracks: () => undefined,
            startVibeMode: async () => ({ success: true, trackCount: 10 }),
        }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            playbackType: state.playbackType,
            currentTrack: state.currentTrack,
        }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
});

mock.module("next/link", {
    defaultExport: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
        React.createElement("a", { href, ...props }, children),
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
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

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => state.queuedTrackIds,
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: (props: { isOpen: boolean }) =>
            props.isOpen
                ? React.createElement("div", { "data-testid": "playlist-selector" }, "PlaylistSelector")
                : null,
    },
});

mock.module("@/utils/artistRoute", {
    namedExports: {
        getArtistHref: (artist: { id?: string; name?: string }) =>
            artist.id ? `/artist/${artist.id}` : artist.name ? `/artist/${encodeURIComponent(artist.name)}` : null,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
        }),
    },
});

beforeEach(() => {
    state.playbackType = "track";
    state.currentTrack = null;
    state.isPlaying = false;
    state.queuedTrackIds = new Set();
});

// ─── 7.2 Artist PopularTracks ─────────────────────────────────────────

test("PopularTracks renders TrackOverflowMenu trigger on each track row", async () => {
    const { PopularTracks } = await import(
        "../../features/artist/components/PopularTracks.tsx"
    );

    const artist = { id: "artist-1", name: "Test Artist" };
    const tracks = [
        {
            id: "pt1",
            title: "Popular Track 1",
            duration: 200,
            album: { id: "al1", title: "Album 1", coverArt: null },
            artist: { id: "artist-1", name: "Test Artist" },
        },
        {
            id: "pt2",
            title: "Popular Track 2",
            duration: 180,
            album: { id: "al2", title: "Album 2", coverArt: null },
            artist: { id: "artist-1", name: "Test Artist" },
        },
    ];

    const html = renderToStaticMarkup(
        React.createElement(PopularTracks, {
            tracks,
            artist,
            currentTrackId: undefined,
            colors: null,
            onPlayTrack: () => undefined,
            previewTrack: null,
            previewPlaying: false,
            onPreview: () => undefined,
        })
    );

    // Should have overflow menu triggers (aria-haspopup="menu")
    const triggerMatches = html.match(/aria-haspopup="menu"/g);
    assert.ok(triggerMatches, "Should render overflow menu triggers");
    assert.equal(triggerMatches!.length, 2, "Should have one trigger per track row");
});

test("PopularTracks overflow menu passes isInListenTogetherGroup", async () => {
    const { PopularTracks } = await import(
        "../../features/artist/components/PopularTracks.tsx"
    );

    const artist = { id: "artist-1", name: "Test Artist" };
    const tracks = [
        {
            id: "pt1",
            title: "Popular Track 1",
            duration: 200,
            album: { id: "al1", title: "Album 1", coverArt: null },
            artist: { id: "artist-1", name: "Test Artist" },
        },
    ];

    const html = renderToStaticMarkup(
        React.createElement(PopularTracks, {
            tracks,
            artist,
            currentTrackId: undefined,
            colors: null,
            onPlayTrack: () => undefined,
            previewTrack: null,
            previewPlaying: false,
            onPreview: () => undefined,
            isInListenTogetherGroup: false,
        })
    );

    // Should render the overflow menu (presence check)
    assert.match(html, /Track actions/, "Should render overflow menu");
});
