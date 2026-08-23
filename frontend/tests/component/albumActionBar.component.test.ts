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
        ListMusic: icon("list-music"),
        Plus: icon("plus"),
        Share2: icon("share2"),
        Loader2: icon("loader2"),
        Search: icon("search"),
        Heart: icon("heart"),
        Check: icon("check"),
        Send: icon("send"),
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

mock.module("@/components/ui/ReleaseSelectionModal", {
    namedExports: {
        ReleaseSelectionModal: () => null,
    },
});

mock.module("@/components/ui/ShareLinkModal", {
    namedExports: {
        ShareLinkModal: () => null,
    },
});

const noop = () => undefined;

const baseProps = {
    album: {
        id: "album-1",
        title: "Album One",
        artist: { id: "artist-1", name: "Artist" },
        owned: true,
    },
    source: "library" as const,
    colors: null,
    onPlayAll: noop,
    onAddAllToQueue: noop,
    onShuffle: noop,
    onDownloadAlbum: noop,
    onAddToPlaylist: noop,
    onToggleAlbumLike: noop,
    isAlbumLiked: false,
    isPendingDownload: false,
    isApplyingAlbumPreference: false,
    isPlaying: false,
    isPlayingThisAlbum: false,
    onPause: noop,
    downloadsEnabled: true,
    isInListenTogetherGroup: false,
};

test("AlbumActionBar renders share button near other album actions", async () => {
    const { AlbumActionBar } =
        await import("../../features/album/components/AlbumActionBar");

    const html = renderToStaticMarkup(
        React.createElement(AlbumActionBar, baseProps),
    );

    assert.match(html, /title="Share album"/);
    assert.match(html, /title="Shuffle play"/);
    assert.match(html, /title="Add all to queue"/);
});

test("AlbumActionBar still renders share button for non-library albums", async () => {
    const { AlbumActionBar } =
        await import("../../features/album/components/AlbumActionBar");

    const html = renderToStaticMarkup(
        React.createElement(AlbumActionBar, {
            ...baseProps,
            album: {
                ...baseProps.album,
                owned: false,
            },
            source: "discovery" as const,
        }),
    );

    assert.match(html, /title="Share album"/);
});

test("AlbumActionBar keeps remote albums playable and acquirable without album preference controls", async () => {
    const { AlbumActionBar } =
        await import("../../features/album/components/AlbumActionBar");

    const html = renderToStaticMarkup(
        React.createElement(AlbumActionBar, {
            ...baseProps,
            album: {
                ...baseProps.album,
                owned: false,
                rgMbid: "remote-release-group",
            },
            source: "remote" as const,
        }),
    );

    assert.match(html, />Play All</);
    assert.match(html, />Download</);
    assert.match(html, />Search</);
    assert.match(html, /title="Add to playlist"/);
    assert.doesNotMatch(html, /Like every track on this album/);
    assert.doesNotMatch(html, /Remove like from all tracks/);
});

test("AlbumActionBar shows Request instead of Download for non-admin viewers", async () => {
    const { AlbumActionBar } =
        await import("../../features/album/components/AlbumActionBar");

    const html = renderToStaticMarkup(
        React.createElement(AlbumActionBar, {
            ...baseProps,
            album: {
                ...baseProps.album,
                owned: false,
                rgMbid: "real-release-group",
            },
            source: "discovery" as const,
            downloadsEnabled: false,
            requestsEnabled: true,
            onRequestAlbum: noop,
        }),
    );

    assert.match(html, />Request</);
    assert.doesNotMatch(html, />Download</);
    assert.doesNotMatch(html, />Search</);
});

test("AlbumActionBar renders a disabled Requested state for open requests", async () => {
    const { AlbumActionBar } =
        await import("../../features/album/components/AlbumActionBar");

    const html = renderToStaticMarkup(
        React.createElement(AlbumActionBar, {
            ...baseProps,
            album: {
                ...baseProps.album,
                owned: false,
                rgMbid: "real-release-group",
            },
            source: "discovery" as const,
            downloadsEnabled: false,
            requestsEnabled: true,
            isRequestedAlbum: true,
            onRequestAlbum: noop,
        }),
    );

    assert.match(html, />Requested</);
    assert.match(html, /already have an open request/);
    assert.doesNotMatch(html, />Request</);
});

test("AlbumActionBar never shows Request to viewers with direct downloads", async () => {
    const { AlbumActionBar } =
        await import("../../features/album/components/AlbumActionBar");

    const html = renderToStaticMarkup(
        React.createElement(AlbumActionBar, {
            ...baseProps,
            album: {
                ...baseProps.album,
                owned: false,
                rgMbid: "real-release-group",
            },
            source: "discovery" as const,
            downloadsEnabled: true,
            requestsEnabled: true,
            onRequestAlbum: noop,
        }),
    );

    assert.match(html, />Download</);
    assert.doesNotMatch(html, />Request</);
});

test("AlbumActionBar hides acquisition controls for a synthetic remote release group", async () => {
    const { AlbumActionBar } =
        await import("../../features/album/components/AlbumActionBar");

    const html = renderToStaticMarkup(
        React.createElement(AlbumActionBar, {
            ...baseProps,
            album: {
                ...baseProps.album,
                owned: false,
                rgMbid: "remote:generated-hash",
            },
            source: "remote" as const,
        }),
    );

    assert.match(html, />Play All</);
    assert.doesNotMatch(html, />Download</);
    assert.doesNotMatch(html, />Search</);
});
