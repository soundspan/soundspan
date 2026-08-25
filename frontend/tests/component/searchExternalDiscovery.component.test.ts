import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("lucide-react", {
    namedExports: {
        Music: () => React.createElement("svg", { "data-icon": "music" }),
    },
});

mock.module("next/image", {
    defaultExport: ({ alt }: { alt?: string }) =>
        React.createElement("img", { alt }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => `/proxied/${url}`,
            getTidalStreamingStatus: async () => ({
                enabled: false,
                available: false,
                authenticated: false,
                credentialsConfigured: false,
            }),
            getYtMusicStatus: async () => ({
                enabled: false,
                available: false,
                authenticated: false,
                credentialsConfigured: false,
            }),
            matchTidalBatch: async () => ({ matches: [] }),
            matchYtMusicBatch: async () => ({ matches: [] }),
            addTrackToPlaylist: async () => undefined,
        },
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({ push: () => undefined }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: () => undefined,
            playNext: () => undefined,
            addToQueue: () => undefined,
            playTrack: () => undefined,
            startVibeMode: async () => ({ success: true, trackCount: 0 }),
        }),
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: { TidalBadge: () => null },
});
mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: () => null },
});
mock.module("@/components/ui/TrackOverflowMenu", {
    namedExports: {
        TrackOverflowMenu: () =>
            React.createElement("button", { "aria-haspopup": "menu" }),
    },
});

mock.module("@/components/ui/PeerBadge", {
    namedExports: {
        PeerBadge: () => React.createElement("span"),
    },
});

mock.module("@/lib/format", {
    namedExports: {
        formatListeners: (value: number) => String(value),
    },
});

const libraryArtist = {
    id: "lib-1",
    name: "Nick Drake",
    heroUrl: "",
};

const discoveryArtist = {
    type: "music",
    name: "Drake",
    mbid: "b49b81cc-d5b7-4bdd-aadb-385df8de69a6",
    image: "",
};

async function renderTopResult(preferDiscovery: boolean) {
    const { TopResult } =
        await import("../../features/search/components/TopResult");
    return renderToStaticMarkup(
        React.createElement(TopResult, {
            libraryArtist,
            discoveryArtist,
            preferDiscovery,
        } as never),
    );
}

test("top result prefers the library artist by default", async () => {
    const html = await renderTopResult(false);
    assert.match(html, /Nick Drake/);
    assert.match(html, /href="\/artist\/lib-1"/);
});

test("top result prefers an exact external match when asked", async () => {
    const html = await renderTopResult(true);
    assert.match(html, />Drake</);
    assert.match(html, /href="\/artist\/b49b81cc-d5b7-4bdd-aadb-385df8de69a6"/);
    assert.doesNotMatch(html, /Nick Drake/);
});

test("discover tracks render artist links and album context", async () => {
    const { DiscoverTracksList } =
        await import("../../features/search/components/DiscoverTracksList");
    const html = renderToStaticMarkup(
        React.createElement(DiscoverTracksList, {
            tracks: [
                {
                    type: "track",
                    id: "t1",
                    name: "Headlines",
                    artist: "Drake",
                    album: "Take Care",
                    image: "",
                },
                {
                    type: "track",
                    id: "t2",
                    name: "Orphan Song",
                    artist: "",
                    album: null,
                    image: "",
                },
            ],
        } as never),
    );

    // Rows are play/navigate buttons now, not bare artist links; unmatched
    // rows expose the artist destination through their accessible label.
    assert.match(html, /Headlines/);
    assert.match(html, /Drake — Take Care/);
    assert.match(html, /aria-label="Go to Drake"/);
    assert.match(html, /Orphan Song/);
    assert.doesNotMatch(html, /href="\/artist\//);
});
