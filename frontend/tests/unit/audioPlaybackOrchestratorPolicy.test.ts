import assert from "node:assert/strict";
import test from "node:test";
import {
    resolvePlaybackDuration,
    resolveRemoteStreamFormat,
    resolveTrackFormatHint,
    shouldAttemptRecoveryOnUnexpectedPause,
} from "../../components/player/audioPlaybackOrchestratorPolicy";

test("unavailable buffered-ahead does not trigger pause recovery", () => {
    assert.equal(shouldAttemptRecoveryOnUnexpectedPause(null, 1), false);
    assert.equal(shouldAttemptRecoveryOnUnexpectedPause(Number.NaN, 1), false);
});

test("low buffered-ahead still can trigger pause recovery", () => {
    assert.equal(shouldAttemptRecoveryOnUnexpectedPause(0.25, 1), true);
});

test("buffered-ahead above threshold does not trigger pause recovery", () => {
    assert.equal(shouldAttemptRecoveryOnUnexpectedPause(2, 1), false);
});

test("TIDAL streams use mp4 format hint for Howler codec gate", () => {
    assert.equal(resolveRemoteStreamFormat("tidal"), "mp4");
});

test("YouTube streams use mp4 format hint for Howler codec gate", () => {
    assert.equal(resolveRemoteStreamFormat("youtube"), "mp4");
});

test("local streams return undefined (format resolved from file extension)", () => {
    assert.equal(resolveRemoteStreamFormat("local"), undefined);
});

test("unknown/missing streamSource returns undefined", () => {
    assert.equal(resolveRemoteStreamFormat(undefined), undefined);
    assert.equal(
        resolveRemoteStreamFormat(null as unknown as undefined),
        undefined,
    );
});

// ── resolvePlaybackDuration ───────────────────────────────────────

test("prefers audio-reported duration when it exceeds metadata", () => {
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: 240,
            metadataDurationSec: 180,
            isRemoteStream: false,
        }),
        240,
    );
});

test("prefers metadata duration when audio element reports a suspiciously low value for remote streams", () => {
    // fMP4 fragment duration is ~4 s but track is 240 s
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: 4,
            metadataDurationSec: 240,
            isRemoteStream: true,
        }),
        240,
    );
});

test("uses loaded duration for remote streams when it is close to metadata", () => {
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: 238,
            metadataDurationSec: 240,
            isRemoteStream: true,
        }),
        238,
    );
});

test("uses metadata when loaded duration is zero", () => {
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: 0,
            metadataDurationSec: 180,
            isRemoteStream: false,
        }),
        180,
    );
});

test("uses metadata when loaded duration is NaN", () => {
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: Number.NaN,
            metadataDurationSec: 180,
            isRemoteStream: true,
        }),
        180,
    );
});

test("uses metadata when loaded duration is Infinity", () => {
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: Infinity,
            metadataDurationSec: 200,
            isRemoteStream: true,
        }),
        200,
    );
});

test("returns zero when both durations are zero", () => {
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: 0,
            metadataDurationSec: 0,
            isRemoteStream: false,
        }),
        0,
    );
});

test("local stream uses low loaded duration when no metadata available", () => {
    assert.equal(
        resolvePlaybackDuration({
            loadedDurationSec: 4,
            metadataDurationSec: 0,
            isRemoteStream: false,
        }),
        4,
    );
});

test("format hint follows the source: remote hinted, peer detected, local by extension", () => {
    assert.equal(resolveTrackFormatHint({ streamSource: "tidal" }), "mp4");
    assert.equal(resolveTrackFormatHint({ streamSource: "youtube" }), "mp4");
    assert.equal(
        resolveTrackFormatHint({
            streamSource: "youtube-direct",
            youtubeAudioFormat: "webm",
        }),
        "webm",
    );
    // Peer bodies may be the original container or fallback provider
    // bytes, so the engine must detect from Content-Type.
    assert.equal(resolveTrackFormatHint({ streamSource: "peer" }), undefined);
    assert.equal(
        resolveTrackFormatHint({
            streamSource: "peer",
            filePath: "/music/a.flac",
        }),
        undefined,
    );
    assert.equal(resolveTrackFormatHint({ filePath: "/music/a.flac" }), "flac");
    assert.equal(resolveTrackFormatHint({ filePath: "/music/a.m4a" }), "mp4");
    assert.equal(resolveTrackFormatHint({ filePath: "/music/a.opus" }), "webm");
    assert.equal(resolveTrackFormatHint({ filePath: "/music/a.wav" }), "wav");
    assert.equal(resolveTrackFormatHint({}), "mp3");
    assert.equal(resolveTrackFormatHint(null), "mp3");
});
