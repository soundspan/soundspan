/**
 * mapHints — PURE selection of the one-line contextual hint the map whispers
 * at bottom-center. The map's grammar is modifier-key verbs (shift-drag,
 * ctrl-click) that are otherwise invisible; the hint chip teaches exactly the
 * verbs that matter in the current mode, and nothing else.
 *
 * No React, no DOM — unit-testable in isolation.
 */

import type { MapMode } from "./types";

export const HINTS_DISMISSED_KEY = "vibe:hints-dismissed";

export interface HintContext {
    /** Journey's "pick on map" sub-state. */
    picking?: boolean;
    /** The sweep brush toggle is armed. */
    sweepArmed?: boolean;
}

export function hintForMode(mode: MapMode, ctx: HintContext = {}): string {
    if (ctx.sweepArmed) {
        return "Brush armed — drag across dots to sweep them into a queue";
    }
    switch (mode) {
        case "travel":
            return "Click a glowing halo to hop there · Shift-click queues it · Esc exits";
        case "journey":
            return ctx.picking
                ? "Click any dot to set the journey's destination"
                : "Pick a destination track or mood, then start the journey";
        case "alchemy":
            return "Click dots to add ingredients · blend 2–10 tracks";
        case "explore":
        default:
            return "Click a dot to play & travel · Shift-click queues · Ctrl-click blends";
    }
}
