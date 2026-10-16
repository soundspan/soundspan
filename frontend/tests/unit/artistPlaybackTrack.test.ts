import assert from "node:assert/strict";
import test from "node:test";
import { toArtistPlaybackTrack } from "../../lib/artistPlayback";

const context = {
    artistId: "artist-1",
    artistName: "Artist",
    albumId: "album-1",
    albumTitle: "Album",
    coverArt: "cover",
    year: 2020,
};

test("local album tracks map without stream fields", () => {
    const track = toArtistPlaybackTrack(
        { id: "t1", title: "Song", duration: 90, trackNo: 3 },
        context,
    );
    assert.deepEqual(track, {
        id: "t1",
        title: "Song",
        duration: 90,
        trackNumber: 3,
        artist: { id: "artist-1", name: "Artist" },
        album: { id: "album-1", title: "Album", coverArt: "cover", year: 2020 },
    });
});

test("display titles win over raw titles", () => {
    const track = toArtistPlaybackTrack(
        { id: "t1", title: "Raw", displayTitle: "Shown" },
        context,
    );
    assert.equal(track?.title, "Shown");
});

test("TIDAL tracks keep their stream source and id", () => {
    const track = toArtistPlaybackTrack(
        {
            id: "tidal:5",
            title: "Song",
            streamSource: "tidal",
            tidalTrackId: 5,
        },
        context,
    );
    assert.equal(track?.streamSource, "tidal");
    assert.equal(track?.tidalTrackId, 5);
    assert.equal(track?.youtubeVideoId, undefined);
});

test("YouTube tracks fall back to source and the provider block", () => {
    const track = toArtistPlaybackTrack(
        {
            id: "yt:v",
            title: "Song",
            source: "youtube",
            provider: { tidalTrackId: null, youtubeVideoId: "v" },
        },
        context,
    );
    assert.equal(track?.streamSource, "youtube");
    assert.equal(track?.youtubeVideoId, "v");
    assert.equal(track?.tidalTrackId, undefined);
});

test("rows without an id are skipped", () => {
    assert.equal(toArtistPlaybackTrack({ title: "No id" }, context), null);
});
