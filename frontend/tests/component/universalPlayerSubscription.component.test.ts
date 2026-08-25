import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Regression guard for roadmap F12 item (A): UniversalPlayer — the animated
 * render root that mounts OverlayPlayer/MiniPlayer/FullPlayer — must subscribe to
 * the granular useAudioState() only, NEVER the compat useAudio() or
 * useAudioPlayback() that carry the 250ms currentTime tick. Re-subscribing would
 * re-render this whole AnimatePresence/LayoutGroup subtree 4x/second.
 *
 * The clock hooks are mocked as call-recording tripwires; the assertion is that
 * they are never invoked while useAudioState is.
 */

const calls = { useAudioState: 0, useAudio: 0, useAudioPlayback: 0 };

const stubState: {
    playerMode: string;
    currentTrack: unknown;
    currentAudiobook: unknown;
    currentPodcast: unknown;
} = {
    playerMode: "full",
    currentTrack: null,
    currentAudiobook: null,
    currentPodcast: null,
};

const media = { isMobile: false, isTablet: false };

mock.module("@/lib/audio-volume-mode-context", {
    namedExports: {
        useAudioVolumeMode: () => ({
            volume: 1,
            isMuted: false,
            get playerMode() {
                return stubState.playerMode;
            },
            previousPlayerMode: "full",
            setVolume: () => undefined,
            setIsMuted: () => undefined,
            setPlayerMode: () => undefined,
            setPreviousPlayerMode: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => {
            calls.useAudioState += 1;
            return stubState;
        },
    },
});

// Tripwires: a re-subscription regression calls one of these -> the count assert
// fails. They return broad stubs (rather than throwing) so a regression still
// renders and the failure is a clean assertion, not an opaque render crash.
mock.module("@/lib/audio-context", {
    namedExports: {
        useAudio: () => {
            calls.useAudio += 1;
            return { ...stubState, currentTime: 0, isPlaying: false };
        },
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => {
            calls.useAudioPlayback += 1;
            return { currentTime: 0, isPlaying: false };
        },
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => media.isMobile,
        useIsTablet: () => media.isTablet,
    },
});

const childStub = (label: string) => {
    const ChildStub = () =>
        React.createElement("div", { "data-stub": label }, label);
    ChildStub.displayName = `ChildStub(${label})`;
    return ChildStub;
};

mock.module("../../components/player/MiniPlayer.tsx", {
    namedExports: { MiniPlayer: childStub("mini-player-stub") },
});
mock.module("../../components/player/FullPlayer.tsx", {
    namedExports: { FullPlayer: childStub("full-player-stub") },
});
mock.module("../../components/player/OverlayPlayer.tsx", {
    namedExports: { OverlayPlayer: childStub("overlay-player-stub") },
});

mock.module("framer-motion", {
    namedExports: {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
        LayoutGroup: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
        motion: {
            div: ({ children }: { children?: React.ReactNode }) =>
                React.createElement("div", null, children),
        },
    },
});

beforeEach(() => {
    calls.useAudioState = 0;
    calls.useAudio = 0;
    calls.useAudioPlayback = 0;
    stubState.playerMode = "full";
    stubState.currentTrack = null;
    stubState.currentAudiobook = null;
    stubState.currentPodcast = null;
    media.isMobile = false;
    media.isTablet = false;
});

test("desktop: renders via useAudioState and never calls the ticking clock hooks", async () => {
    const { UniversalPlayer } =
        await import("../../components/player/UniversalPlayer");

    const html = renderToStaticMarkup(React.createElement(UniversalPlayer));

    assert.match(html, /full-player-stub/);
    assert.ok(
        calls.useAudioState >= 1,
        "UniversalPlayer must read the granular audio STATE context",
    );
    assert.equal(
        calls.useAudio,
        0,
        "UniversalPlayer must NOT re-subscribe to the merged useAudio() (250ms clock)",
    );
    assert.equal(
        calls.useAudioPlayback,
        0,
        "UniversalPlayer must NOT subscribe to useAudioPlayback() (250ms clock)",
    );
});

test("mobile overlay: drives playerMode + currentTrack from state, still no clock hooks", async () => {
    media.isMobile = true;
    stubState.playerMode = "overlay";
    stubState.currentTrack = { id: "track-1" };

    const { UniversalPlayer } =
        await import("../../components/player/UniversalPlayer");

    const html = renderToStaticMarkup(React.createElement(UniversalPlayer));

    assert.match(html, /overlay-player-stub/);
    assert.ok(calls.useAudioState >= 1);
    assert.equal(calls.useAudio, 0);
    assert.equal(calls.useAudioPlayback, 0);
});
