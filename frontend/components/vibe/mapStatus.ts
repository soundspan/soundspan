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

/** Progress of a newer embedding space that has not cut over yet. */
export interface MapMigrationInput {
    embedded: number;
    pending: number;
    failed: number;
    /** Fraction of the library that must be done before cutover (0.5..1). */
    cutoverThreshold: number;
}

export interface MapStatusInput {
    computedAt: string;
    trackCount: number;
    /** Songs the map was drawn from, when the server reported it. */
    embeddedCount?: number | null;
    sampled: boolean;
    rebuildState: MapRebuildState;
    /** Small screens drop the song count so the chip stays one line. */
    compact: boolean;
    /** Present while a newer analysis is still filling its space. */
    migration?: MapMigrationInput | null;
}

/** Badge and tooltip for an in-progress re-analysis. */
export interface MapMigrationNotice {
    badge: string;
    detail: string;
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
    /** Set while the map is still reading the previous analysis. */
    migration: MapMigrationNotice | null;
}

const CACHE_NOTE =
    "The map is rebuilt automatically about once a day, or sooner when many songs have been analyzed since the last build. Songs analyzed since then appear after the next rebuild.";
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

/** "5,617 songs", or "sample of 7,500 from 21,000 songs" when the server sampled. */
function coverageSummary(input: MapStatusInput): string {
    const source = input.embeddedCount;
    const sampledFromKnownTotal =
        input.sampled &&
        typeof source === "number" &&
        Number.isInteger(source) &&
        source > input.trackCount;
    if (!sampledFromKnownTotal) return formatSongCount(input.trackCount);
    return `sample of ${input.trackCount.toLocaleString()} from ${formatSongCount(source)}`;
}

function builtSummary(input: MapStatusInput): string {
    const age = formatRelativeTime(input.computedAt, {
        justNowLabel: "just now",
    });
    if (input.compact) return `Built ${age}`;
    return `Built ${age} · ${coverageSummary(input)}`;
}

function isCount(value: number): boolean {
    return Number.isInteger(value) && value >= 0;
}

/**
 * Explain a re-analysis that the map cannot show yet. Returns null when
 * there is no migration, its numbers are unusable, or nothing is counted.
 */
export function describeMigrationNotice(
    migration: MapMigrationInput | null | undefined,
): MapMigrationNotice | null {
    if (!migration) return null;
    const { embedded, pending, failed, cutoverThreshold } = migration;
    if (![embedded, pending, failed].every(isCount)) return null;
    if (!(cutoverThreshold > 0 && cutoverThreshold <= 1)) return null;
    const total = embedded + pending + failed;
    if (total === 0) return null;
    const percent = Math.floor((embedded / total) * 100);
    const cutoverPercent = Math.round(cutoverThreshold * 100);
    return {
        badge: `Re-analyzing · ${percent}%`,
        detail:
            `A newer analysis is in progress: ${formatSongCount(embedded)} of ${formatSongCount(total)} done. ` +
            `The map switches to the new results automatically at ${cutoverPercent}%; until then, songs analyzed only in the new format are not on it.`,
    };
}

/** Derive the chip's summary, tooltip, and busy flag from map state. */
export function describeMapStatus(input: MapStatusInput): MapStatusView {
    const busy =
        input.rebuildState === "requesting" ||
        input.rebuildState === "building";
    const summary = rebuildSummary(input.rebuildState) ?? builtSummary(input);
    const migration = describeMigrationNotice(input.migration);
    const detail = [
        CACHE_NOTE,
        input.sampled ? SAMPLE_NOTE : null,
        migration?.detail ?? null,
    ]
        .filter((note): note is string => note !== null)
        .join(" ");
    return { summary, detail, sampled: input.sampled, busy, migration };
}
