import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const icon = (name: string) => {
    const MockIcon = (props: Record<string, unknown> = {}) =>
        React.createElement("svg", { ...props, "data-icon": name });
    MockIcon.displayName = `MockIcon${name}`;
    return MockIcon;
};

mock.module("lucide-react", {
    namedExports: {
        Play: icon("play"),
        Pause: icon("pause"),
        Shuffle: icon("shuffle"),
        Download: icon("download"),
        Radio: icon("radio"),
        ListMusic: icon("list-music"),
        Loader2: icon("loader2"),
        Plus: icon("plus"),
        Heart: icon("heart"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: () => undefined,
            success: () => undefined,
        },
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

const noop = () => undefined;

const baseArtist = { id: "artist-1", name: "Test Artist" };
const baseAlbums = [{ id: "album-1", title: "Album One", year: 2024, owned: true, availability: "available" }];

const baseProps = {
    artist: baseArtist,
    albums: baseAlbums,
    source: "library" as const,
    colors: null,
    onPlayAll: noop,
    onShuffle: noop,
    onDownloadAll: noop,
    isPendingDownload: false,
    isPlaying: false,
    isPlayingThisArtist: false,
    downloadsEnabled: true,
};

test("ArtistActionBar renders canonical button set for library artist", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            onAddAllToQueue: noop,
            onAddToPlaylist: noop,
            onLikeAll: noop,
            onStartRadio: noop,
        })
    );

    // Canonical order: Play, Shuffle, Add to Queue, Add to Playlist, Like All, Download, Radio
    assert.match(html, /<span>Play All<\/span>/);
    assert.match(html, /title="Shuffle play"/);
    assert.match(html, /title="Add all to queue"/);
    assert.match(html, /title="Add all to playlist"/);
    assert.match(html, /title="Like all tracks"/);
    assert.match(html, /title="Download all tracks"/);
    assert.match(html, /title="Start artist radio"/);
});

test("ArtistActionBar hides Add to Queue when callback is not provided", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            // onAddAllToQueue not provided
            onAddToPlaylist: noop,
            onLikeAll: noop,
        })
    );

    assert.doesNotMatch(html, /title="Add all to queue"/);
    assert.match(html, /title="Add all to playlist"/);
});

test("ArtistActionBar hides Add to Playlist and Like All for non-library artist", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            source: "discovery" as const,
            // Non-library: no playlist/like callbacks
        })
    );

    assert.doesNotMatch(html, /title="Add all to playlist"/);
    assert.doesNotMatch(html, /title="Like all tracks"/);
    // Play and Shuffle should still be there
    assert.match(html, /<span>Play All<\/span>/);
    assert.match(html, /title="Shuffle play"/);
});

test("ArtistActionBar shows Pause when artist is currently playing", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            isPlaying: true,
            isPlayingThisArtist: true,
        })
    );

    assert.match(html, /<span>Pause<\/span>/);
    assert.match(html, /data-icon="pause"/);
    assert.doesNotMatch(html, /<span>Play All<\/span>/);
});

test("ArtistActionBar shows spinner on Like All button when isLikingAll is true", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            onLikeAll: noop,
            isLikingAll: true,
        })
    );

    assert.match(html, /title="Like all tracks"/);
    assert.match(html, /data-icon="loader2"/);
    assert.doesNotMatch(html, /data-icon="heart"/);
});

test("ArtistActionBar shows heart icon when not liking", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            onLikeAll: noop,
            isLikingAll: false,
        })
    );

    assert.match(html, /data-icon="heart"/);
});

test("ArtistActionBar hides download button when downloadsEnabled is false", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            downloadsEnabled: false,
            // source is library and albums have availability != unavailable
            // but downloadsEnabled overrides
        })
    );

    assert.doesNotMatch(html, /title="Download all tracks"/);
});

test("ArtistActionBar shows Listen Together locked state", async () => {
    const { ArtistActionBar } = await import(
        "../../features/artist/components/ArtistActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(ArtistActionBar, {
            ...baseProps,
            isInListenTogetherGroup: true,
            onAddAllToQueue: noop,
        })
    );

    // Play and Shuffle should be locked (different styling, no standard buttons)
    assert.match(html, /Listen Together is active/);
    // Add to Queue should still appear (not locked)
    assert.match(html, /title="Add all to queue"/);
});
