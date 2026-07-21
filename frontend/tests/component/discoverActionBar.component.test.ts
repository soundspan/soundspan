import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
    DiscoverConfig,
    DiscoverPlaylist,
    DiscoverTrack,
} from "../../features/discover/types";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        RefreshCw: Icon,
        Settings: Icon,
        Loader2: Icon,
        Plus: Icon,
        Shuffle: Icon,
        ListMusic: Icon,
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            triggerPlayFeedback: () => undefined,
        }),
    },
});

const noop = () => undefined;

// DiscoverActionBar only ever reads playlist.tracks.length and
// config.enabled, but its props type is the full DiscoverPlaylist/
// DiscoverConfig contract (other real callers pass genuine API payloads), so
// fixtures here need every required field, not just the ones this component
// happens to branch on.
function buildTrack(overrides: Partial<DiscoverTrack> = {}): DiscoverTrack {
    return {
        id: "t1",
        title: "Song 1",
        artist: "Discover Artist",
        album: "Discover Album",
        albumId: "album-1",
        isLiked: false,
        likedAt: null,
        similarity: 0.9,
        tier: "high",
        coverUrl: null,
        available: true,
        duration: 200,
        ...overrides,
    };
}

function buildPlaylist(overrides: Partial<DiscoverPlaylist> = {}): DiscoverPlaylist {
    return {
        weekStart: "2026-02-16",
        weekEnd: "2026-02-23",
        tracks: [
            buildTrack({ id: "t1", title: "Song 1" }),
            buildTrack({ id: "t2", title: "Song 2" }),
        ],
        unavailable: [],
        totalCount: 2,
        unavailableCount: 0,
        ...overrides,
    };
}

function buildConfig(overrides: Partial<DiscoverConfig> = {}): DiscoverConfig {
    return {
        playlistSize: 30,
        exclusionMonths: 6,
        downloadRatio: 1.2,
        enabled: true,
        lastGeneratedAt: null,
        ...overrides,
    };
}

const baseProps = {
    playlist: buildPlaylist(),
    config: buildConfig(),
    isPlaylistPlaying: false,
    isPlaying: false,
    onPlayToggle: noop,
    onGenerate: noop,
    onToggleSettings: noop,
    onAddToPlaylist: noop,
    onShuffle: noop,
    onAddAllToQueue: noop,
    isGenerating: false,
};

beforeEach(() => {
    // Reset to defaults — each test clones baseProps as needed
});

test("DiscoverActionBar renders all consolidated buttons when playlist has tracks", async () => {
    const { DiscoverActionBar } = await import(
        "../../features/discover/components/DiscoverActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(DiscoverActionBar, baseProps)
    );

    assert.match(html, /<span>Play All<\/span>/);
    assert.match(html, /title="Shuffle all"/);
    assert.match(html, /title="Add all to queue"/);
    assert.match(html, /title="Add all to playlist"/);
    assert.match(html, /title="Regenerate"/);
    assert.match(html, /title="Settings"/);
});

test("DiscoverActionBar hides play-related buttons when playlist is null", async () => {
    const { DiscoverActionBar } = await import(
        "../../features/discover/components/DiscoverActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(DiscoverActionBar, {
            ...baseProps,
            playlist: null,
        })
    );

    assert.doesNotMatch(html, /<span>Play All<\/span>/);
    assert.doesNotMatch(html, /title="Shuffle all"/);
    assert.doesNotMatch(html, /title="Add all to queue"/);
    assert.doesNotMatch(html, /title="Add all to playlist"/);
    // Regenerate and Settings should still be visible
    assert.match(html, /title="Generate"/);
    assert.match(html, /title="Settings"/);
});

test("DiscoverActionBar hides play-related buttons when playlist has no tracks", async () => {
    const { DiscoverActionBar } = await import(
        "../../features/discover/components/DiscoverActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(DiscoverActionBar, {
            ...baseProps,
            playlist: buildPlaylist({ tracks: [], totalCount: 0 }),
        })
    );

    assert.doesNotMatch(html, /<span>Play All<\/span>/);
    assert.doesNotMatch(html, /title="Shuffle all"/);
    assert.doesNotMatch(html, /title="Add all to queue"/);
});

test("DiscoverActionBar shows Pause when playlist is playing", async () => {
    const { DiscoverActionBar } = await import(
        "../../features/discover/components/DiscoverActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(DiscoverActionBar, {
            ...baseProps,
            isPlaylistPlaying: true,
            isPlaying: true,
        })
    );

    assert.match(html, /<span>Pause<\/span>/);
    assert.doesNotMatch(html, /<span>Play All<\/span>/);
});

test("DiscoverActionBar hides Shuffle when onShuffle is not provided", async () => {
    const { DiscoverActionBar } = await import(
        "../../features/discover/components/DiscoverActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(DiscoverActionBar, {
            ...baseProps,
            onShuffle: undefined,
        })
    );

    assert.doesNotMatch(html, /title="Shuffle all"/);
    // Other buttons should still be present
    assert.match(html, /title="Add all to queue"/);
});

test("DiscoverActionBar hides Add to Queue when onAddAllToQueue is not provided", async () => {
    const { DiscoverActionBar } = await import(
        "../../features/discover/components/DiscoverActionBar"
    );
    const html = renderToStaticMarkup(
        React.createElement(DiscoverActionBar, {
            ...baseProps,
            onAddAllToQueue: undefined,
        })
    );

    assert.doesNotMatch(html, /title="Add all to queue"/);
    assert.match(html, /title="Shuffle all"/);
});
