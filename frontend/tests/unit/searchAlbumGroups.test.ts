import assert from "node:assert/strict";
import test from "node:test";
import { selectSearchAlbumGroups } from "../../features/search/searchAlbumGroups";

const libraryAlbum = {
    id: "a1",
    title: "The Downward Spiral",
    artist: { name: "Nine Inch Nails" },
};
const streamingAlbum = {
    id: "r1",
    title: "At Folsom Prison",
    artist: { name: "Johnny Cash" },
    source: "remote" as const,
    remoteSources: ["tidal" as const],
};
const results = {
    albums: [libraryAlbum],
    remoteAlbums: [streamingAlbum],
};

test("the All tab shows library albums and streaming albums in separate groups", () => {
    const groups = selectSearchAlbumGroups({
        filterTab: "all",
        showLibrary: true,
        libraryResults: results,
    });
    assert.deepEqual(
        groups.libraryAlbums.map((album) => album.id),
        ["a1"],
    );
    assert.deepEqual(
        groups.streamingAlbums.map((album) => album.id),
        ["r1"],
    );
});

test("the Peers tab never shows streaming albums", () => {
    const groups = selectSearchAlbumGroups({
        filterTab: "peers",
        showLibrary: true,
        libraryResults: results,
    });
    assert.deepEqual(
        groups.libraryAlbums.map((album) => album.id),
        ["a1"],
    );
    assert.deepEqual(groups.streamingAlbums, []);
});

test("tabs without library results show no streaming albums", () => {
    const groups = selectSearchAlbumGroups({
        filterTab: "discover",
        showLibrary: false,
        libraryResults: results,
    });
    assert.deepEqual(groups.streamingAlbums, []);
});

test("an album in both groups is shown once, as a library album", () => {
    const groups = selectSearchAlbumGroups({
        filterTab: "library",
        showLibrary: true,
        libraryResults: {
            albums: [libraryAlbum],
            remoteAlbums: [{ ...streamingAlbum, id: "a1" }, streamingAlbum],
        },
    });
    assert.deepEqual(
        groups.streamingAlbums.map((album) => album.id),
        ["r1"],
    );
});

test("missing results give empty groups", () => {
    const groups = selectSearchAlbumGroups({
        filterTab: "all",
        showLibrary: true,
        libraryResults: null,
    });
    assert.deepEqual(groups, { libraryAlbums: [], streamingAlbums: [] });
});
