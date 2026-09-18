/**
 * Pure copy for the map status chip: how fresh the map is, how many songs it
 * holds, whether it is a sample, and what an in-flight rebuild is doing.
 */

import { formatRelativeTime } from "@/utils/formatTime";

/** Lifecycle of an admin-requested rebuild as seen by the chip. */
export type MapRebuildState =
    | "idle"
    | "requesting"
    | "building"
    | "stalled"
    | "failed"
    | "error";

export interface MapStatusInput {
    computedAt: string;
    trackCount: number;
    sampled: boolean;
    rebuildState: MapRebuildState;
    /** Small screens drop the song count so the chip stays one line. */
    compact: boolean;
}

/** Rendered text for the chip. */
export interface MapStatusView {
    /** Short chip text, e.g. "Built 3h ago · 5,617 songs". */
    summary: string;
    /** Tooltip explaining the daily rebuild and, when relevant, the sample. */
    detail: string;
    sampled: boolean;
    /** True while a rebuild is requested or running. */
    busy: boolean;
}

const CACHE_NOTE =
    "The map is rebuilt automatically about once a day. Songs analyzed since the last build appear after the next rebuild.";
const SAMPLE_NOTE =
    "Your library has more songs than the map can place at once, so it shows a random sample.";

/** Pluralized, locale-grouped song count. */
export function formatSongCount(count: number): string {
    return `${count.toLocaleString()} ${count === 1 ? "song" : "songs"}`;
}

function rebuildSummary(state: MapRebuildState): string | null {
    switch (state) {
        case "requesting":
            return "Requesting a rebuild…";
        case "building":
            return "Rebuilding the map…";
        case "stalled":
            return "Still rebuilding — check back in a few minutes";
        case "failed":
            return "Rebuild failed — it will retry automatically";
        case "error":
            return "Couldn't start a rebuild";
        default:
            return null;
    }
}

function builtSummary(input: MapStatusInput): string {
    const age = formatRelativeTime(input.computedAt, {
        justNowLabel: "just now",
    });
    if (input.compact) return `Built ${age}`;
    return `Built ${age} · ${formatSongCount(input.trackCount)}`;
}

/** Derive the chip's summary, tooltip, and busy flag from map state. */
export function describeMapStatus(input: MapStatusInput): MapStatusView {
    const busy =
        input.rebuildState === "requesting" ||
        input.rebuildState === "building";
    const summary = rebuildSummary(input.rebuildState) ?? builtSummary(input);
    const detail = input.sampled ? `${CACHE_NOTE} ${SAMPLE_NOTE}` : CACHE_NOTE;
    return { summary, detail, sampled: input.sampled, busy };
}
