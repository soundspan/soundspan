import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness.ts";

/**
 * Component tests for Queue page overflow menu adoption.
 *
 * Phase 5.2: Add TrackOverflowMenu to Next Up track rows.
 *
 * Tests verify:
 * - Next Up tracks render a TrackOverflowMenu trigger
 * - The standalone X (Remove) button is replaced by the overflow menu
 * - Move Up/Down and Play buttons remain as direct actions
 */

// Shared mutable state
const state = {
    isAuthenticated: true,
    queue: [] as Array<{
        id: string;
        title: string;
        displayTitle?: string;
        duration?: number;
        artist?: { name: string; id?: string };
        album?: { title: string; id?: string; coverArt?: string | null };
        streamSource?: string;
    }>,
    currentTrack: null as { id: string; title: string; album?: { coverArt?: string | null; title: string }; artist?: { name: string }; displayTitle?: string; duration?: number } | null,
    currentIndex: 0,
    isInGroup: false,
    isHost: false,
    playbackType: "track" as string | null,
};

mock.module("lucide-react", {
    namedExports: {
        Music: trackOverflowIcon,
        Play: trackOverflowIcon,
        X: trackOverflowIcon,
        GripVertical: trackOverflowIcon,
        Trash2: trackOverflowIcon,
        ListMusic: trackOverflowIcon,
        ChevronUp: trackOverflowIcon,
        ChevronDown: trackOverflowIcon,
        Save: trackOverflowIcon,
        EllipsisVertical: trackOverflowIcon,
        ListEnd: trackOverflowIcon,
        ListPlus: trackOverflowIcon,
        Plus: trackOverflowIcon,
        User: trackOverflowIcon,
        Disc3: trackOverflowIcon,
        AudioWaveform: trackOverflowIcon,
        Link: trackOverflowIcon,
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            queue: state.queue,
            currentTrack: state.currentTrack,
            currentIndex: state.currentIndex,
            setQueue: () => undefined,
            playbackType: state.playbackType,
        }),
        useAudioControls: () => ({
            playTracks: () => undefined,
            removeFromQueue: () => undefined,
            clearQueue: () => undefined,
            playNext: () => undefined,
            addToQueue: () => undefined,
            playTrack: () => undefined,
            startVibeMode: async () => ({ success: true, trackCount: 10 }),
        }),
    },
});

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTrack: () => undefined,
        playTracks: () => undefined,
        removeFromQueue: () => undefined,
        clearQueue: () => undefined,
        startVibeMode: async () => ({ success: true, trackCount: 10 }),
    }),
    useAudioState: () => ({
        queue: state.queue,
        currentTrack: state.currentTrack,
        currentIndex: state.currentIndex,
        playbackType: state.playbackType,
    }),
});

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

mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({
            isInGroup: state.isInGroup,
            isHost: state.isHost,
            syncSetTrack: () => undefined,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            addTrackToPlaylist: async () => undefined,
            createPlaylist: async () => ({ id: "new-playlist-id", name: "Test" }),
        },
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
        }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
});

mock.module("@/components/ui/Card", {
    namedExports: {
        Card: ({ children }: { children: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "card" }, children),
    },
});

mock.module("@/components/ui/Button", {
    namedExports: {
        Button: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) =>
            React.createElement("button", props, children),
    },
});

mock.module("@/components/ui/EmptyState", {
    namedExports: {
        EmptyState: () => React.createElement("div", null, "Empty"),
    },
});

mock.module("@/components/layout/PageHeader", {
    namedExports: {
        PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) =>
            React.createElement("div", { "data-testid": "page-header" }, title, actions),
    },
});

beforeEach(() => {
    state.isAuthenticated = true;
    state.currentTrack = {
        id: "t1",
        title: "Current Track",
        duration: 200,
        artist: { name: "Artist 1" },
        album: { title: "Album 1", coverArt: null },
    };
    state.currentIndex = 0;
    state.queue = [
        {
            id: "t1",
            title: "Current Track",
            duration: 200,
            artist: { name: "Artist 1", id: "a1" },
            album: { title: "Album 1", id: "al1", coverArt: null },
        },
        {
            id: "t2",
            title: "Next Track A",
            duration: 180,
            artist: { name: "Artist 2", id: "a2" },
            album: { title: "Album 2", id: "al2", coverArt: null },
        },
        {
            id: "t3",
            title: "Next Track B",
            duration: 220,
            artist: { name: "Artist 3", id: "a3" },
            album: { title: "Album 3", id: "al3", coverArt: null },
        },
    ];
    state.isInGroup = false;
    state.isHost = false;
    state.playbackType = "track";
});

test("Queue page Next Up tracks render TrackOverflowMenu trigger", async () => {
    const mod = await import("../../app/queue/page.tsx");
    const QueuePage = mod.default;

    const html = renderToStaticMarkup(React.createElement(QueuePage));

    // Should have overflow menu triggers for each Next Up track (2 tracks after currentIndex)
    const triggerMatches = html.match(/aria-haspopup="menu"/g);
    assert.ok(triggerMatches, "Should render overflow menu triggers");
    assert.equal(triggerMatches!.length, 2, "Should have one trigger per Next Up track");
});

test("Queue page replaces standalone Remove button with overflow menu", async () => {
    const mod = await import("../../app/queue/page.tsx");
    const QueuePage = mod.default;

    const html = renderToStaticMarkup(React.createElement(QueuePage));

    // Should NOT have standalone "Remove" titled button (was the X button)
    assert.doesNotMatch(html, /title="Remove"/, "Should not have standalone Remove button");

    // Should still have the overflow menu trigger
    assert.match(html, /Track actions/, "Should have overflow menu");
});

test("Queue page keeps Move Up/Down and Play buttons alongside overflow menu", async () => {
    const mod = await import("../../app/queue/page.tsx");
    const QueuePage = mod.default;

    const html = renderToStaticMarkup(React.createElement(QueuePage));

    // Move buttons should still exist
    assert.match(html, /title="Move up"/, "Should keep Move up button");
    assert.match(html, /title="Move down"/, "Should keep Move down button");

    // Play now button should still exist
    assert.match(html, /title="Play now"/, "Should keep Play now button");
});

// ─── 5.1 Save Queue as Playlist ───────────────────────────────────────

test("Queue page renders Save as Playlist button when queue has tracks", async () => {
    const mod = await import("../../app/queue/page.tsx");
    const QueuePage = mod.default;

    const html = renderToStaticMarkup(React.createElement(QueuePage));

    // Should have a "Save as Playlist" button
    assert.match(html, /Save as Playlist/, "Should render Save as Playlist button");
});

test("Queue page does not render Save as Playlist when queue is empty", async () => {
    state.queue = [];
    state.currentTrack = null;

    const mod = await import("../../app/queue/page.tsx");
    const QueuePage = mod.default;

    const html = renderToStaticMarkup(React.createElement(QueuePage));

    // Should NOT have the button when empty
    assert.doesNotMatch(html, /Save as Playlist/, "Should not render Save as Playlist when empty");
});
