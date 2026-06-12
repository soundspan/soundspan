export type HistoryRange = "7d" | "30d" | "365d" | "all";

export interface PlayHistorySummary {
    allTime: number;
    last7Days: number;
    last30Days: number;
    last365Days: number;
}

export const MY_HISTORY_ROUTE = "/my-history";

export const HISTORY_RANGE_OPTIONS: Array<{ value: HistoryRange; label: string }> = [
    { value: "7d", label: "Past week" },
    { value: "30d", label: "Past month" },
    { value: "365d", label: "Past year" },
    { value: "all", label: "All time" },
];
const HISTORY_RANGE_SUMMARY_KEYS: Record<HistoryRange, keyof PlayHistorySummary> = {
    "7d": "last7Days",
    "30d": "last30Days",
    "365d": "last365Days",
    all: "allTime",
};

/**
 * Executes getImpactedHistoryCount.
 */
export function getImpactedHistoryCount(
    summary: PlayHistorySummary | null,
    selectedRange: HistoryRange
): number | null {
    if (!summary) {
        return null;
    }

    return summary[HISTORY_RANGE_SUMMARY_KEYS[selectedRange]];
}
