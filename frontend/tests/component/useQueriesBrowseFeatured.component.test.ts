import assert from "node:assert/strict";
import test from "node:test";
import { mapYtMusicChartsToFeaturedPlaylists } from "../../hooks/useQueries.ts";

test("mapYtMusicChartsToFeaturedPlaylists maps chart tracks to home cards", () => {
    const cards = mapYtMusicChartsToFeaturedPlaylists(
        {
            songs: [
                {
                    videoId: "song-1",
                    title: "Song One",
                    artist: "Artist One",
                    thumbnailUrl: "https://img.example/song-1.jpg",
                    album: "Album One",
                },
            ],
            trending: [
                {
                    videoId: "song-2",
                    title: "Song Two",
                    artists: [{ name: "Artist Two" }],
                    thumbnails: [{ url: "https://img.example/song-2.jpg" }],
                },
            ],
        },
        10
    );

    assert.equal(cards.length, 2);
    assert.deepEqual(cards[0], {
        id: "song-1",
        source: "ytmusic",
        type: "track",
        title: "Song One",
        description: "Artist One - Album One",
        creator: "Artist One",
        imageUrl: "https://img.example/song-1.jpg",
        trackCount: 1,
        url: "https://music.youtube.com/watch?v=song-1",
    });
    assert.equal(cards[1]?.id, "song-2");
    assert.equal(cards[1]?.creator, "Artist Two");
    assert.equal(cards[1]?.description, "Artist Two");
    assert.equal(cards[1]?.imageUrl, "https://img.example/song-2.jpg");
});

test("mapYtMusicChartsToFeaturedPlaylists deduplicates by videoId and enforces limit", () => {
    const cards = mapYtMusicChartsToFeaturedPlaylists(
        {
            songs: [
                { videoId: "dup-1", title: "Song A", artist: "A" },
                { videoId: "dup-2", title: "Song B", artist: "B" },
            ],
            trending: [
                { videoId: "dup-1", title: "Song A (duplicate)", artist: "A2" },
                { videoId: "dup-3", title: "Song C", artist: "C" },
            ],
            videos: [
                { videoId: "dup-4", title: "Song D", artist: "D" },
            ],
        },
        3
    );

    assert.deepEqual(
        cards.map((card) => card.id),
        ["dup-1", "dup-2", "dup-3"]
    );
});

test("mapYtMusicChartsToFeaturedPlaylists ignores invalid entries", () => {
    const cards = mapYtMusicChartsToFeaturedPlaylists(
        {
            songs: [
                { title: "Missing videoId", artist: "A" },
                { videoId: "missing-title", artist: "B" },
                { videoId: "valid", title: "Valid Song", artist: "Artist" },
            ],
        },
        10
    );

    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.id, "valid");
    assert.deepEqual(mapYtMusicChartsToFeaturedPlaylists(undefined, 10), []);
    assert.deepEqual(mapYtMusicChartsToFeaturedPlaylists({}, 0), []);
});
