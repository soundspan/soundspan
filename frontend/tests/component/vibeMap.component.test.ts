import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Static render smoke tests for VibeMap. renderToStaticMarkup does not run
 * effects, so the async map load never resolves here — these assertions cover
 * the always-rendered floating control shell (spotlight pill, view controls,
 * the collapsed filters pill with its count) and graceful behaviour when the
 * map API will reject. Media queries resolve to their SSR default (false), so
 * the desktop layout renders. The now-playing card is intentionally absent
 * (nothing is playing). Interaction/viewport/filter logic is covered in depth
 * by the unit tests; the filters/now-playing markup by vibePanels.
 */

const state: { rejectMap: boolean } = { rejectMap: false };

const sampleTracks = [
    {
        id: "t1",
        x: 0.1,
        y: 0.2,
        title: "Track One",
        artist: "Artist A",
        artistId: "a1",
        albumId: "al1",
        coverUrl: null,
        dominantMood: "moodHappy",
        moodScore: 0.9,
        moods: {},
        energy: 0.8,
        valence: 0.7,
    },
    {
        id: "t2",
        x: 0.6,
        y: 0.7,
        title: "Track Two",
        artist: "Artist B",
        artistId: "a2",
        albumId: "al2",
        coverUrl: null,
        dominantMood: "moodSad",
        moodScore: 0.6,
        moods: {},
        energy: 0.2,
        valence: 0.3,
    },
];

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getVibeMap: async () => {
                if (state.rejectMap) throw new Error("boom");
                return {
                    tracks: sampleTracks,
                    trackCount: sampleTracks.length,
                    computedAt: new Date().toISOString(),
                };
            },
            getVibeCalibration: async () => ({ sampleSize: 0, quantiles: [] }),
            vibeSearch: async () => ({ query: "", tracks: [] }),
        },
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: null,
            currentAudiobook: null,
            currentPodcast: null,
            playbackType: "track",
            queue: [],
            currentIndex: -1,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTrack: () => undefined,
            playTracks: () => undefined,
            addToQueue: () => undefined,
            moveQueueItem: () => undefined,
            removeFromQueue: () => undefined,
            pause: () => undefined,
            play: () => undefined,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({ isPlaying: false, currentTime: 0, duration: 0 }),
    },
});

mock.module("@/lib/listen-together-context", {
    namedExports: {
        useListenTogether: () => ({ isInGroup: false }),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useMediaQuery: () => false,
        useIsMobile: () => true,
        useIsTablet: () => false,
    },
});

beforeEach(() => {
    state.rejectMap = false;
});

test("renders the floating spotlight, view controls and filters pill shell", async () => {
    const { VibeMap } = await import("../../components/vibe/VibeMap");
    const html = renderToStaticMarkup(React.createElement(VibeMap));

    // Spotlight search pill (input still carries the accessible label).
    assert.match(html, /Spotlight a vibe/);
    // View controls extracted to the top-right stack expose aria-labels.
    assert.match(html, /aria-label="Zoom in"/);
    assert.match(html, /aria-label="Reset view"/);
    assert.match(html, /aria-label="Enter fullscreen"/);
    // Filters collapse to a pill with the visible/total count (0/0 pre-load).
    assert.match(html, /Filters/);
    assert.match(html, /0\/0/);
    // Nothing is playing -> the now-playing card is absent.
    assert.doesNotMatch(html, /aria-label="Pause"/);
});

test("renders its shell without throwing when the map API rejects", async () => {
    state.rejectMap = true;
    const { VibeMap } = await import("../../components/vibe/VibeMap");

    let html = "";
    assert.doesNotThrow(() => {
        html = renderToStaticMarkup(React.createElement(VibeMap));
    });
    // The floating controls shell still renders even though the load will fail.
    assert.match(html, /Spotlight a vibe/);
    assert.match(html, /aria-label="Zoom in"/);
    assert.match(html, /Filters/);
});

test("map tab renders full-bleed and clears the mobile player", async () => {
    const { VibeMapTab } = await import("../../components/vibe/VibeMapTab");
    const html = renderToStaticMarkup(React.createElement(VibeMapTab, {
        currentTrackPresent: true,
        onExplore: () => undefined,
    }));

    assert.match(html, /absolute inset-0 overflow-hidden/);
    assert.match(html, /aria-label="Map view \(current\)"/);
    assert.match(html, /--vibe-binset:64px/);
});
