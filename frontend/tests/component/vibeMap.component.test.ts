import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Static render smoke tests for VibeMap. renderToStaticMarkup does not run
 * effects, so the async map load never resolves here — these assertions cover
 * the always-rendered shell (spotlight, mood chips, visible-count) and graceful
 * behaviour when the map API will reject. The interaction/viewport/filter logic
 * is covered in depth by the unit tests.
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
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTrack: () => undefined,
        }),
    },
});

beforeEach(() => {
    state.rejectMap = false;
});

test("renders the spotlight input, mood chips and visible-count shell", async () => {
    const { VibeMap } = await import("../../components/vibe/VibeMap");
    const html = renderToStaticMarkup(React.createElement(VibeMap));

    // Spotlight search input.
    assert.match(html, /Spotlight a vibe/);
    // Mood legend chips (now toggles).
    assert.match(html, />Happy</);
    assert.match(html, />Sad</);
    assert.match(html, />Relaxed</);
    assert.match(html, />Party</);
    // "N of M visible" count element (pre-load count is 0 under static render).
    assert.match(html, /of\s+0\s+visible/);
    // Energy/valence range filters are present.
    assert.match(html, /Energy/);
    assert.match(html, /Valence/);
});

test("renders its shell without throwing when the map API rejects", async () => {
    state.rejectMap = true;
    const { VibeMap } = await import("../../components/vibe/VibeMap");

    let html = "";
    assert.doesNotThrow(() => {
        html = renderToStaticMarkup(React.createElement(VibeMap));
    });
    // The controls shell still renders even though the data load will fail.
    assert.match(html, /Spotlight a vibe/);
    assert.match(html, />Happy</);
});
