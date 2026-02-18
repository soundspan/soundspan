import assert from "node:assert/strict";
import test from "node:test";
import {
    getImpactedHistoryCount,
    HISTORY_RANGE_OPTIONS,
    MY_HISTORY_ROUTE,
    type PlayHistorySummary,
} from "../../features/settings/components/sections/playbackHistoryConfig.ts";

const summary: PlayHistorySummary = {
    allTime: 1000,
    last7Days: 40,
    last30Days: 140,
    last365Days: 730,
};

test("history constants expose route and clear-range options", () => {
    assert.equal(MY_HISTORY_ROUTE, "/my-history");
    assert.deepEqual(
        HISTORY_RANGE_OPTIONS.map((option) => option.value),
        ["7d", "30d", "365d", "all"]
    );
});

test("getImpactedHistoryCount returns null when summary is unavailable", () => {
    assert.equal(getImpactedHistoryCount(null, "30d"), null);
});

test("getImpactedHistoryCount returns expected counts for each range", () => {
    assert.equal(getImpactedHistoryCount(summary, "7d"), 40);
    assert.equal(getImpactedHistoryCount(summary, "30d"), 140);
    assert.equal(getImpactedHistoryCount(summary, "365d"), 730);
    assert.equal(getImpactedHistoryCount(summary, "all"), 1000);
});
