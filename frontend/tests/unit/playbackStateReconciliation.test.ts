import assert from "node:assert/strict";
import test from "node:test";
import {
    findRemoteQueueTrackForRestore,
    isNonLibraryTrackId,
    isServerQueueTruncatedPrefix,
    normalizeQueueIndex,
    queuesMatchByTrackId,
    resolveServerPlaybackPollDecision,
} from "../../lib/playback-state-reconciliation";

function queue(ids: string[]) {
    return ids.map((id) => ({ id }));
}

test("queuesMatchByTrackId compares only deterministic track-id order", () => {
    const localQueue = [
        {
            id: "track-1",
            title: "Local title",
        },
        {
            id: "track-2",
            streamSource: "youtube",
        },
    ];
    const serverQueue = [
        {
            id: "track-1",
            title: "Server title",
        },
        {
            id: "track-2",
        },
    ];

    assert.equal(queuesMatchByTrackId(localQueue, serverQueue), true);
});

test("queuesMatchByTrackId ignores null/blank IDs and trims identifier text", () => {
    const localQueue = [
        { id: " track-1 " },
        { id: null },
        { id: "" },
        { id: "   " },
    ];
    const serverQueue = [{ id: "track-1" }];

    assert.equal(queuesMatchByTrackId(localQueue, serverQueue), true);
});

test("queuesMatchByTrackId returns false when normalized queue lengths differ", () => {
    assert.equal(
        queuesMatchByTrackId(queue(["track-1", "track-2"]), queue(["track-1"])),
        false
    );
});

test("queuesMatchByTrackId returns false when normalized order differs", () => {
    assert.equal(
        queuesMatchByTrackId(queue(["track-1", "track-2"]), queue(["track-2", "track-1"])),
        false
    );
});

test("isServerQueueTruncatedPrefix detects stale/truncated server queue snapshots", () => {
    assert.equal(
        isServerQueueTruncatedPrefix(
            queue(["track-1", "track-2", "track-3"]),
            queue(["track-1", "track-2"])
        ),
        true
    );
    assert.equal(
        isServerQueueTruncatedPrefix(
            queue(["track-1", "track-2", "track-3"]),
            queue(["track-1", "track-4"])
        ),
        false
    );
});

test("isServerQueueTruncatedPrefix returns false for empty or non-truncated queues", () => {
    assert.equal(isServerQueueTruncatedPrefix(queue(["track-1"]), []), false);
    assert.equal(isServerQueueTruncatedPrefix([], queue(["track-1"])), false);
    assert.equal(
        isServerQueueTruncatedPrefix(queue(["track-1", "track-2"]), queue(["track-1", "track-2"])),
        false
    );
});

test("normalizeQueueIndex clamps server index safely into queue bounds", () => {
    assert.equal(normalizeQueueIndex(undefined, 3), 0);
    assert.equal(normalizeQueueIndex(-4, 3), 0);
    assert.equal(normalizeQueueIndex(9, 3), 2);
    assert.equal(normalizeQueueIndex(1.8, 3), 1);
    assert.equal(normalizeQueueIndex(5, 0), 0);
    assert.equal(normalizeQueueIndex("2", 4), 2);
    assert.equal(normalizeQueueIndex(Number.NaN, 4), 0);
    assert.equal(normalizeQueueIndex(2, Number.POSITIVE_INFINITY), 0);
});

test("resolveServerPlaybackPollDecision ignores snapshots older than local save", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: "track-2",
        localQueue: queue(["track-1", "track-2", "track-3"]),
        localLastSaveAtMs: 1_000,
        serverPlaybackType: "track",
        serverMediaId: "track-1",
        serverQueue: queue(["track-1", "track-2", "track-3"]),
        serverUpdatedAtMs: 999,
    });

    assert.equal(decision.shouldApplyServerSnapshot, false);
    assert.equal(decision.reason, "server_older_than_local_save");
});

test("resolveServerPlaybackPollDecision keeps local queue authoritative while active", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: "track-3",
        localQueue: queue(["track-1", "track-2", "track-3"]),
        localLastSaveAtMs: 0,
        serverPlaybackType: "track",
        serverMediaId: "track-2",
        serverQueue: queue(["track-1", "track-2", "track-3"]),
        serverUpdatedAtMs: 4_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, false);
    assert.equal(decision.reason, "server_media_behind_local_queue");
});

test("resolveServerPlaybackPollDecision keeps local track queue authoritative for divergent server media", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: "track-2",
        localQueue: queue(["track-1", "track-2", "track-3"]),
        localLastSaveAtMs: 0,
        serverPlaybackType: "track",
        serverMediaId: "track-external",
        serverQueue: queue(["track-external"]),
        serverUpdatedAtMs: 7_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, false);
    assert.equal(decision.reason, "local_track_queue_authoritative");
});

test("resolveServerPlaybackPollDecision flags truncated server snapshots", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: "track-3",
        localQueue: queue(["track-1", "track-2", "track-3", "track-4"]),
        localLastSaveAtMs: 0,
        serverPlaybackType: "track",
        serverMediaId: "track-2",
        serverQueue: queue(["track-1", "track-2"]),
        serverUpdatedAtMs: 4_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, false);
    assert.equal(decision.reason, "server_queue_truncated_prefix");
});

test("resolveServerPlaybackPollDecision treats unchanged media as a no-op", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: "track-2",
        localQueue: queue(["track-1", "track-2", "track-3"]),
        localLastSaveAtMs: 0,
        serverPlaybackType: "track",
        serverMediaId: "track-2",
        serverQueue: queue(["track-1", "track-2", "track-3"]),
        serverUpdatedAtMs: 4_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, false);
    assert.equal(decision.reason, "media_unchanged");
});

test("resolveServerPlaybackPollDecision keeps local queue for non-track server playback", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: "track-2",
        localQueue: queue(["track-1", "track-2", "track-3"]),
        localLastSaveAtMs: 0,
        serverPlaybackType: "podcast",
        serverMediaId: "episode-1",
        serverQueue: queue(["track-1", "track-2", "track-3"]),
        serverUpdatedAtMs: 8_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, false);
    assert.equal(decision.reason, "local_track_queue_authoritative");
});

test("resolveServerPlaybackPollDecision keeps local queue when local media is missing from queue IDs", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: "track-99",
        localQueue: queue(["track-1", "track-2", "track-3"]),
        localLastSaveAtMs: 0,
        serverPlaybackType: "track",
        serverMediaId: "track-1",
        serverQueue: queue(["track-1", "track-2", "track-3"]),
        serverUpdatedAtMs: 8_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, false);
    assert.equal(decision.reason, "local_track_queue_authoritative");
});

test("resolveServerPlaybackPollDecision adopts server state when no active local track queue", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: null,
        localMediaId: null,
        localQueue: [],
        localLastSaveAtMs: 0,
        serverPlaybackType: "track",
        serverMediaId: "track-7",
        serverQueue: queue(["track-7", "track-8"]),
        serverUpdatedAtMs: 4_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, true);
    assert.equal(decision.reason, "adopt_server");
});

test("resolveServerPlaybackPollDecision adopts server state when local playback is track but media id is missing", () => {
    const decision = resolveServerPlaybackPollDecision({
        localPlaybackType: "track",
        localMediaId: null,
        localQueue: queue(["track-1", "track-2"]),
        localLastSaveAtMs: 0,
        serverPlaybackType: "track",
        serverMediaId: "track-2",
        serverQueue: queue(["track-1", "track-2"]),
        serverUpdatedAtMs: 9_000,
    });

    assert.equal(decision.shouldApplyServerSnapshot, true);
    assert.equal(decision.reason, "adopt_server");
});

test("isNonLibraryTrackId flags provider and synthetic ids only", () => {
    assert.equal(isNonLibraryTrackId("yt-dQw4w9WgXcQ"), true);
    assert.equal(isNonLibraryTrackId("yt:dQw4w9WgXcQ"), true);
    assert.equal(isNonLibraryTrackId("tidal:123456"), true);
    assert.equal(isNonLibraryTrackId("clx0abc123def"), false);
    assert.equal(isNonLibraryTrackId(""), false);
    assert.equal(isNonLibraryTrackId(null), false);
    assert.equal(isNonLibraryTrackId(undefined), false);
});

test("findRemoteQueueTrackForRestore materializes a pasted youtube-direct track from the queue", () => {
    const serverQueue = [
        { id: "track-1", title: "Library track" },
        {
            id: "yt-dQw4w9WgXcQ",
            title: "Pasted DJ set",
            streamSource: "youtube-direct",
            youtubeVideoId: "dQw4w9WgXcQ",
        },
    ];

    const restored = findRemoteQueueTrackForRestore(
        "yt-dQw4w9WgXcQ",
        serverQueue
    );

    assert.equal(restored, serverQueue[1]);
});

test("findRemoteQueueTrackForRestore materializes yt:-prefixed YouTube Music queue items", () => {
    const serverQueue = [
        { id: "yt:abcdefghijk", title: "YTM track", streamSource: "youtube" },
    ];

    const restored = findRemoteQueueTrackForRestore(
        "yt:abcdefghijk",
        serverQueue
    );

    assert.equal(restored, serverQueue[0]);
});

test("findRemoteQueueTrackForRestore matches remote queue items by stream source without an id prefix", () => {
    const serverQueue = [
        {
            id: "direct-no-prefix",
            streamSource: "youtube-direct",
            youtubeVideoId: "dQw4w9WgXcQ",
        },
    ];

    const restored = findRemoteQueueTrackForRestore(
        "direct-no-prefix",
        serverQueue
    );

    assert.equal(restored, serverQueue[0]);
});

test("findRemoteQueueTrackForRestore leaves library tracks to the library lookup", () => {
    const serverQueue = [{ id: "clx0abc123def", title: "Library track" }];

    assert.equal(
        findRemoteQueueTrackForRestore("clx0abc123def", serverQueue),
        null
    );
});

test("findRemoteQueueTrackForRestore returns null when the track is not in the queue", () => {
    assert.equal(
        findRemoteQueueTrackForRestore("yt-dQw4w9WgXcQ", [
            { id: "track-1" },
        ]),
        null
    );
    assert.equal(findRemoteQueueTrackForRestore("yt-dQw4w9WgXcQ", null), null);
    assert.equal(findRemoteQueueTrackForRestore(null, [{ id: "x" }]), null);
});
