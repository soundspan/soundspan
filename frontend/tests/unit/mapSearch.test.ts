import assert from "node:assert/strict";
import test from "node:test";
import { searchMapTracks } from "../../components/vibe/mapSearch";
import type { MapTrack } from "../../components/vibe/types";

function track(overrides: Partial<MapTrack> & { id: string }): MapTrack {
    const { id, ...rest } = overrides;
    return {
        id,
        x: 0.5,
        y: 0.5,
        title: overrides.title ?? "Untitled",
        artist: overrides.artist ?? "Unknown Artist",
        artistId: `artist-${overrides.id}`,
        albumId: `album-${overrides.id}`,
        coverUrl: null,
        dominantMood: "moodHappy",
        moodScore: 0.5,
        energy: 0.5,
        valence: 0.5,
        ...rest,
    };
}

const library: MapTrack[] = [
    track({ id: "1", title: "Midnight City", artist: "M83" }),
    track({ id: "2", title: "City Lights", artist: "Aurora" }),
    track({ id: "3", title: "Starlight", artist: "Muse" }),
    track({ id: "4", title: "Fireflies", artist: "Owl City" }),
    track({ id: "5", title: "Aurora Borealis", artist: "Some Band" }),
    track({ id: "6", title: "Zebra", artist: "City Sleepers" }),
];

test("query shorter than 2 characters (after trim) returns no matches", () => {
    assert.deepEqual(searchMapTracks(library, ""), []);
    assert.deepEqual(searchMapTracks(library, "a"), []);
    assert.deepEqual(searchMapTracks(library, "  a  "), []);
});

test("matches case-insensitively on title or artist substrings", () => {
    const results = searchMapTracks(library, "MIDNIGHT");
    assert.deepEqual(
        results.map((t) => t.id),
        ["1"],
    );

    const byArtist = searchMapTracks(library, "muse");
    assert.deepEqual(
        byArtist.map((t) => t.id),
        ["3"],
    );
});

test("trims and collapses internal whitespace before matching", () => {
    const results = searchMapTracks(library, "  city   lights  ");
    assert.deepEqual(
        results.map((t) => t.id),
        ["2"],
    );
});

test("ranks title-prefix above artist-prefix above title-substring above artist-substring", () => {
    // "city" hits all four tiers across the fixture library:
    //  "2" City Lights          -> title starts with "city"      (title-prefix)
    //  "6" Zebra / City Sleepers -> artist starts with "city"     (artist-prefix)
    //  "1" Midnight City         -> title contains, doesn't start (title-substring)
    //  "4" Fireflies / Owl City  -> artist contains, doesn't start (artist-substring)
    const results = searchMapTracks(library, "city");
    assert.deepEqual(
        results.map((t) => t.id),
        ["2", "6", "1", "4"],
    );
});

test("alphabetical tie-break within the same rank tier", () => {
    const tied: MapTrack[] = [
        track({ id: "b", title: "Blue Horizon", artist: "X" }),
        track({ id: "a", title: "Amber Horizon", artist: "Y" }),
        track({ id: "c", title: "Cyan Horizon", artist: "Z" }),
    ];
    const results = searchMapTracks(tied, "horizon");
    assert.deepEqual(
        results.map((t) => t.id),
        ["a", "b", "c"],
    );
});

test("respects the limit parameter (default 8)", () => {
    const many: MapTrack[] = Array.from({ length: 20 }, (_, i) =>
        track({ id: `t${i}`, title: `Vibe Track ${i}`, artist: "A" }),
    );
    assert.equal(searchMapTracks(many, "vibe").length, 8);
    assert.equal(searchMapTracks(many, "vibe", 3).length, 3);
    assert.equal(searchMapTracks(many, "vibe", 20).length, 20);
});

test("returns [] when nothing matches", () => {
    assert.deepEqual(searchMapTracks(library, "nonexistentquery"), []);
});

test("a track matching in multiple ways is not duplicated in the results", () => {
    const t = track({ id: "dup", title: "Aurora Aurora", artist: "Aurora" });
    const results = searchMapTracks([t], "aurora");
    assert.equal(results.length, 1);
});
