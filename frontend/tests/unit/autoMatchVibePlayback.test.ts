import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoMatchVibeAtQueueEnd } from "../../components/player/autoMatchVibePlayback.ts";

test("triggers auto Match Vibe when queue is at the final track", () => {
    assert.equal(
        shouldAutoMatchVibeAtQueueEnd({
            playbackType: "track",
            queueLength: 12,
            currentIndex: 11,
            repeatMode: "off",
            isListenTogether: false,
        }),
        true
    );
});

test("does not trigger when playback is not a track queue", () => {
    assert.equal(
        shouldAutoMatchVibeAtQueueEnd({
            playbackType: "podcast",
            queueLength: 12,
            currentIndex: 11,
            repeatMode: "off",
            isListenTogether: false,
        }),
        false
    );
});

test("does not trigger before reaching the final queue track", () => {
    assert.equal(
        shouldAutoMatchVibeAtQueueEnd({
            playbackType: "track",
            queueLength: 12,
            currentIndex: 5,
            repeatMode: "off",
            isListenTogether: false,
        }),
        false
    );
});

test("does not trigger during Listen Together sessions", () => {
    assert.equal(
        shouldAutoMatchVibeAtQueueEnd({
            playbackType: "track",
            queueLength: 12,
            currentIndex: 11,
            repeatMode: "off",
            isListenTogether: true,
        }),
        false
    );
});

test("does not trigger when repeat mode is enabled", () => {
    assert.equal(
        shouldAutoMatchVibeAtQueueEnd({
            playbackType: "track",
            queueLength: 12,
            currentIndex: 11,
            repeatMode: "all",
            isListenTogether: false,
        }),
        false
    );
    assert.equal(
        shouldAutoMatchVibeAtQueueEnd({
            playbackType: "track",
            queueLength: 12,
            currentIndex: 11,
            repeatMode: "one",
            isListenTogether: false,
        }),
        false
    );
});
