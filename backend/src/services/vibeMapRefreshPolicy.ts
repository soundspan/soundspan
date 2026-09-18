/** Why a cached projection is or is not due for a background refresh. */
export type VibeMapRefreshDecision = "fresh" | "count_unknown" | "count_drift";

/** Counts used to evaluate whether a cached vibe map has drifted. */
export interface VibeMapRefreshInput {
    cachedEmbeddedCount: number | undefined;
    currentEmbeddedCount: number;
}

/** Minimum absolute embedded-track drift required for a refresh. */
export const VIBE_MAP_REFRESH_MIN_DRIFT = 50;

/** Minimum relative embedded-track drift required for a refresh. */
export const VIBE_MAP_REFRESH_MIN_DRIFT_RATIO = 0.1;

function isValidCount(value: number): boolean {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** Decide whether bounded embedded-track drift requires a background refresh. */
export function decideVibeMapRefresh(
    input: VibeMapRefreshInput,
): VibeMapRefreshDecision {
    const { cachedEmbeddedCount, currentEmbeddedCount } = input;
    if (!isValidCount(currentEmbeddedCount)) return "fresh";
    if (cachedEmbeddedCount === undefined) return "count_unknown";
    if (!isValidCount(cachedEmbeddedCount)) return "fresh";

    const drift = Math.abs(currentEmbeddedCount - cachedEmbeddedCount);
    const relativeMinimum =
        VIBE_MAP_REFRESH_MIN_DRIFT_RATIO * Math.max(cachedEmbeddedCount, 1);
    return drift >= VIBE_MAP_REFRESH_MIN_DRIFT && drift >= relativeMinimum
        ? "count_drift"
        : "fresh";
}
