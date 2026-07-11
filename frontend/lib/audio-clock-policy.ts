/**
 * Pure clock-publish policy extracted from AudioPlaybackProvider for testability.
 *
 * The audio engine emits `timeupdate` events 4x/second (every 250ms — see
 * `lib/howler-engine.ts`). Publishing every tick into React state produces a new
 * playback-context object 4x/sec, re-rendering every subscriber for the whole
 * duration of a track. Since the player UI only ever displays whole seconds, we
 * publish to React state only when the *displayed second* changes (or on a forced
 * discontinuity such as a seek landing). The full-precision value is kept in a ref
 * by the caller (for seek-target matching and server-progress persistence); this
 * module only governs the far coarser STATE publish cadence.
 *
 * This mirrors the house pattern of `lib/audio-playback-persistence-guards.ts`:
 * a pure decision function, unit-testable without React.
 */

import type { EngineTimeUpdateDecision } from "./audio-playback-persistence-guards";

export interface ClockPublishDecisionInput {
    /** Full-precision engine time of the current accepted tick, in seconds. */
    time: number;
    /**
     * Last value published to React state, or null if nothing has been published
     * yet. Compared at `Math.floor` (display-second) granularity.
     */
    lastPublishedTime: number | null;
    /**
     * Force a publish regardless of the second boundary. Used for discontinuities
     * (seek landing / seek-unlock, track change, resume-from-restore, duration
     * edge) where the displayed value must update immediately rather than wait for
     * the next whole-second crossing.
     */
    forcePublish?: boolean;
    /**
     * Optional staleness safety bound, in seconds. If set (and >= 1) and at least
     * this many seconds of engine time have elapsed since the last publish without
     * a display-second crossing, publish anyway. Not required during normal
     * monotonic playback at 4Hz (every whole second WILL cross a boundary) — it is
     * only a defensive valve. Values < 1s are intentionally ignored so this can
     * never degenerate into publishing every 250ms tick (which would make the
     * whole optimization a no-op).
     */
    stalenessBoundSeconds?: number;
}

/**
 * Decide whether an already-ACCEPTED engine tick should be published to React
 * state. Publishes at display-second (`Math.floor`) boundaries, on forced
 * discontinuities, and — only if a valid (>= 1s) bound is supplied — past a
 * staleness bound. Never inspects the seek-lock guard: rejection is handled by
 * the caller BEFORE this runs (rejected ticks must write neither ref nor state).
 */
export function shouldPublishClockTime(input: ClockPublishDecisionInput): boolean {
    const {
        time,
        lastPublishedTime,
        forcePublish = false,
        stalenessBoundSeconds,
    } = input;

    if (forcePublish) {
        return true;
    }

    // Nothing published yet — establish the baseline.
    if (lastPublishedTime === null) {
        return true;
    }

    // The displayed whole second changed.
    if (Math.floor(time) !== Math.floor(lastPublishedTime)) {
        return true;
    }

    // Defensive staleness valve (opt-in; only honoured at >= 1s so it can never
    // collapse into a per-tick publish).
    if (
        typeof stalenessBoundSeconds === "number" &&
        stalenessBoundSeconds >= 1 &&
        Math.abs(time - lastPublishedTime) >= stalenessBoundSeconds
    ) {
        return true;
    }

    return false;
}

/**
 * Classify whether an engine-tick guard decision represents a discontinuity that
 * must force an immediate state publish. `"unlock-accept"` means the seek lock
 * just released at the landing position — the displayed time jumps and must be
 * reflected at once, not deferred to the next whole-second boundary. A plain
 * `"accept"` is ordinary forward playback and follows the second-boundary cadence.
 *
 * (`"reject"` never reaches this classifier: the caller returns before the publish
 * stage on a rejected decision.)
 */
export function isEngineTickDiscontinuity(
    decision: EngineTimeUpdateDecision,
): boolean {
    return decision === "unlock-accept";
}
