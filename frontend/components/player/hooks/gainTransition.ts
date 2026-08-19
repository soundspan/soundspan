"use client";

import {
    computeGainRampSteps,
    GAIN_RAMP_STEP_MS,
} from "@/lib/audio-engine/loudnessGainPolicy";

export interface GainTransitionHandle {
    cancel: () => void;
}

/**
 * Steps the loudness gain from its current value to `to` through the
 * policy's bounded ramp, applying the composited output state on every
 * step. Returns a handle that cancels the remaining steps.
 */
export function startGainTransition(options: {
    from: number;
    to: number;
    setGain: (value: number) => void;
    applyOutputState: () => void;
}): GainTransitionHandle {
    const steps = computeGainRampSteps(options.from, options.to);
    let stepIndex = 0;
    const timer = setInterval(() => {
        options.setGain(steps[stepIndex] ?? options.to);
        options.applyOutputState();
        stepIndex += 1;
        if (stepIndex >= steps.length) clearInterval(timer);
    }, GAIN_RAMP_STEP_MS);
    return {
        cancel: () => {
            clearInterval(timer);
        },
    };
}
