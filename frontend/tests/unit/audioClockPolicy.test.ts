import assert from "node:assert/strict";
import { test } from "node:test";
import {
    isEngineTickDiscontinuity,
    shouldPublishClockTime,
} from "../../lib/audio-clock-policy";
import {
    shouldAcceptEngineTimeUpdate,
    type ActivePlaybackSelection,
    type EngineTimeUpdateDecision,
    type SeekState,
} from "../../lib/audio-playback-persistence-guards";

/**
 * Behaviour of the F12 clock-quantization wiring, exercised through the SAME pure
 * functions the AudioPlaybackProvider wires together, in the SAME order:
 *   (i)   shouldAcceptEngineTimeUpdate on the RAW time,
 *   (ii)  a rejected decision writes NEITHER the ref NOR a publish,
 *   (iii) any accepted tick writes the full-precision ref, and publishes to state
 *         only on a display-second boundary (or a forced discontinuity).
 * This models the context so the test proves the observable cadence, not the
 * internals of any single function.
 */

interface SimTick {
    time: number;
    invocationTrackId?: string | null;
}

function simulatePlaybackClock(
    ticks: SimTick[],
    opts: {
        activeSelection: ActivePlaybackSelection;
        seekState: SeekState;
        initialPublished: number | null;
    },
): { refWrites: number[]; published: number[] } {
    const refWrites: number[] = []; // stage (ii): full-precision ref writes
    const published: number[] = []; // stage (iii): React-state publishes
    let lastPublished = opts.initialPublished;
    let lockState: SeekState = { ...opts.seekState };

    for (const tick of ticks) {
        // Stage (i): guard runs on RAW engine time.
        const decision = shouldAcceptEngineTimeUpdate(
            tick.invocationTrackId ?? null,
            opts.activeSelection,
            lockState,
            tick.time,
        );
        if (decision === "reject") {
            continue; // writes neither ref nor state
        }
        if (decision === "unlock-accept") {
            lockState = { isSeekLocked: false, seekTarget: null };
        }
        // Stage (ii): every non-rejected tick writes the ref at full precision.
        refWrites.push(tick.time);
        // Stage (iii): gated publish.
        if (
            shouldPublishClockTime({
                time: tick.time,
                lastPublishedTime: lastPublished,
                forcePublish: isEngineTickDiscontinuity(decision),
            })
        ) {
            lastPublished = tick.time;
            published.push(tick.time);
        }
    }

    return { refWrites, published };
}

const TRACK_SELECTION: ActivePlaybackSelection = {
    playbackType: "track",
    trackId: "track-1",
    audiobookId: null,
    podcastId: null,
    trackEpoch: 1,
};

const NO_SEEK: SeekState = { isSeekLocked: false, seekTarget: null };

function fourHzSweep(from: number, to: number): SimTick[] {
    const ticks: SimTick[] = [];
    // Step 0.25s, re-rounding each step to 2dp to avoid float drift while keeping
    // the fractional offset off the integer second boundaries.
    for (let t = from; t <= to + 1e-9; t = Math.round((t + 0.25) * 100) / 100) {
        ticks.push({ time: t, invocationTrackId: "track-1" });
    }
    return ticks;
}

test("publishes exactly once per display-second across a 4Hz sweep; ref gets every tick", () => {
    const ticks = fourHzSweep(42.01, 45.99);
    // 42.01,42.26,...,45.76 -> 16 accepted ticks spanning seconds 42..45.
    assert.equal(ticks.length, 16);

    const { refWrites, published } = simulatePlaybackClock(ticks, {
        activeSelection: TRACK_SELECTION,
        seekState: NO_SEEK,
        // Display already sits at second 42 (as after a restore/track start).
        initialPublished: 42.0,
    });

    // Stage (ii): the full-precision value of EVERY accepted tick reached the ref.
    assert.deepEqual(
        refWrites,
        ticks.map((t) => t.time),
    );
    assert.equal(refWrites.length, 16);

    // Stage (iii): publishes happen ONLY at the second boundaries 42->43->44->45,
    // i.e. 1Hz, three crossings — and each is the first tick of its new second.
    assert.deepEqual(published, [43.01, 44.01, 45.01]);
    assert.equal(published.length, 3);
    const publishedSeconds = published.map((t) => Math.floor(t));
    assert.deepEqual(publishedSeconds, [43, 44, 45]);
    // Strictly monotonic display seconds, no duplicates (no intra-second publish).
    assert.equal(new Set(publishedSeconds).size, published.length);
});

test("rejected (stale-track) ticks write neither the ref nor a publish", () => {
    const { refWrites, published } = simulatePlaybackClock(
        [
            { time: 43.01, invocationTrackId: "track-1" },
            { time: 99.0, invocationTrackId: "stale-track" }, // guard rejects
            { time: 43.26, invocationTrackId: "track-1" },
        ],
        {
            activeSelection: TRACK_SELECTION,
            seekState: NO_SEEK,
            initialPublished: 42.0,
        },
    );

    assert.ok(!refWrites.includes(99.0), "rejected tick must not reach the ref");
    assert.ok(!published.includes(99.0), "rejected tick must not publish");
    assert.deepEqual(refWrites, [43.01, 43.26]);
    assert.deepEqual(published, [43.01]); // only the boundary crossing 42->43
});

test("a seek landing within the same displayed second still forces a publish", () => {
    const { refWrites, published } = simulatePlaybackClock(
        [
            // Far stale tick during the lock is rejected (|43-30| >= 2).
            { time: 43.0, invocationTrackId: "track-1" },
            // Near-target tick releases the lock (unlock-accept) at 30.1 — same
            // displayed second (30) as the pre-seek publish, but forced.
            { time: 30.1, invocationTrackId: "track-1" },
        ],
        {
            activeSelection: TRACK_SELECTION,
            seekState: { isSeekLocked: true, seekTarget: 30.0 },
            initialPublished: 30.0,
        },
    );

    assert.ok(!refWrites.includes(43.0), "far tick during seek lock is rejected");
    assert.ok(!published.includes(43.0));
    assert.deepEqual(refWrites, [30.1]);
    // Publishes despite Math.floor(30.1) === Math.floor(30.0): the discontinuity
    // forces it so the seek result shows immediately.
    assert.deepEqual(published, [30.1]);
});

test("shouldPublishClockTime: boundary, force, baseline, and staleness semantics", () => {
    // No baseline yet -> always publish.
    assert.equal(
        shouldPublishClockTime({ time: 5.4, lastPublishedTime: null }),
        true,
    );
    // Same displayed second, no force -> suppress.
    assert.equal(
        shouldPublishClockTime({ time: 5.9, lastPublishedTime: 5.1 }),
        false,
    );
    // Crossed into a new second -> publish.
    assert.equal(
        shouldPublishClockTime({ time: 6.02, lastPublishedTime: 5.9 }),
        true,
    );
    // Force overrides the same-second suppression.
    assert.equal(
        shouldPublishClockTime({
            time: 5.9,
            lastPublishedTime: 5.1,
            forcePublish: true,
        }),
        true,
    );
    // Staleness bound < 1s is IGNORED (would otherwise degenerate to per-tick).
    assert.equal(
        shouldPublishClockTime({
            time: 5.9,
            lastPublishedTime: 5.1,
            stalenessBoundSeconds: 0.25,
        }),
        false,
    );
    // A valid (>= 1s) staleness bound publishes once enough time elapses.
    assert.equal(
        shouldPublishClockTime({
            time: 6.9,
            lastPublishedTime: 5.9,
            stalenessBoundSeconds: 1,
        }),
        true,
    );
});

test("isEngineTickDiscontinuity flags only unlock-accept", () => {
    const cases: Array<[EngineTimeUpdateDecision, boolean]> = [
        ["accept", false],
        ["unlock-accept", true],
        ["reject", false],
    ];
    for (const [decision, expected] of cases) {
        assert.equal(isEngineTickDiscontinuity(decision), expected);
    }
});
