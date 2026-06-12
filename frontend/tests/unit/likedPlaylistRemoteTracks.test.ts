import assert from "node:assert/strict";
import test from "node:test";
import {
    toAudioTrack,
    type LikedPlaylistTrack,
} from "../../app/playlist/my-liked/likedPlaylistUtils";

// ── Fixtures ──────────────────────────────────────────────────

const LOCAL_TRACK: LikedPlaylistTrack = {
    id: "local-track-1",
    title: "Local Song",
    duration: 210,
    trackNo: 3,
    filePath: "/music/song.flac",
    likedAt: "2026-02-28T12:00:00.000Z",
    artist: { id: "artist-1", name: "Local Artist" },
    album: { id: "album-1", title: "Local Album", coverArt: "/covers/art.jpg" },
};

const YOUTUBE_TRACK: LikedPlaylistTrack = {
    id: "yt:dQw4w9WgXcQ",
    title: "YouTube Song",
    duration: 180,
    trackNo: 0,
    filePath: null,
    likedAt: "2026-02-28T13:00:00.000Z",
    streamSource: "youtube",
    youtubeVideoId: "dQw4w9WgXcQ",
    artist: { id: "yt:artist:abc", name: "YT Artist" },
    album: { id: "yt:album:xyz", title: "Single", coverArt: "https://lh3.googleusercontent.com/thumb" },
};

const TIDAL_TRACK: LikedPlaylistTrack = {
    id: "tidal:123456789",
    title: "Tidal Song",
    duration: 240,
    trackNo: 0,
    filePath: null,
    likedAt: "2026-02-28T14:00:00.000Z",
    streamSource: "tidal",
    tidalTrackId: "123456789",
    artist: { id: "tidal:artist:abc", name: "Tidal Artist" },
    album: { id: "tidal:album:xyz", title: "Tidal Album", coverArt: "https://resources.tidal.com/thumb" },
};

// ── toAudioTrack — local tracks ───────────────────────────────

test("toAudioTrack preserves core fields for local tracks", () => {
    const result = toAudioTrack(LOCAL_TRACK);
    assert.equal(result.id, "local-track-1");
    assert.equal(result.title, "Local Song");
    assert.equal(result.duration, 210);
    assert.equal(result.artist.name, "Local Artist");
    assert.equal(result.artist.id, "artist-1");
    assert.equal(result.album.title, "Local Album");
    assert.equal(result.album.id, "album-1");
    assert.equal(result.album.coverArt, "/covers/art.jpg");
    assert.equal(result.filePath, "/music/song.flac");
});

test("toAudioTrack does not set streaming fields for local tracks", () => {
    const result = toAudioTrack(LOCAL_TRACK);
    assert.equal(result.streamSource, undefined);
    assert.equal(result.youtubeVideoId, undefined);
    assert.equal(result.tidalTrackId, undefined);
});

// ── toAudioTrack — YouTube tracks ─────────────────────────────

test("toAudioTrack preserves streamSource for YouTube tracks", () => {
    const result = toAudioTrack(YOUTUBE_TRACK);
    assert.equal(result.streamSource, "youtube");
});

test("toAudioTrack preserves youtubeVideoId for YouTube tracks", () => {
    const result = toAudioTrack(YOUTUBE_TRACK);
    assert.equal(result.youtubeVideoId, "dQw4w9WgXcQ");
});

test("toAudioTrack sets filePath undefined for YouTube tracks", () => {
    const result = toAudioTrack(YOUTUBE_TRACK);
    assert.equal(result.filePath, undefined);
});

test("toAudioTrack preserves core fields for YouTube tracks", () => {
    const result = toAudioTrack(YOUTUBE_TRACK);
    assert.equal(result.id, "yt:dQw4w9WgXcQ");
    assert.equal(result.title, "YouTube Song");
    assert.equal(result.duration, 180);
    assert.equal(result.artist.name, "YT Artist");
    assert.equal(result.album.title, "Single");
});

// ── toAudioTrack — Tidal tracks ───────────────────────────────

test("toAudioTrack preserves streamSource for Tidal tracks", () => {
    const result = toAudioTrack(TIDAL_TRACK);
    assert.equal(result.streamSource, "tidal");
});

test("toAudioTrack preserves tidalTrackId for Tidal tracks (coerced to number)", () => {
    const result = toAudioTrack(TIDAL_TRACK);
    // Backend returns tidalTrackId as string, AudioTrack expects number
    assert.equal(result.tidalTrackId, 123456789);
});

test("toAudioTrack sets filePath undefined for Tidal tracks", () => {
    const result = toAudioTrack(TIDAL_TRACK);
    assert.equal(result.filePath, undefined);
});

test("toAudioTrack preserves core fields for Tidal tracks", () => {
    const result = toAudioTrack(TIDAL_TRACK);
    assert.equal(result.id, "tidal:123456789");
    assert.equal(result.title, "Tidal Song");
    assert.equal(result.duration, 240);
    assert.equal(result.artist.name, "Tidal Artist");
    assert.equal(result.album.title, "Tidal Album");
});

// ── isRemoteLikedTrack helper ─────────────────────────────────

test("local track is not identified as remote", () => {
    assert.equal(LOCAL_TRACK.streamSource, undefined);
});

test("YouTube track is identified by streamSource", () => {
    assert.equal(YOUTUBE_TRACK.streamSource, "youtube");
});

test("Tidal track is identified by streamSource", () => {
    assert.equal(TIDAL_TRACK.streamSource, "tidal");
});
