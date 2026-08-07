import assert from "node:assert/strict";
import test from "node:test";
import {
    annotateOnMap,
    journeyTracks,
    mapTrackToTrack,
    waypointToTrack,
} from "../../components/vibe/journeyTracks";
import type { VibeTrackRef } from "../../components/vibe/travelCompass";
import type { MapTrack } from "../../components/vibe/types";

function waypoint(id: string, coverUrl: string | null = null): VibeTrackRef {
    return {
        id,
        title: `Title ${id}`,
        album: { id: `al-${id}`, title: `Album ${id}`, coverUrl },
        artist: { id: `ar-${id}`, name: `Artist ${id}` },
    };
}

const fromTrack = {
    id: "from",
    title: "From Song",
    artist: { name: "From Artist", id: "ar-from" },
    album: { title: "From Album", id: "al-from" },
    duration: 200,
};

test("waypointToTrack builds a well-formed Track (cover null -> undefined)", () => {
    const t = waypointToTrack(waypoint("w1"));
    assert.deepEqual(t, {
        id: "w1",
        title: "Title w1",
        artist: { name: "Artist w1", id: "ar-w1" },
        album: { title: "Album w1", id: "al-w1", coverArt: undefined },
        duration: 0,
    });
});

test("waypointToTrack maps a present coverUrl to coverArt", () => {
    const t = waypointToTrack(waypoint("w2", "http://cover/w2.jpg"));
    assert.equal(t.album.coverArt, "http://cover/w2.jpg");
});

test("mapTrackToTrack turns a projected dot (string artist) into a Track", () => {
    const mt: MapTrack = {
        id: "m1",
        x: 0.1,
        y: 0.2,
        title: "Map Song",
        artist: "Map Artist",
        artistId: "ar-m1",
        albumId: "al-m1",
        coverUrl: "http://cover/m1.jpg",
        dominantMood: "moodHappy",
        moodScore: 0.5,
        energy: 0.5,
        valence: 0.5,
    };
    assert.deepEqual(mapTrackToTrack(mt), {
        id: "m1",
        title: "Map Song",
        artist: { name: "Map Artist", id: "ar-m1" },
        album: { title: "", id: "al-m1", coverArt: "http://cover/m1.jpg" },
        duration: 0,
    });
});

test("journeyTracks prepends the from-track when it isn't the first waypoint", () => {
    const wps = [waypoint("a"), waypoint("b"), waypoint("c")];
    const queue = journeyTracks(fromTrack, wps);
    assert.equal(queue.length, 4);
    assert.equal(queue[0], fromTrack, "origin is first and passed through as-is");
    assert.deepEqual(
        queue.map((t) => t.id),
        ["from", "a", "b", "c"]
    );
});

test("journeyTracks does not duplicate the from-track if it is already first", () => {
    const wps = [waypoint("from"), waypoint("b")];
    const queue = journeyTracks(fromTrack, wps);
    assert.deepEqual(
        queue.map((t) => t.id),
        ["from", "b"]
    );
});

test("journeyTracks with no from-track returns just the mapped waypoints", () => {
    const wps = [waypoint("a"), waypoint("b")];
    const queue = journeyTracks(null, wps);
    assert.deepEqual(
        queue.map((t) => t.id),
        ["a", "b"]
    );
    // Mapped items are real Track objects.
    assert.equal(queue[0].duration, 0);
    assert.deepEqual(queue[0].artist, { name: "Artist a", id: "ar-a" });
});

test("annotateOnMap flags presence and preserves 1-based sequence", () => {
    const mapIndex = new Map<string, unknown>([
        ["a", {}],
        ["c", {}],
    ]);
    const items = [waypoint("a"), waypoint("b"), waypoint("c")];
    const out = annotateOnMap(items, mapIndex);
    assert.deepEqual(
        out.map((o) => ({ id: o.id, onMap: o.onMap, seq: o.seq })),
        [
            { id: "a", onMap: true, seq: 1 },
            { id: "b", onMap: false, seq: 2 },
            { id: "c", onMap: true, seq: 3 },
        ]
    );
});
