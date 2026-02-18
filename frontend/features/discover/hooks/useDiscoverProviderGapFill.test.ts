import {
    applyDiscoverProviderGapFill,
    getProviderSlotCount,
} from "./useDiscoverProviderGapFill";
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

function assertTrue(condition: boolean, label: string) {
    assertEqual(condition, true, label);
}

function makeTrack(id: string, similarity: number): DiscoverTrack {
    return {
        id,
        title: `Title ${id}`,
        artist: `Artist ${id}`,
        album: `Album ${id}`,
        albumId: `album-${id}`,
        isLiked: false,
        likedAt: null,
        similarity,
        tier: "medium",
        coverUrl: null,
        available: true,
        duration: 200,
    };
}

console.log("== useDiscoverProviderGapFill tests ==");

assertEqual(getProviderSlotCount(3), 0, "slot count below threshold");
assertEqual(getProviderSlotCount(4), 1, "slot count minimum threshold");
assertEqual(getProviderSlotCount(10), 3, "slot count uses 30 percent");
assertEqual(getProviderSlotCount(40), 8, "slot count respects hard cap");

const localOnlyTracks = [makeTrack("1", 0.9), makeTrack("2", 0.8)];
const localOnly = applyDiscoverProviderGapFill(localOnlyTracks, [null, null], [
    null,
    null,
]);
assertTrue(
    localOnly.every((track) => track.sourceType === "local"),
    "local-only fallback marks all tracks local"
);

const rankedTracks = [
    makeTrack("0", 1.0),
    makeTrack("1", 0.95),
    makeTrack("2", 0.9),
    makeTrack("3", 0.85),
    makeTrack("4", 0.8),
    makeTrack("5", 0.75),
    makeTrack("6", 0.7),
    makeTrack("7", 0.65),
    makeTrack("8", 0.6),
    makeTrack("9", 0.55),
];

const blended = applyDiscoverProviderGapFill(
    rankedTracks,
    [null, null, { id: 222 }, null, null, null, null, { id: 777 }, null, null],
    [{ videoId: "yt-0" }, { videoId: "yt-1" }, { videoId: "yt-2" }, null, null, null, null, null, null, null]
);

const tidalCount = blended.filter((track) => track.sourceType === "tidal").length;
const ytCount = blended.filter((track) => track.sourceType === "youtube").length;
const localCount = blended.filter((track) => track.sourceType === "local").length;

assertEqual(tidalCount, 1, "tidal assignment count");
assertEqual(ytCount, 2, "youtube assignment count");
assertEqual(localCount, 7, "local assignment count");
assertEqual(
    blended[2].sourceType,
    "tidal",
    "tidal wins when tidal and youtube match same slot"
);
assertEqual(
    blended[7].sourceType,
    "local",
    "lower-ranked provider match excluded when provider slots are full"
);

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
