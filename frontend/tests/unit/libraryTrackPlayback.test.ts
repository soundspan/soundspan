import assert from "node:assert/strict";
import test from "node:test";
import {
    getRemoteLibrarySource,
    isLibraryTrackRow,
    toLibraryAudioTrack,
} from "../../features/library/libraryTrackPlayback";
import type { Track } from "../../features/library/types";

const localTrack: Track = {
    id: "track-1",
    title: "Local Song",
    duration: 200,
    loudnessLufs: -9,
    truePeakDb: -1,
    source: "local",
    album: {
        id: "album-1",
        title: "Local Album",
        coverArt: "cover-1",
        albumLoudnessLufs: -8,
        albumTruePeakDb: -0.5,
        artist: { id: "artist-1", name: "Local Artist" },
    },
};

test("local rows keep library identity and loudness without stream fields", () => {
    const audio = toLibraryAudioTrack(localTrack);
    assert.equal(audio.id, "track-1");
    assert.deepEqual(audio.artist, { id: "artist-1", name: "Local Artist" });
    assert.equal(audio.album.albumLoudnessLufs, -8);
    assert.equal(audio.loudnessLufs, -9);
    assert.equal(audio.source, "local");
    assert.equal(audio.streamSource, undefined);
    assert.equal(audio.tidalTrackId, undefined);
    assert.equal(audio.youtubeVideoId, undefined);
});

test("peer rows keep their peer for federated streaming", () => {
    const peer = { id: "peer-1", name: "Friend", online: true };
    const audio = toLibraryAudioTrack({
        ...localTrack,
        source: "federated",
        streamSource: "peer",
        peer,
    });
    assert.equal(audio.source, "federated");
    assert.deepEqual(audio.peer, peer);
    assert.equal(audio.streamSource, undefined);
});

test("TIDAL rows carry the stream source and TIDAL id", () => {
    const audio = toLibraryAudioTrack({
        ...localTrack,
        id: "tidal:9001",
        source: "tidal",
        streamSource: "tidal",
        tidalTrackId: 9001,
    });
    assert.equal(audio.streamSource, "tidal");
    assert.equal(audio.tidalTrackId, 9001);
    assert.equal(audio.youtubeVideoId, undefined);
});

test("YouTube rows fall back to the provider identity block", () => {
    const audio = toLibraryAudioTrack({
        ...localTrack,
        id: "yt:abc",
        source: "youtube",
        provider: { tidalTrackId: null, youtubeVideoId: "abc" },
    });
    assert.equal(audio.streamSource, "youtube");
    assert.equal(audio.youtubeVideoId, "abc");
    assert.equal(audio.tidalTrackId, undefined);
});

test("rows without album links get readable placeholders", () => {
    const audio = toLibraryAudioTrack({
        id: "yt:def",
        title: "Loose Song",
        duration: 100,
        source: "youtube",
        youtubeVideoId: "def",
    });
    assert.equal(audio.album.id, undefined);
    assert.equal(audio.album.title, "Unknown Album");
    assert.deepEqual(audio.artist, { id: undefined, name: "Unknown Artist" });
});

test("remote source detection prefers streamSource, then source", () => {
    assert.equal(getRemoteLibrarySource({ streamSource: "tidal" }), "tidal");
    assert.equal(getRemoteLibrarySource({ source: "youtube" }), "youtube");
    assert.equal(
        getRemoteLibrarySource({ source: "federated", streamSource: "peer" }),
        null,
    );
    assert.equal(getRemoteLibrarySource({ source: "local" }), null);
});

test("library rows are local or peer rows, never liked streaming rows", () => {
    assert.equal(isLibraryTrackRow({ source: "local" }), true);
    assert.equal(
        isLibraryTrackRow({ source: "federated", streamSource: "peer" }),
        true,
    );
    assert.equal(isLibraryTrackRow({ source: "tidal" }), false);
    assert.equal(isLibraryTrackRow({ streamSource: "youtube" }), false);
});
