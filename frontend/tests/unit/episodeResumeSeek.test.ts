import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveEpisodeProgressSaveOnSwitch,
    resolveEpisodeStartPosition,
} from "../../lib/audio/episode-resume";

test("starts at the saved progress when the episode is still the active media", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.deepEqual(result, { startAt: 120 });
});

test("starts from the beginning when there is no saved progress", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: null,
        duration: 600,
    });
    assert.deepEqual(result, { startAt: 0 });
});

test("starts finished episodes from the beginning", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 590, isFinished: true },
        duration: 600,
    });
    assert.deepEqual(result, { startAt: 0 });
});

test("does not start when a track became active before the lookup settled", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "track-1",
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.equal(result, null);
});

test("does not start when another episode became active", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "p:e2",
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.equal(result, null);
});

test("does not start when nothing is active anymore", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: null,
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.equal(result, null);
});

test("clamps the start position to the episode duration", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 900, isFinished: false },
        duration: 600,
    });
    assert.deepEqual(result, { startAt: 600 });
});

test("falls back to the progress time as bound when duration is unknown", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 45, isFinished: false },
        duration: 0,
    });
    assert.deepEqual(result, { startAt: 45 });
});

test("negative saved progress starts from the beginning", () => {
    const result = resolveEpisodeStartPosition({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: -5, isFinished: false },
        duration: 0,
    });
    assert.deepEqual(result, { startAt: 0 });
});

test("saves the playing episode's position when switching to a track", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "track-1",
        currentTime: 321,
        engineDuration: 600,
        episodeDuration: 590,
    });
    assert.deepEqual(result, {
        podcastId: "pod-1",
        episodeId: "ep-1",
        currentTime: 321,
        duration: 600,
    });
});

test("saves when switching to another episode", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "pod-1:ep-2",
        currentTime: 100,
        engineDuration: 0,
        episodeDuration: 600,
    });
    assert.deepEqual(result, {
        podcastId: "pod-1",
        episodeId: "ep-1",
        currentTime: 100,
        duration: 600,
    });
});

test("does not save when no podcast is playing", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "track",
        currentPodcastId: null,
        nextMediaId: "track-1",
        currentTime: 100,
        engineDuration: 200,
        episodeDuration: 0,
    });
    assert.equal(result, null);
});

test("does not save when the playback type changed but a stale podcast lingers", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "track",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "track-1",
        currentTime: 100,
        engineDuration: 600,
        episodeDuration: 600,
    });
    assert.equal(result, null);
});

test("does not save when switching to the same episode", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "pod-1:ep-1",
        currentTime: 100,
        engineDuration: 600,
        episodeDuration: 600,
    });
    assert.equal(result, null);
});

test("does not save a position at the very start", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "track-1",
        currentTime: 0,
        engineDuration: 600,
        episodeDuration: 600,
    });
    assert.equal(result, null);
});

test("does not overwrite the natural-end finished save when the episode just ended", () => {
    // The orchestrator's ended handler saves isFinished=true, then advances
    // the queue; the switch-save must not race it with isFinished=false.
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "track-1",
        currentTime: 599.5,
        engineDuration: 600,
        episodeDuration: 600,
    });
    assert.equal(result, null);
});

test("saves a position just outside the end epsilon", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "track-1",
        currentTime: 597,
        engineDuration: 600,
        episodeDuration: 600,
    });
    assert.deepEqual(result, {
        podcastId: "pod-1",
        episodeId: "ep-1",
        currentTime: 597,
        duration: 600,
    });
});

test("falls back to the episode metadata duration when the engine has none", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "pod-1:ep-1",
        nextMediaId: "track-1",
        currentTime: 50,
        engineDuration: 0,
        episodeDuration: 480,
    });
    assert.deepEqual(result, {
        podcastId: "pod-1",
        episodeId: "ep-1",
        currentTime: 50,
        duration: 480,
    });
});

test("does not save when the composite episode id is malformed", () => {
    const result = resolveEpisodeProgressSaveOnSwitch({
        playbackType: "podcast",
        currentPodcastId: "not-composite",
        nextMediaId: "track-1",
        currentTime: 100,
        engineDuration: 600,
        episodeDuration: 600,
    });
    assert.equal(result, null);
});
