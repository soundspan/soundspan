import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Component tests for MiniPlayer enhancements.
 *
 * Phase 4: Add Next Track button and thumbs-up to the MiniPlayer.
 *
 * Tests verify:
 * - MiniPlayer renders a "Next track" button alongside play/pause
 * - MiniPlayer renders TrackPreferenceButtons (thumbs-up) for tracks
 * - MiniPlayer does NOT render Next/thumbs when no media is playing
 */

// Shared mutable state
const state = {
    currentTrack: null as { id: string; title: string; streamSource?: string; duration?: number } | null,
    currentAudiobook: null as { id: string; title: string; duration?: number } | null,
    currentPodcast: null as { id: string; title: string; duration?: number } | null,
    playbackType: "track" as "track" | "audiobook" | "podcast" | null,
    isPlaying: false,
    isBuffering: false,
    currentTime: 0,
    duration: 200,
    audioError: null as string | null,
    isMobile: true,
    isTablet: false,
    playerMode: "mini" as string,
};

// Stub icon component
const Icon = (props: Record<string, unknown>) => React.createElement("i", props);

// Mock lucide-react
mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        Music: Icon,
        Loader2: Icon,
        RefreshCw: Icon,
        SkipForward: Icon,
    },
});

// Mock cn
mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

// Mock formatTime
mock.module("@/utils/formatTime", {
    namedExports: {
        clampTime: (time: number) => time,
        formatTime: (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    },
});

// Mock audio context (useAudio)
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudio: () => ({
            currentTrack: state.currentTrack,
            currentAudiobook: state.currentAudiobook,
            currentPodcast: state.currentPodcast,
            playbackType: state.playbackType,
            isPlaying: state.isPlaying,
            isBuffering: state.isBuffering,
            currentTime: state.currentTime,
            duration: state.duration,
            audioError: state.audioError,
            clearAudioError: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            next: () => undefined,
            setPlayerMode: () => undefined,
        }),
    },
});

// Mock useMediaInfo
mock.module("@/hooks/useMediaInfo", {
    namedExports: {
        useMediaInfo: () => ({
            title: state.currentTrack?.title ?? "Unknown",
            subtitle: "Test Artist",
            coverUrl: null,
            hasMedia: !!state.currentTrack || !!state.currentAudiobook || !!state.currentPodcast,
        }),
    },
});

// Mock useStreamBitrate
mock.module("@/hooks/useStreamBitrate", {
    namedExports: {
        useStreamBitrate: () => ({
            bitrate: null,
            codec: null,
            tidalQuality: null,
            localQuality: null,
        }),
        formatLocalQualityBadge: () => null,
        formatYtQualityBadge: () => null,
    },
});

// Mock useMediaQuery
mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});

// Mock next/image
mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", { src: props.src as string, alt: props.alt as string }),
});

// Mock framer-motion (motion.div renders as plain div)
mock.module("framer-motion", {
    namedExports: {
        motion: {
            div: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
                React.createElement("div", props, children),
        },
    },
});

// Mock TidalBadge
mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => null,
    },
});

// Mock SyncBadge
mock.module("@/components/player/SyncBadge", {
    namedExports: {
        SyncBadge: () => null,
    },
});

// Mock TrackPreferenceButtons
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: (props: { trackId: string }) =>
            React.createElement("div", { "data-testid": "track-pref-buttons", "data-track-id": props.trackId }, "thumbs"),
    },
});

beforeEach(() => {
    state.currentTrack = { id: "t1", title: "Test Track", duration: 200 };
    state.currentAudiobook = null;
    state.currentPodcast = null;
    state.playbackType = "track";
    state.isPlaying = true;
    state.isBuffering = false;
    state.currentTime = 60;
    state.duration = 200;
    state.audioError = null;
    state.isMobile = true;
    state.isTablet = false;
    state.playerMode = "mini";
});

test("MiniPlayer renders Next Track button", async () => {
    const { MiniPlayer } = await import("../../components/player/MiniPlayer.tsx");

    const html = renderToStaticMarkup(React.createElement(MiniPlayer));

    // Should have a "Next track" button
    assert.match(html, /Next track/, "Should have Next track button");
});

test("MiniPlayer renders thumbs-up (TrackPreferenceButtons) for tracks", async () => {
    const { MiniPlayer } = await import("../../components/player/MiniPlayer.tsx");

    const html = renderToStaticMarkup(React.createElement(MiniPlayer));

    // Should render TrackPreferenceButtons with the track id
    assert.match(html, /track-pref-buttons/, "Should render TrackPreferenceButtons");
    assert.match(html, /data-track-id="t1"/, "Should pass correct track ID");
});

test("MiniPlayer does not render Next/thumbs when no media playing", async () => {
    state.currentTrack = null;
    state.playbackType = null;

    const { MiniPlayer } = await import("../../components/player/MiniPlayer.tsx");

    const html = renderToStaticMarkup(React.createElement(MiniPlayer));

    // MiniPlayer returns null when not on mobile or no media
    // Since hasMedia is false, it should return null (empty string from SSR)
    assert.equal(html, "", "Should not render when no media");
});

test("MiniPlayer does not render thumbs for audiobook playback", async () => {
    state.currentTrack = null;
    state.currentAudiobook = { id: "ab1", title: "Test Audiobook", duration: 3600 };
    state.playbackType = "audiobook";

    const { MiniPlayer } = await import("../../components/player/MiniPlayer.tsx");

    const html = renderToStaticMarkup(React.createElement(MiniPlayer));

    // Should still render the player (audiobook is media)
    assert.match(html, /Test Audiobook|Playback controls/, "Should render MiniPlayer for audiobook");
    // But should NOT render TrackPreferenceButtons for audiobooks
    assert.doesNotMatch(html, /track-pref-buttons/, "Should not render thumbs for audiobook");
});
