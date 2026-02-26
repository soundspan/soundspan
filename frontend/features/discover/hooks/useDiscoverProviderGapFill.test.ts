import { applyDiscoverProviderGapFill } from "./useDiscoverProviderGapFill";
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

function makeTrack(id: string, similarity: number, available = true): DiscoverTrack {
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
        available,
        duration: 200,
    };
}

console.log("== useDiscoverProviderGapFill tests ==");

// All tracks available locally, no gaps — no matching needed
const localOnlyTracks = [makeTrack("1", 0.9), makeTrack("2", 0.8)];
const localOnly = applyDiscoverProviderGapFill(localOnlyTracks, [], [], []);
assertTrue(
    localOnly.every((track) => track.sourceType === "local"),
    "local-only fallback marks all tracks local"
);

// Unavailable tracks with no matches also stay local
const unavailNoMatch = [makeTrack("1", 0.9, false), makeTrack("2", 0.8, false)];
const noMatch = applyDiscoverProviderGapFill(unavailNoMatch, [0, 1], [null, null], [null, null]);
assertTrue(
    noMatch.every((track) => track.sourceType === "local"),
    "unavailable tracks with no matches stay local"
);

// Mix of available (local) and unavailable (gap-fill) tracks
const rankedTracks = [
    makeTrack("0", 1.0, false),   // gap — yt only
    makeTrack("1", 0.95, false),  // gap — tidal + yt → tidal wins
    makeTrack("2", 0.9, false),   // gap — tidal + yt → tidal wins
    makeTrack("3", 0.85, true),   // local
    makeTrack("4", 0.8, false),   // gap — yt only
    makeTrack("5", 0.75, true),   // local
    makeTrack("6", 0.7, true),    // local
    makeTrack("7", 0.65, false),  // gap — tidal + yt → tidal wins
    makeTrack("8", 0.6, false),   // gap — yt only
    makeTrack("9", 0.55, false),  // gap — no match
];
// Gap indices: 0,1,2,4,7,8,9 (7 gaps)
const gapIndices = [0, 1, 2, 4, 7, 8, 9];

const blended = applyDiscoverProviderGapFill(
    rankedTracks,
    gapIndices,
    // Tidal matches aligned to gap indices only (7 entries)
    [null, { id: 111 }, { id: 222 }, null, { id: 777 }, null, null],
    // YT matches aligned to gap indices only (7 entries)
    [{ videoId: "yt-0" }, { videoId: "yt-1" }, { videoId: "yt-2" }, { videoId: "yt-4" }, { videoId: "yt-7" }, { videoId: "yt-8" }, null],
);

const tidalCount = blended.filter((track) => track.sourceType === "tidal").length;
const ytCount = blended.filter((track) => track.sourceType === "youtube").length;
const localCount = blended.filter((track) => track.sourceType === "local").length;

assertEqual(tidalCount, 3, "tidal assignment count");
assertEqual(ytCount, 3, "youtube assignment count");
assertEqual(localCount, 4, "local assignment count");
assertEqual(
    blended[1].sourceType,
    "tidal",
    "tidal wins when both providers match"
);
assertEqual(
    blended[0].sourceType,
    "youtube",
    "youtube fallback used when tidal match missing"
);
assertEqual(
    blended[3].sourceType,
    "local",
    "available tracks stay local even when surrounded by gaps"
);
assertEqual(
    blended[8].sourceType,
    "youtube",
    "lower-ranked matches are still assigned without provider cap"
);
assertEqual(
    blended[9].streamSource,
    undefined,
    "unmatched tracks keep no stream source"
);

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
