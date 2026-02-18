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

export function getImpactedHistoryCount(
    summary: PlayHistorySummary | null,
    selectedRange: HistoryRange
): number | null {
    if (!summary) {
        return null;
    }

    if (selectedRange === "7d") {
        return summary.last7Days;
    }

    if (selectedRange === "30d") {
        return summary.last30Days;
    }

    if (selectedRange === "365d") {
        return summary.last365Days;
    }

    return summary.allTime;
}
