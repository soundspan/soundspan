import assert from "node:assert/strict";
import test from "node:test";
import { selectSearchSongGroups } from "../../features/search/searchSongGroups";

const libraryTrack = {
    id: "t1",
    title: "Hurt",
    duration: 200,
    album: {
        id: "a1",
        title: "Album",
        artist: { id: "x", name: "Nine Inch Nails" },
    },
};
const streamingTrack = {
    id: "tidal:5",
    title: "Ring of Fire",
    duration: 160,
    source: "tidal" as const,
    album: {
        id: "a2",
        title: "Album",
        artist: { id: "y", name: "Johnny Cash" },
    },
};
const discover = [
    { type: "track", name: "Hurt", artist: "Nine Inch Nails" },
    { type: "track", name: "Ring of Fire", artist: "Johnny Cash" },
    { type: "track", name: "Walk the Line", artist: "Johnny Cash" },
] as never;
const results = {
    tracks: [libraryTrack],
    remoteTracks: [streamingTrack],
} as never;

test("the All tab shows all three groups and drops external duplicates of both", () => {
    const groups = selectSearchSongGroups({
        filterTab: "all",
        showLibrary: true,
        showDiscover: true,
        libraryResults: results,
        discoverTracks: discover,
    });
    assert.deepEqual(
        groups.libraryTracks.map((t) => t.id),
        ["t1"],
    );
    assert.deepEqual(
        groups.streamingTracks.map((t) => t.id),
        ["tidal:5"],
    );
    assert.deepEqual(
        groups.unownedDiscoverTracks.map((t) => t.name),
        ["Walk the Line"],
    );
});

test("the Peers tab never shows liked streaming songs", () => {
    const groups = selectSearchSongGroups({
        filterTab: "peers",
        showLibrary: true,
        showDiscover: false,
        libraryResults: results,
        discoverTracks: discover,
    });
    assert.deepEqual(groups.streamingTracks, []);
    assert.deepEqual(groups.unownedDiscoverTracks, []);
});

test("the Discover tab hides library-side groups but keeps external matches", () => {
    const groups = selectSearchSongGroups({
        filterTab: "discover",
        showLibrary: false,
        showDiscover: true,
        libraryResults: results,
        discoverTracks: discover,
    });
    assert.deepEqual(groups.streamingTracks, []);
    assert.equal(groups.unownedDiscoverTracks.length, 2);
});

test("missing results produce empty groups", () => {
    const groups = selectSearchSongGroups({
        filterTab: "all",
        showLibrary: true,
        showDiscover: true,
        libraryResults: null,
        discoverTracks: [],
    });
    assert.deepEqual(groups, {
        libraryTracks: [],
        streamingTracks: [],
        unownedDiscoverTracks: [],
    });
});
