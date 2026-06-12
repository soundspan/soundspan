import assert from "node:assert/strict";
import test from "node:test";
import { resolveEpisodeResumeSeek } from "../../lib/audio/episode-resume";

test("applies saved progress when the episode is still the active media", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.deepEqual(result, { resumeAt: 120 });
});

test("does not seek when a track became active before the fetch resolved", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "track-1",
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.equal(result, null);
});

test("does not seek when another episode became active", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e2",
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.equal(result, null);
});

test("does not seek when nothing is active anymore", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: null,
        progress: { currentTime: 120, isFinished: false },
        duration: 600,
    });
    assert.equal(result, null);
});

test("ignores missing progress", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: null,
        duration: 600,
    });
    assert.equal(result, null);
});

test("ignores finished episodes", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 590, isFinished: true },
        duration: 600,
    });
    assert.equal(result, null);
});

test("clamps the resume position to the episode duration", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 900, isFinished: false },
        duration: 600,
    });
    assert.deepEqual(result, { resumeAt: 600 });
});

test("does not seek for progress at the very start", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 0, isFinished: false },
        duration: 600,
    });
    assert.equal(result, null);
});

test("falls back to the progress time as bound when duration is unknown", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: 45, isFinished: false },
        duration: 0,
    });
    assert.deepEqual(result, { resumeAt: 45 });
});

test("negative progress yields no seek", () => {
    const result = resolveEpisodeResumeSeek({
        itemId: "p:e1",
        activeMediaId: "p:e1",
        progress: { currentTime: -5, isFinished: false },
        duration: 0,
    });
    assert.equal(result, null);
});
