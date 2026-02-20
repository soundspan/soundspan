import assert from "node:assert/strict";
import test from "node:test";
import {
    applyOptimisticTrackPreferenceMutation,
    buildOptimisticTrackPreferenceResponse,
} from "../../hooks/trackPreferenceOptimistic.ts";

test("buildOptimisticTrackPreferenceResponse maps signal to expected score", () => {
    const thumbsUp = buildOptimisticTrackPreferenceResponse(
        "track-1",
        "thumbs_up"
    );
    assert.equal(thumbsUp.trackId, "track-1");
    assert.equal(thumbsUp.signal, "thumbs_up");
    assert.equal(thumbsUp.state, "liked");
    assert.equal(thumbsUp.score, 1);
    assert.ok(thumbsUp.likedAt);
    assert.equal(thumbsUp.dislikedAt, null);
    assert.ok(thumbsUp.updatedAt);

    const thumbsDown = buildOptimisticTrackPreferenceResponse(
        "track-1",
        "thumbs_down"
    );
    assert.equal(thumbsDown.trackId, "track-1");
    assert.equal(thumbsDown.signal, "thumbs_down");
    assert.equal(thumbsDown.state, "disliked");
    assert.equal(thumbsDown.score, -1);
    assert.equal(thumbsDown.likedAt, null);
    assert.ok(thumbsDown.dislikedAt);
    assert.ok(thumbsDown.updatedAt);

    const clear = buildOptimisticTrackPreferenceResponse("track-1", "clear");
    assert.equal(clear.trackId, "track-1");
    assert.equal(clear.signal, "clear");
    assert.equal(clear.state, "neutral");
    assert.equal(clear.score, 0);
    assert.equal(clear.likedAt, null);
    assert.equal(clear.dislikedAt, null);
    assert.ok(clear.updatedAt);
});

test("applyOptimisticTrackPreferenceMutation updates cache without waiting for cancellation", () => {
    const neverResolves = new Promise<void>(() => undefined);
    let setPayload: unknown = null;

    const queryClient = {
        cancelQueries: () => neverResolves,
        getQueryData: () => ({
            trackId: "track-1",
            signal: "clear" as const,
            state: "neutral" as const,
            score: 0,
            likedAt: null,
            dislikedAt: null,
            updatedAt: null,
        }),
        setQueryData: (_queryKey: unknown, nextData: unknown) => {
            setPayload = nextData;
        },
    };

    const context = applyOptimisticTrackPreferenceMutation(
        queryClient as Parameters<
            typeof applyOptimisticTrackPreferenceMutation
        >[0],
        "track-1",
        "thumbs_down"
    );

    assert.deepEqual(context.canonicalQueryKey, [
        "track-preference",
        "track-1",
    ]);
    assert.deepEqual(context.previousPreference, {
        trackId: "track-1",
        signal: "clear",
        state: "neutral",
        score: 0,
        likedAt: null,
        dislikedAt: null,
        updatedAt: null,
    });
    const optimisticPayload = setPayload as ReturnType<
        typeof buildOptimisticTrackPreferenceResponse
    >;
    assert.equal(optimisticPayload.trackId, "track-1");
    assert.equal(optimisticPayload.signal, "thumbs_down");
    assert.equal(optimisticPayload.state, "disliked");
    assert.equal(optimisticPayload.score, -1);
    assert.equal(optimisticPayload.likedAt, null);
    assert.ok(optimisticPayload.dislikedAt);
    assert.ok(optimisticPayload.updatedAt);
});
