import assert from "node:assert/strict";
import test from "node:test";
import { applyDiscoverProviderGapFill } from "../../features/discover/hooks/useDiscoverProviderGapFill";
import type { DiscoverTrack } from "../../features/discover/types";

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

test("marks fully local playlists as local without provider metadata", () => {
    const tracks = [makeTrack("1", 0.9), makeTrack("2", 0.8)];
    const result = applyDiscoverProviderGapFill(tracks, [], [], []);

    assert.ok(result.every((track) => track.sourceType === "local"));
    assert.ok(result.every((track) => track.streamSource === undefined));
});

test("keeps unmatched unavailable tracks local", () => {
    const tracks = [makeTrack("1", 0.9, false), makeTrack("2", 0.8, false)];
    const result = applyDiscoverProviderGapFill(
        tracks,
        [0, 1],
        [null, null],
        [null, null]
    );

    assert.ok(result.every((track) => track.sourceType === "local"));
    assert.ok(result.every((track) => track.streamSource === undefined));
});

test("prefers TIDAL matches and falls back to YouTube when needed", () => {
    const tracks = [
        makeTrack("0", 1.0, false),
        makeTrack("1", 0.95, false),
        makeTrack("2", 0.9, false),
        makeTrack("3", 0.85, true),
        makeTrack("4", 0.8, false),
        makeTrack("5", 0.75, true),
        makeTrack("6", 0.7, true),
        makeTrack("7", 0.65, false),
        makeTrack("8", 0.6, false),
        makeTrack("9", 0.55, false),
    ];

    const result = applyDiscoverProviderGapFill(
        tracks,
        [0, 1, 2, 4, 7, 8, 9],
        [null, { id: 111 }, { id: 222 }, null, { id: 777 }, null, null],
        [
            { videoId: "yt-0" },
            { videoId: "yt-1" },
            { videoId: "yt-2" },
            { videoId: "yt-4" },
            { videoId: "yt-7" },
            { videoId: "yt-8" },
            null,
        ]
    );

    assert.equal(
        result.filter((track) => track.sourceType === "tidal").length,
        3
    );
    assert.equal(
        result.filter((track) => track.sourceType === "youtube").length,
        3
    );
    assert.equal(
        result.filter((track) => track.sourceType === "local").length,
        4
    );
    assert.equal(result[1].sourceType, "tidal");
    assert.equal(result[0].sourceType, "youtube");
    assert.equal(result[3].sourceType, "local");
    assert.equal(result[8].sourceType, "youtube");
    assert.equal(result[9].streamSource, undefined);
});
