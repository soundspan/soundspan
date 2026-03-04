import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const runtimeState = {
    currentTrackId: null as string | null,
    queuedTrackIds: new Set<string>(),
    overflowCalls: [] as Array<Record<string, unknown>>,
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        AudioLines: Icon,
        Music: Icon,
        Play: Icon,
    },
});

mock.module("@/utils/formatTime", {
    namedExports: {
        formatTime: (seconds: number) => `t:${seconds}`,
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ src, alt }: { src: string; alt: string }) =>
            React.createElement("img", { src, alt }),
    },
});

mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: (props: Record<string, unknown>) => {
            runtimeState.overflowCalls.push(props);
            return React.createElement("div", null, "overflow-menu");
        },
    },
});

mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: {
        TrackPreferenceButtons: ({ trackId }: { trackId: string }) =>
            React.createElement("div", null, `prefs:${trackId}`),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: runtimeState.currentTrackId
                ? { id: runtimeState.currentTrackId }
                : null,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => runtimeState.queuedTrackIds,
    },
});

beforeEach(() => {
    runtimeState.currentTrackId = null;
    runtimeState.queuedTrackIds = new Set();
    runtimeState.overflowCalls = [];
});

type TrackExports = {
    TrackList: (props: Record<string, unknown>) => React.ReactElement;
    TrackListHeader: (props: Record<string, unknown>) => React.ReactElement;
    TrackRow: (props: Record<string, unknown>) => React.ReactElement;
    InQueueBadge: () => React.ReactElement;
    PreviewBadge: () => React.ReactElement;
    LoadingBadge: () => React.ReactElement;
    UnplayableBadge: () => React.ReactElement;
};

async function loadTrackExports(): Promise<TrackExports> {
    const mod = await import("../../components/track");
    const named = mod as Record<string, unknown>;
    const cjsDefault = (mod as { default?: Record<string, unknown> }).default ?? {};
    const read = (name: keyof TrackExports) => {
        const value = named[name] ?? cjsDefault[name];
        assert.ok(value, `${name} export is available`);
        return value as TrackExports[typeof name];
    };

    return {
        TrackList: read("TrackList"),
        TrackListHeader: read("TrackListHeader"),
        TrackRow: read("TrackRow"),
        InQueueBadge: read("InQueueBadge"),
        PreviewBadge: read("PreviewBadge"),
        LoadingBadge: read("LoadingBadge"),
        UnplayableBadge: read("UnplayableBadge"),
    };
}

const sampleItems = [
    { id: "track-1", title: "Track One", artist: "Artist One", duration: 181, cover: null },
    { id: "track-2", title: "Track Two", artist: "Artist Two", duration: 205, cover: "https://img.test/2.jpg" },
];

function toRowItem(item: (typeof sampleItems)[number]) {
    return {
        id: item.id,
        title: item.title,
        artistName: item.artist,
        duration: item.duration,
        coverArtUrl: item.cover,
    };
}

test("TrackList renders loadingState and emptyState branches deterministically", async () => {
    const { TrackList } = await loadTrackExports();

    const loadingHtml = renderToStaticMarkup(
        React.createElement(TrackList, {
            items: sampleItems,
            toRowItem,
            onPlay: () => undefined,
            isLoading: true,
            loadingState: React.createElement("div", null, "loading-state"),
        })
    );
    assert.match(loadingHtml, /loading-state/);

    const emptyHtml = renderToStaticMarkup(
        React.createElement(TrackList, {
            items: [],
            toRowItem,
            onPlay: () => undefined,
            isLoading: false,
            emptyState: React.createElement("div", null, "empty-state"),
        })
    );
    assert.match(emptyHtml, /empty-state/);
});

test("TrackList computes row state for current and queued items", async () => {
    const { TrackList } = await loadTrackExports();

    runtimeState.currentTrackId = "track-2";
    runtimeState.queuedTrackIds = new Set(["track-1"]);

    const html = renderToStaticMarkup(
        React.createElement(TrackList, {
            items: sampleItems,
            toRowItem,
            onPlay: () => undefined,
            className: "track-list-root",
            rowSlots: (_item: (typeof sampleItems)[number], index: number, state: { isPlaying: boolean; isInQueue: boolean }) =>
                ({
                    middleColumns: React.createElement(
                        "span",
                        null,
                        `state:${index}:${String(state.isPlaying)}:${String(state.isInQueue)}`
                    ),
                }),
            rowOverflow: (item: (typeof sampleItems)[number]) => ({
                track: {
                    id: item.id,
                    title: item.title,
                    duration: item.duration,
                    streamSource: "library",
                    artist: { name: item.artist },
                    album: { title: "Album" },
                },
            }),
        })
    );

    assert.match(html, /track-list-root/);
    assert.match(html, /state:0:false:true/);
    assert.match(html, /state:1:true:false/);
    assert.equal(
        runtimeState.overflowCalls.length,
        2,
        "overflow menu receives one config per rendered row"
    );
});

test("TrackListHeader renders provided columns with shared header classes", async () => {
    const { TrackListHeader } = await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(TrackListHeader, {
            className: "grid-cols-[40px_1fr_auto]",
            columns: [
                { label: "#", className: "text-center" },
                { label: "Title" },
                { label: "Album" },
            ],
        })
    );

    assert.match(html, /hidden md:grid/);
    assert.match(html, /grid-cols-\[40px_1fr_auto\]/);
    assert.match(html, /text-center/);
    assert.match(html, /Title/);
    assert.match(html, /Album/);
});

test("TrackRow renders queue badge, duration, preferences, and overflow actions", async () => {
    const { TrackRow } = await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(TrackRow, {
            item: {
                id: "track-1",
                title: "Playable Track",
                artistName: "Artist",
                duration: 181,
                coverArtUrl: null,
            },
            index: 0,
            isPlaying: true,
            isInQueue: true,
            accentColor: "#22c55e",
            overflowProps: {
                track: {
                    id: "track-1",
                    title: "Playable Track",
                    duration: 181,
                    streamSource: "library",
                    artist: { name: "Artist" },
                    album: { title: "Album" },
                },
            },
        })
    );

    assert.match(html, /IN QUEUE/);
    assert.match(html, /t:181/);
    assert.match(html, /prefs:track-1/);
    assert.match(html, /overflow-menu/);
    assert.match(html, /color:#22c55e/);
});

test("TrackRow supports slot overrides for custom row composition", async () => {
    const { TrackRow } = await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(TrackRow, {
            item: {
                id: "track-slot",
                title: "Slot Track",
                artistName: "Default Artist",
                duration: 90,
                coverArtUrl: null,
            },
            index: 1,
            showCoverArt: false,
            preferenceMode: null,
            overflowProps: null,
            slots: {
                leadingColumn: React.createElement("span", null, "lead-slot"),
                artistContent: React.createElement("span", null, "artist-slot"),
                trailingActions: React.createElement("span", null, "trail-slot"),
                rowClassName: "extra-row",
            },
        })
    );

    assert.match(html, /lead-slot/);
    assert.match(html, /artist-slot/);
    assert.match(html, /trail-slot/);
    assert.match(html, /extra-row/);
    assert.doesNotMatch(html, /prefs:/);
    assert.doesNotMatch(html, /overflow-menu/);
});

test("TrackRow enter key handler triggers play callback and prevents default", async () => {
    const { TrackRow } = await loadTrackExports();

    let playCalls = 0;
    let preventDefaultCalls = 0;
    const element = TrackRow({
        item: {
            id: "track-key",
            title: "Keyboard Track",
            artistName: "Artist",
            duration: 120,
            coverArtUrl: null,
        },
        index: 3,
        onPlay: () => {
            playCalls += 1;
        },
    });

    const onKeyDown = (element.props as { onKeyDown?: (event: { key: string; preventDefault: () => void }) => void }).onKeyDown;
    assert.equal(typeof onKeyDown, "function");

    onKeyDown?.({
        key: "Enter",
        preventDefault: () => {
            preventDefaultCalls += 1;
        },
    });
    onKeyDown?.({
        key: "Space",
        preventDefault: () => {
            preventDefaultCalls += 1;
        },
    });

    assert.equal(playCalls, 1);
    assert.equal(preventDefaultCalls, 1);
});

test("track badges render all expected labels", async () => {
    const {
        InQueueBadge,
        PreviewBadge,
        LoadingBadge,
        UnplayableBadge,
    } = await loadTrackExports();

    const html = renderToStaticMarkup(
        React.createElement(
            "div",
            null,
            React.createElement(InQueueBadge),
            React.createElement(PreviewBadge),
            React.createElement(LoadingBadge),
            React.createElement(UnplayableBadge),
        )
    );

    assert.match(html, /IN QUEUE/);
    assert.match(html, /PREVIEW/);
    assert.match(html, /LOADING/);
    assert.match(html, /UNPLAYABLE/);
});
