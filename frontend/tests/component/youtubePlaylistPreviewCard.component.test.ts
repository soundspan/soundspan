import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { YouTubePlaylistPreviewCard } from "../../features/search/components/YouTubePlaylistPreviewCard.tsx";
import type { YouTubePlaylistInfo } from "../../lib/youtube-bulk-download.ts";

const PLAYLIST: YouTubePlaylistInfo = {
    kind: "playlist",
    playlistId: "PL-abc123",
    channel: null,
    sourceUrl: "https://www.youtube.com/playlist?list=PL-abc123",
    title: "Late Night Mix",
    uploader: "Book Club Radio",
    totalCount: 3,
    truncated: false,
    count: 3,
    entries: [
        { videoId: "aaaaaaaaaaa", title: "Track One", uploader: "X", duration: 100 },
        { videoId: "bbbbbbbbbbb", title: "Track Two", uploader: "X", duration: 200 },
        { videoId: "ccccccccccc", title: "Track Three", uploader: "X", duration: 300 },
    ],
};

function render(props: Partial<Parameters<typeof YouTubePlaylistPreviewCard>[0]>) {
    return renderToStaticMarkup(
        React.createElement(YouTubePlaylistPreviewCard, {
            playlistInfo: PLAYLIST,
            isLoading: false,
            error: null,
            isDownloading: false,
            progress: null,
            onDownloadAll: async () => undefined,
            onCancel: () => undefined,
            ...props,
        })
    );
}

test("renders title, track count, entries, and a Download all button", () => {
    const html = render({});
    assert.match(html, /Late Night Mix/);
    assert.match(html, /Book Club Radio/);
    assert.match(html, /3 tracks/);
    assert.match(html, /Download all \(3\)/);
    assert.match(html, /Track One/);
    assert.match(html, /Track Three/);
});

test("collapses entries beyond the preview window into +N more", () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
        videoId: `v${i}aaaaaaaa`,
        title: `Song ${i}`,
        uploader: "X",
        duration: 100,
    }));
    const html = render({
        playlistInfo: { ...PLAYLIST, count: 8, totalCount: 8, entries },
    });
    assert.match(html, /\+3 more/);
});

test("shows a truncation note when the source has more than returned", () => {
    const html = render({
        playlistInfo: { ...PLAYLIST, truncated: true, totalCount: 500 },
    });
    assert.match(html, /Showing first 3 of 500 tracks/);
});

test("renders the loading skeleton", () => {
    const html = render({ isLoading: true, playlistInfo: null });
    assert.match(html, /animate-pulse/);
    assert.doesNotMatch(html, /Download all/);
});

test("renders the error message", () => {
    const html = render({
        playlistInfo: null,
        error: "This playlist is private.",
    });
    assert.match(html, /This playlist is private\./);
});

test("while downloading, shows aggregate progress and a Cancel control", () => {
    const html = render({
        isDownloading: true,
        progress: {
            total: 3,
            completed: 1,
            failed: 0,
            active: 2,
            pending: 0,
            pct: 33,
            done: false,
        },
    });
    assert.match(html, /1\/3/);
    assert.match(html, /Cancel/);
    assert.match(html, /width:33%/);
});
