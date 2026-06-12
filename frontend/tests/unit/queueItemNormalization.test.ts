import assert from "node:assert/strict";
import test from "node:test";
import {
    buildEpisodeQueueItem,
    episodeQueueItemFromPodcast,
    isEpisodeQueueItem,
    normalizeQueueItems,
} from "../../lib/queue-item";

test("normalizeQueueItems returns empty array for non-array input", () => {
    assert.deepEqual(normalizeQueueItems(null), []);
    assert.deepEqual(normalizeQueueItems(undefined), []);
    assert.deepEqual(normalizeQueueItems("queue"), []);
    assert.deepEqual(normalizeQueueItems({ id: "t1" }), []);
});

test("normalizeQueueItems defaults legacy persisted tracks to itemType track", () => {
    const legacyQueue = [
        {
            id: "t1",
            title: "Track One",
            duration: 200,
            artist: { name: "Artist A", id: "a1" },
            album: { title: "Album A", coverArt: "/covers/a.jpg" },
        },
        {
            id: "t2",
            title: "Track Two",
            duration: 100,
            artist: { name: "Artist B" },
            album: { title: "Album B" },
            streamSource: "youtube",
            youtubeVideoId: "yt-1",
        },
    ];

    const normalized = normalizeQueueItems(legacyQueue);

    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].itemType, "track");
    assert.equal(normalized[1].itemType, "track");
    assert.equal(normalized[0].id, "t1");
    // Track fields must be preserved untouched.
    assert.equal(
        (normalized[1] as { youtubeVideoId?: string }).youtubeVideoId,
        "yt-1"
    );
});

test("normalizeQueueItems passes through valid episode items", () => {
    const normalized = normalizeQueueItems([
        {
            itemType: "episode",
            id: "pod-1:ep-1",
            title: "Episode One",
            podcastTitle: "My Podcast",
            podcastId: "pod-1",
            episodeId: "ep-1",
            coverUrl: "/covers/pod.jpg",
            duration: 3600,
        },
    ]);

    assert.equal(normalized.length, 1);
    const item = normalized[0];
    assert.ok(isEpisodeQueueItem(item));
    assert.equal(item.id, "pod-1:ep-1");
    assert.equal(item.podcastId, "pod-1");
    assert.equal(item.episodeId, "ep-1");
    assert.equal(item.podcastTitle, "My Podcast");
    assert.equal(item.coverUrl, "/covers/pod.jpg");
    assert.equal(item.duration, 3600);
});

test("normalizeQueueItems derives podcastId/episodeId from composite id", () => {
    const normalized = normalizeQueueItems([
        {
            itemType: "episode",
            id: "pod-9:ep-7",
            title: "Episode Seven",
            podcastTitle: "Show",
            duration: 100,
        },
    ]);

    assert.equal(normalized.length, 1);
    const item = normalized[0];
    assert.ok(isEpisodeQueueItem(item));
    assert.equal(item.podcastId, "pod-9");
    assert.equal(item.episodeId, "ep-7");
    assert.equal(item.coverUrl, null);
});

test("normalizeQueueItems drops invalid entries", () => {
    const normalized = normalizeQueueItems([
        null,
        "not-an-object",
        { title: "missing id" },
        // Episode without a derivable podcastId/episodeId pair.
        { itemType: "episode", id: "not-composite", title: "Bad" },
        { id: "t1", title: "Valid", duration: 1 },
    ]);

    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].id, "t1");
    assert.equal(normalized[0].itemType, "track");
});

test("normalizeQueueItems preserves mixed ordering", () => {
    const normalized = normalizeQueueItems([
        { id: "t1", title: "Track", duration: 1 },
        {
            itemType: "episode",
            id: "p:e",
            title: "Ep",
            podcastTitle: "Show",
            duration: 2,
        },
        { id: "t2", title: "Track 2", duration: 3 },
    ]);

    assert.deepEqual(
        normalized.map((item) => item.itemType),
        ["track", "episode", "track"]
    );
});

test("buildEpisodeQueueItem composes the composite id", () => {
    const item = buildEpisodeQueueItem({
        podcastId: "pod-1",
        episodeId: "ep-2",
        title: "Episode Two",
        podcastTitle: "Show",
        coverUrl: "/c.jpg",
        duration: 1234,
    });

    assert.equal(item.itemType, "episode");
    assert.equal(item.id, "pod-1:ep-2");
    assert.equal(item.duration, 1234);
});

test("episodeQueueItemFromPodcast splits the player podcast id", () => {
    const item = episodeQueueItemFromPodcast({
        id: "pod-1:ep-5",
        title: "Episode Five",
        podcastTitle: "Show",
        coverUrl: null,
        duration: 90,
    });

    assert.equal(item.itemType, "episode");
    assert.equal(item.podcastId, "pod-1");
    assert.equal(item.episodeId, "ep-5");
    assert.equal(item.coverUrl, null);
});
