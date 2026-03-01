import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const executeCalls: Array<{ url: string; name?: string }> = [];

mock.module("@/lib/api", {
    namedExports: {
        api: {
            executePlaylistImport: async (input: {
                url: string;
                name?: string;
            }) => {
                executeCalls.push(input);
                return {
                    playlistId: "playlist-123",
                    summary: {
                        total: 4,
                        local: 1,
                        youtube: 1,
                        tidal: 1,
                        unresolved: 1,
                    },
                };
            },
        },
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YOUTUBE"),
    },
});

beforeEach(() => {
    executeCalls.length = 0;
});

test("preview list renders provider resolution badges per track", async () => {
    const { PreviewTrackResolutionList } = await import(
        "../../app/import/page.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(PreviewTrackResolutionList, {
            tracks: [
                {
                    index: 0,
                    artist: "Local Artist",
                    title: "Local Song",
                    source: "local",
                    confidence: 98,
                },
                {
                    index: 1,
                    artist: "YT Artist",
                    title: "YT Song",
                    source: "youtube",
                    confidence: 85,
                },
                {
                    index: 2,
                    artist: "Tidal Artist",
                    title: "Tidal Song",
                    source: "tidal",
                    confidence: 85,
                },
                {
                    index: 3,
                    artist: "Unknown Artist",
                    title: "Unknown Song",
                    source: "unresolved",
                    confidence: 0,
                },
            ],
        })
    );

    assert.match(html, /LOCAL/);
    assert.match(html, /YOUTUBE/);
    assert.match(html, /TIDAL/);
    assert.match(html, /UNRESOLVED/);
    assert.match(html, /No provider match/);
});

test("execute import action posts normalized payload for direct import", async () => {
    const { executeImportAction } = await import("../../app/import/page.tsx");

    await executeImportAction({
        url: "  https://open.spotify.com/playlist/abc123  ",
        name: "  Imported Playlist  ",
    });

    assert.equal(executeCalls.length, 1);
    assert.deepEqual(executeCalls[0], {
        url: "https://open.spotify.com/playlist/abc123",
        name: "Imported Playlist",
    });
});
