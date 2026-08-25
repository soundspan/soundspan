import assert from "node:assert/strict";
import test from "node:test";
import {
    dedupeDiscoverTracks,
    normalizeSongKey,
} from "../../features/search/songDedup";
import type { DiscoverResult, LibraryTrack } from "../../features/search/types";

function libraryTrack(artist: string, title: string): LibraryTrack {
    return {
        id: `lib-${artist}-${title}`,
        title,
        duration: 200,
        album: {
            id: "al1",
            title: "Album",
            coverUrl: null,
            artist: { id: "ar1", name: artist },
        },
    } as unknown as LibraryTrack;
}

function discoverTrack(artist: string, name: string): DiscoverResult {
    return { type: "track", name, artist };
}

test("normalizeSongKey folds case, punctuation, and trailing qualifiers", () => {
    assert.equal(
        normalizeSongKey("AC/DC", "T.N.T. (Live)"),
        normalizeSongKey("ac dc", "TNT"),
    );
    assert.equal(
        normalizeSongKey(
            "Trace Adkins",
            "Every Light In The House (2003 Remaster)",
        ),
        normalizeSongKey("trace adkins", "every light in the house"),
    );
    assert.notEqual(
        normalizeSongKey("Trace Adkins", "Songs About Me"),
        normalizeSongKey("Trace Adkins", "Chrome"),
    );
});

test("dedupeDiscoverTracks drops external rows that duplicate owned songs", () => {
    const deduped = dedupeDiscoverTracks(
        [
            discoverTrack("Trace Adkins", "Chrome"),
            discoverTrack("Trace Adkins", "Songs About Me"),
        ],
        [libraryTrack("Trace Adkins", "Chrome (2011 Remaster)")],
    );
    assert.deepEqual(
        deduped.map((track) => track.name),
        ["Songs About Me"],
    );
});

test("dedupeDiscoverTracks keeps artist-less rows and everything when either side is empty", () => {
    const artistless: DiscoverResult = { type: "track", name: "Mystery" };
    assert.deepEqual(
        dedupeDiscoverTracks([artistless], [libraryTrack("A", "Mystery")]),
        [artistless],
    );
    const all = [discoverTrack("A", "B")];
    assert.deepEqual(dedupeDiscoverTracks(all, []), all);
    assert.deepEqual(dedupeDiscoverTracks([], [libraryTrack("A", "B")]), []);
});
