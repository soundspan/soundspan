import assert from "node:assert/strict";
import test from "node:test";
import { mapDiscoverTrackToPlaybackTrack } from "../../features/discover/hooks/useDiscoverActions";
import type { DiscoverTrack } from "../../features/discover/types";

function makeBaseTrack(id: string): DiscoverTrack {
    return {
        id,
        title: "Track Title",
        artist: "Track Artist",
        album: "Track Album",
        albumId: "album-1",
        isLiked: false,
        likedAt: null,
        similarity: 0.8,
        tier: "high",
        coverUrl: null,
        available: true,
        duration: 245,
        sourceType: "local",
    };
}

test("maps local discover tracks into playback tracks", () => {
    const mapped = mapDiscoverTrackToPlaybackTrack(makeBaseTrack("local-1"));

    assert.equal(mapped.id, "local-1");
    assert.equal(mapped.duration, 245);
    assert.equal(mapped.streamSource, undefined);
});

test("preserves TIDAL remote metadata", () => {
    const mapped = mapDiscoverTrackToPlaybackTrack({
        ...makeBaseTrack("tidal-1"),
        streamSource: "tidal",
        sourceType: "tidal",
        tidalTrackId: 123456,
    });

    assert.equal(mapped.streamSource, "tidal");
    assert.equal(mapped.tidalTrackId, 123456);
    assert.equal(mapped.youtubeVideoId, undefined);
});

test("preserves YouTube remote metadata", () => {
    const mapped = mapDiscoverTrackToPlaybackTrack({
        ...makeBaseTrack("yt-1"),
        streamSource: "youtube",
        sourceType: "youtube",
        youtubeVideoId: "abc123",
    });

    assert.equal(mapped.streamSource, "youtube");
    assert.equal(mapped.youtubeVideoId, "abc123");
    assert.equal(mapped.tidalTrackId, undefined);
});
