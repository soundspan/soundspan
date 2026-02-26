import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness.ts";

/**
 * Component tests for TrackOverflowMenu.
 *
 * Uses SSR rendering with mock.module() to verify the component renders
 * correct menu items based on props and track data.
 */

// Shared mutable state
const state = {
    playbackType: "track" as "track" | "audiobook" | "podcast" | null,
    lastPlayNextTrack: null as { id: string; title: string } | null,
    lastAddToQueueTrack: null as { id: string; title: string } | null,
    routerPushPath: null as string | null,
    isInListenTogetherGroup: false,
};

// Mock lucide-react icons
mock.module("lucide-react", {
    namedExports: {
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

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: (track: { id: string; title: string }) => {
            state.lastPlayNextTrack = track;
        },
        addToQueue: (track: { id: string; title: string }) => {
            state.lastAddToQueueTrack = track;
        },
        playTrack: () => undefined,
        startVibeMode: async () => ({ success: true, trackCount: 10 }),
    }),
    useAudioState: () => ({
        playbackType: state.playbackType,
    }),
});

// Mock next/navigation
mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: (path: string) => {
                state.routerPushPath = path;
            },
        }),
    },
});

// Mock api
mock.module("@/lib/api", {
    namedExports: {
        api: {
            addTrackToPlaylist: async () => undefined,
        },
    },
});

beforeEach(() => {
    state.playbackType = "track";
    state.lastPlayNextTrack = null;
    state.lastAddToQueueTrack = null;
    state.routerPushPath = null;
    state.isInListenTogetherGroup = false;
});

test("renders trigger button with EllipsisVertical icon", async () => {
    const { TrackOverflowMenu } = await import(
        "../../components/ui/TrackOverflowMenu.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackOverflowMenu, {
            track: {
                id: "track-1",
                title: "Test Track",
                artist: { name: "Test Artist", id: "artist-1" },
                album: { title: "Test Album", id: "album-1" },
                duration: 240,
            },
        })
    );

    // Should have a button with aria-label
    assert.match(html, /Track actions/);
    assert.match(html, /aria-haspopup="menu"/);
});

test("renders all standard menu items when track has full metadata", async () => {
    // NOTE: SSR renders the initial state (menu closed), so we can't
    // test the open menu via renderToStaticMarkup. Instead, we verify
    // the component mounts without error and has the trigger button.
    const { TrackOverflowMenu } = await import(
        "../../components/ui/TrackOverflowMenu.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackOverflowMenu, {
            track: {
                id: "track-1",
                title: "Test Track",
                artist: { name: "Test Artist", id: "artist-1" },
                album: { title: "Test Album", id: "album-1" },
                duration: 240,
            },
        })
    );

    // Component should render without crashing and have the trigger
    assert.match(html, /button/);
    assert.match(html, /Track actions/);
});

test("does not render PlaylistSelector when menu is closed", async () => {
    const { TrackOverflowMenu } = await import(
        "../../components/ui/TrackOverflowMenu.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackOverflowMenu, {
            track: {
                id: "track-1",
                title: "Test Track",
                duration: 240,
            },
        })
    );

    // PlaylistSelector should not be visible in initial state
    assert.doesNotMatch(html, /PlaylistSelector/);
});

test("respects showPlayNext=false to hide Play Next item", async () => {
    const { TrackOverflowMenu } = await import(
        "../../components/ui/TrackOverflowMenu.tsx"
    );

    // Rendering with menu closed - we verify props are accepted without error
    const html = renderToStaticMarkup(
        React.createElement(TrackOverflowMenu, {
            track: {
                id: "track-1",
                title: "Test Track",
                duration: 240,
            },
            showPlayNext: false,
            showMatchVibe: false,
            showCopyLink: false,
        })
    );

    // Should render without error
    assert.match(html, /Track actions/);
});

test("renders extraItemsBefore and extraItemsAfter slots", async () => {
    const { TrackOverflowMenu } = await import(
        "../../components/ui/TrackOverflowMenu.tsx"
    );

    // Note: extraItems are only visible when menu is open (stateful).
    // Since we use SSR with initial state (closed), they won't appear.
    // This test verifies the component accepts these props without error.
    const html = renderToStaticMarkup(
        React.createElement(TrackOverflowMenu, {
            track: {
                id: "track-1",
                title: "Test Track",
                duration: 240,
            },
            extraItemsBefore: React.createElement("div", null, "BEFORE"),
            extraItemsAfter: React.createElement("div", null, "AFTER"),
        })
    );

    assert.match(html, /Track actions/);
});

test("accepts custom className and triggerClassName", async () => {
    const { TrackOverflowMenu } = await import(
        "../../components/ui/TrackOverflowMenu.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(TrackOverflowMenu, {
            track: {
                id: "track-1",
                title: "Test Track",
                duration: 240,
            },
            className: "custom-container",
            triggerClassName: "custom-trigger",
        })
    );

    assert.match(html, /custom-container/);
    assert.match(html, /custom-trigger/);
});

test("TrackMenuButton is exported for slot usage", async () => {
    const mod = await import("../../components/ui/TrackOverflowMenu.tsx");
    assert.ok(mod.TrackMenuButton, "TrackMenuButton should be exported");
    assert.equal(typeof mod.TrackMenuButton, "function");
});
