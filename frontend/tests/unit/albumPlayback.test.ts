import assert from "node:assert/strict";
import test from "node:test";
import { toAlbumPlaybackTrack } from "../../features/album/albumPlayback";

test("toAlbumPlaybackTrack preserves a YouTube album track thumbnail", () => {
    const playbackTrack = toAlbumPlaybackTrack(
        {
            id: "yt:video-1",
            title: "Remote Song",
            duration: 180,
            album: { coverArt: null },
            streamSource: "youtube",
            youtubeVideoId: "video-1",
            thumbnailUrl: "https://img.local/video-1.jpg",
        },
        {
            id: "album-1",
            title: "Remote Album",
            artist: { id: "artist-1", name: "Remote Artist" },
            coverArt: "https://img.local/album-fallback.jpg",
        },
    );

    assert.equal(playbackTrack.album.coverArt, "https://img.local/video-1.jpg");
    assert.equal(playbackTrack.youtubeVideoId, "video-1");
});
