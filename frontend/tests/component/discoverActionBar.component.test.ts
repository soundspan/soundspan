import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

const baseProps = {
    playlist: {
        id: "discover-1",
        name: "Discover Weekly",
        tracks: [
            { id: "t1", title: "Song 1" },
            { id: "t2", title: "Song 2" },
        ],
    },
    config: { enabled: true },
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
            playlist: { id: "empty", name: "Empty", tracks: [] },
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
