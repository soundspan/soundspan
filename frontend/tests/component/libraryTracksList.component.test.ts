import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryTrack } from "../../features/search/types";

const playbackState = {
    currentTrack: null as { id: string } | null,
    isPlaying: false,
};

const controlCalls = {
    playTracks: [] as Array<{ tracks: unknown[]; index: number }>,
    pause: 0,
    resume: 0,
};

const trackListRenderState = {
    props: null as Record<string, unknown> | null,
};

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: playbackState.currentTrack,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({
            isPlaying: playbackState.isPlaying,
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: unknown[], index: number) => {
                controlCalls.playTracks.push({ tracks, index });
            },
            pause: () => {
                controlCalls.pause += 1;
            },
            resume: () => {
                controlCalls.resume += 1;
            },
        }),
    },
});

mock.module("@/components/track", {
    namedExports: {
        TrackList: (props: Record<string, unknown>) => {
            trackListRenderState.props = props;
            const items = Array.isArray(props.items) ? props.items : [];
            return React.createElement(
                "div",
                { "data-testid": "track-list" },
                `items:${items.length}`
            );
        },
    },
});

function buildTrack(id: string): LibraryTrack {
    return {
        id,
        title: `Track ${id}`,
        displayTitle: null,
        duration: 180,
        album: {
            id: `album-${id}`,
            title: `Album ${id}`,
            coverUrl: null,
            artist: {
                id: `artist-${id}`,
                name: `Artist ${id}`,
            },
        },
    };
}

beforeEach(() => {
    playbackState.currentTrack = null;
    playbackState.isPlaying = false;
    controlCalls.playTracks = [];
    controlCalls.pause = 0;
    controlCalls.resume = 0;
    trackListRenderState.props = null;
});

test("returns null when tracks is empty or undefined", async () => {
    const { LibraryTracksList } = await import(
        "../../features/search/components/LibraryTracksList"
    );

    const emptyHtml = renderToStaticMarkup(
        React.createElement(LibraryTracksList, { tracks: [] })
    );
    assert.equal(emptyHtml, "");
    assert.equal(trackListRenderState.props, null);

    const undefinedHtml = renderToStaticMarkup(
        React.createElement(LibraryTracksList as unknown as React.FC<any>, {
            tracks: undefined,
        })
    );
    assert.equal(undefinedHtml, "");
    assert.equal(trackListRenderState.props, null);
});

test("applies limit to rendered rows but play action still queues all tracks", async () => {
    const { LibraryTracksList } = await import(
        "../../features/search/components/LibraryTracksList"
    );
    const tracks = [buildTrack("1"), buildTrack("2"), buildTrack("3")];

    const html = renderToStaticMarkup(
        React.createElement(LibraryTracksList, {
            tracks,
            limit: 1,
        })
    );
    assert.match(html, /items:1/);

    const onPlay = trackListRenderState.props?.onPlay as
        | ((track: LibraryTrack, index: number) => void)
        | undefined;
    assert.ok(onPlay);
    onPlay(tracks[0], 0);

    assert.equal(controlCalls.playTracks.length, 1);
    assert.equal(controlCalls.playTracks[0].index, 0);
    const queued = controlCalls.playTracks[0].tracks as Array<{
        id: string;
        title: string;
        duration: number;
        artist: { id: string; name: string };
        album: { id: string; title: string; coverArt: string | null };
    }>;
    assert.deepEqual(
        queued.map((track) => track.id),
        ["1", "2", "3"]
    );
    assert.deepEqual(queued[0], {
        id: "1",
        title: "Track 1",
        displayTitle: null,
        duration: 180,
        artist: { id: "artist-1", name: "Artist 1" },
        album: { id: "album-1", title: "Album 1", coverArt: null },
    });
    assert.equal(controlCalls.pause, 0);
    assert.equal(controlCalls.resume, 0);
});

test("toggles pause/resume instead of requeueing when current track is selected", async () => {
    const { LibraryTracksList } = await import(
        "../../features/search/components/LibraryTracksList"
    );
    const tracks = [buildTrack("1"), buildTrack("2")];

    playbackState.currentTrack = { id: "1" };
    playbackState.isPlaying = true;
    renderToStaticMarkup(
        React.createElement(LibraryTracksList, { tracks })
    );
    let onPlay = trackListRenderState.props?.onPlay as
        | ((track: LibraryTrack, index: number) => void)
        | undefined;
    assert.ok(onPlay);
    onPlay(tracks[0], 0);
    assert.equal(controlCalls.pause, 1);
    assert.equal(controlCalls.resume, 0);
    assert.equal(controlCalls.playTracks.length, 0);

    playbackState.isPlaying = false;
    renderToStaticMarkup(
        React.createElement(LibraryTracksList, { tracks })
    );
    onPlay = trackListRenderState.props?.onPlay as
        | ((track: LibraryTrack, index: number) => void)
        | undefined;
    assert.ok(onPlay);
    onPlay(tracks[0], 0);
    assert.equal(controlCalls.pause, 1);
    assert.equal(controlCalls.resume, 1);
    assert.equal(controlCalls.playTracks.length, 0);
});
