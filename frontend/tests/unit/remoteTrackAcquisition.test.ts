import assert from "node:assert/strict";
import test from "node:test";
import {
    getRemoteTrackAcquisitionLabel,
    resolveRemoteTrackAcquisition,
} from "../../features/library/remoteTrackAcquisition";
import type { Track } from "../../features/library/types";

const admin = {
    downloadsEnabled: true,
    tidalDownloadsEnabled: true,
    requestsEnabled: false,
};
const adminWithoutTidal = { ...admin, tidalDownloadsEnabled: false };
const member = {
    downloadsEnabled: false,
    tidalDownloadsEnabled: false,
    requestsEnabled: true,
};
const nobody = {
    downloadsEnabled: false,
    tidalDownloadsEnabled: false,
    requestsEnabled: false,
};

function remoteTrack(overrides: Partial<Track> = {}): Track {
    return {
        id: "tidal:1",
        title: "Song",
        duration: 120,
        source: "tidal",
        streamSource: "tidal",
        tidalTrackId: 1,
        album: {
            id: "album-1",
            title: "Album",
            rgMbid: "8e8a6f1c-0000-4000-8000-000000000001",
            artist: { id: "artist-1", name: "Artist" },
        },
        ...overrides,
    };
}

test("local and peer rows never get an acquisition action", () => {
    const local = remoteTrack({
        id: "t1",
        source: "local",
        streamSource: undefined,
    });
    const peer = remoteTrack({
        id: "t2",
        source: "federated",
        streamSource: "peer",
    });
    assert.equal(resolveRemoteTrackAcquisition(local, admin), null);
    assert.equal(resolveRemoteTrackAcquisition(peer, admin), null);
});

test("admins download the whole album when it has a real MBID", () => {
    assert.deepEqual(resolveRemoteTrackAcquisition(remoteTrack(), admin), {
        kind: "download-album",
        rgMbid: "8e8a6f1c-0000-4000-8000-000000000001",
        artistName: "Artist",
        albumTitle: "Album",
    });
});

test("members request the album instead of downloading it", () => {
    const action = resolveRemoteTrackAcquisition(remoteTrack(), member);
    assert.equal(action?.kind, "request-album");
});

test("viewers with neither capability get nothing", () => {
    assert.equal(resolveRemoteTrackAcquisition(remoteTrack(), nobody), null);
});

test("synthetic remote album ids cannot be downloaded or requested", () => {
    const track = remoteTrack({
        album: { id: "a", title: "Album", rgMbid: "remote:abc" },
    });
    assert.equal(resolveRemoteTrackAcquisition(track, adminWithoutTidal), null);
    assert.equal(resolveRemoteTrackAcquisition(track, member), null);
});

test("admins can add a single TIDAL song when the album is not acquirable", () => {
    const track = remoteTrack({
        album: { id: "a", title: "Album", rgMbid: "remote:abc" },
    });
    assert.deepEqual(resolveRemoteTrackAcquisition(track, admin), {
        kind: "download-tidal",
        tidalTrackId: 1,
        title: "Song",
    });
});

test("the TIDAL song action reads the provider id when the row has no top-level id", () => {
    const track = remoteTrack({
        tidalTrackId: undefined,
        provider: { tidalTrackId: 42, youtubeVideoId: null },
        album: { id: "a", title: "Album", rgMbid: "remote:abc" },
    });
    assert.deepEqual(resolveRemoteTrackAcquisition(track, admin), {
        kind: "download-tidal",
        tidalTrackId: 42,
        title: "Song",
    });
});

test("the TIDAL song action needs TIDAL downloads and a TIDAL id", () => {
    const placeholder = {
        album: { id: "a", title: "Album", rgMbid: "remote:abc" },
    };
    const withoutId = remoteTrack({ ...placeholder, tidalTrackId: undefined });
    assert.equal(resolveRemoteTrackAcquisition(withoutId, admin), null);
    assert.equal(
        resolveRemoteTrackAcquisition(remoteTrack(placeholder), member),
        null,
    );
});

test("a real album MBID still wins over the single TIDAL song", () => {
    const action = resolveRemoteTrackAcquisition(remoteTrack(), admin);
    assert.equal(action?.kind, "download-album");
});

test("a MusicBrainz match on a streaming-only album unlocks the album actions", () => {
    const track = remoteTrack({
        album: {
            id: "a",
            title: "Album",
            rgMbid: "remote:abc",
            matchedRgMbid: "8e8a6f1c-0000-4000-8000-000000000002",
            artist: { id: "artist-1", name: "Artist" },
        },
    });
    assert.deepEqual(resolveRemoteTrackAcquisition(track, admin), {
        kind: "download-album",
        rgMbid: "8e8a6f1c-0000-4000-8000-000000000002",
        artistName: "Artist",
        albumTitle: "Album",
    });
    assert.equal(
        resolveRemoteTrackAcquisition(track, member)?.kind,
        "request-album",
    );
});

test("a MusicBrainz match also wins over the single TIDAL song", () => {
    const track = remoteTrack({
        album: {
            id: "a",
            title: "Album",
            rgMbid: "remote:abc",
            matchedRgMbid: "8e8a6f1c-0000-4000-8000-000000000002",
        },
    });
    const action = resolveRemoteTrackAcquisition(track, admin);
    assert.equal(action?.kind, "download-album");
});

test("a match the library already holds falls back to the single song", () => {
    const album = {
        id: "a",
        title: "Album",
        rgMbid: "remote:abc",
        matchedRgMbid: "8e8a6f1c-0000-4000-8000-000000000002",
        matchedInLibrary: true,
    };
    assert.deepEqual(
        resolveRemoteTrackAcquisition(remoteTrack({ album }), admin),
        {
            kind: "download-tidal",
            tidalTrackId: 1,
            title: "Song",
        },
    );
    const youtube = remoteTrack({
        id: "yt:vid",
        source: "youtube",
        streamSource: "youtube",
        tidalTrackId: undefined,
        provider: { youtubeVideoId: "vid", tidalTrackId: null },
        album,
    });
    assert.equal(
        resolveRemoteTrackAcquisition(youtube, admin)?.kind,
        "download-youtube",
    );
    assert.equal(
        resolveRemoteTrackAcquisition(remoteTrack({ album }), member),
        null,
    );
});

test("admins can add a single YouTube Music song when the album is not acquirable", () => {
    const track = remoteTrack({
        id: "yt:vid",
        source: "youtube",
        streamSource: "youtube",
        tidalTrackId: undefined,
        provider: { youtubeVideoId: "vid", tidalTrackId: null },
        album: { id: "a", title: "Album", rgMbid: "remote:abc" },
    });
    assert.deepEqual(resolveRemoteTrackAcquisition(track, admin), {
        kind: "download-youtube",
        videoId: "vid",
        title: "Song",
    });
    assert.equal(resolveRemoteTrackAcquisition(track, member), null);
});

test("labels describe each action in plain words", () => {
    assert.equal(
        getRemoteTrackAcquisitionLabel({
            kind: "download-album",
            rgMbid: "x",
            artistName: "a",
            albumTitle: "b",
        }),
        "Add album to library",
    );
    assert.equal(
        getRemoteTrackAcquisitionLabel({
            kind: "request-album",
            rgMbid: "x",
            artistName: "a",
            albumTitle: "b",
        }),
        "Request album",
    );
    assert.equal(
        getRemoteTrackAcquisitionLabel({
            kind: "download-youtube",
            videoId: "v",
            title: "t",
        }),
        "Add song to library",
    );
    assert.equal(
        getRemoteTrackAcquisitionLabel({
            kind: "download-tidal",
            tidalTrackId: 1,
            title: "t",
        }),
        "Add song to library",
    );
});
