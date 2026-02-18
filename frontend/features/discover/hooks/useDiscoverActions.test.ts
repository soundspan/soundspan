import { mapDiscoverTrackToPlaybackTrack } from "./useDiscoverActions";
import type { DiscoverTrack } from "../types";

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
    if (actual === expected) {
        passed += 1;
        console.log(`PASS ${label}`);
        return;
    }
    failed += 1;
    console.error(`FAIL ${label}`);
    console.error(`  expected=${expected}`);
    console.error(`  actual=${actual}`);
}

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

console.log("== useDiscoverActions mapping tests ==");

const localMapped = mapDiscoverTrackToPlaybackTrack(makeBaseTrack("local-1"));
assertEqual(localMapped.id, "local-1", "maps local id");
assertEqual(localMapped.duration, 245, "maps duration");
assertEqual(
    localMapped.streamSource,
    undefined,
    "local mapping has no stream source"
);

const tidalMapped = mapDiscoverTrackToPlaybackTrack({
    ...makeBaseTrack("tidal-1"),
    streamSource: "tidal",
    sourceType: "tidal",
    tidalTrackId: 123456,
});
assertEqual(tidalMapped.streamSource, "tidal", "maps tidal stream source");
assertEqual(tidalMapped.tidalTrackId, 123456, "maps tidal track id");
assertEqual(
    tidalMapped.youtubeVideoId,
    undefined,
    "tidal mapping has no youtube id"
);

const youtubeMapped = mapDiscoverTrackToPlaybackTrack({
    ...makeBaseTrack("yt-1"),
    streamSource: "youtube",
    sourceType: "youtube",
    youtubeVideoId: "abc123",
});
assertEqual(youtubeMapped.streamSource, "youtube", "maps youtube stream source");
assertEqual(youtubeMapped.youtubeVideoId, "abc123", "maps youtube video id");
assertEqual(
    youtubeMapped.tidalTrackId,
    undefined,
    "youtube mapping has no tidal id"
);

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
