import assert from "node:assert/strict";
import test from "node:test";
import {
    describeMapStatus,
    formatSongCount,
} from "../../components/vibe/mapStatus";

const HOUR_MS = 60 * 60 * 1000;

function builtHoursAgo(hours: number): string {
    return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

test("song counts pluralize and use locale grouping", () => {
    assert.equal(formatSongCount(1), "1 song");
    assert.equal(formatSongCount(0), "0 songs");
    assert.equal(formatSongCount(5617), `${(5617).toLocaleString()} songs`);
});

test("an idle map describes its age and size", () => {
    const view = describeMapStatus({
        computedAt: builtHoursAgo(3),
        trackCount: 5617,
        sampled: false,
        rebuildState: "idle",
        compact: false,
    });
    assert.equal(view.summary, `Built 3h ago · ${formatSongCount(5617)}`);
    assert.equal(view.busy, false);
    assert.equal(view.sampled, false);
    assert.match(view.detail, /once a day/);
    assert.doesNotMatch(view.detail, /random sample/);
});

test("a freshly built map reads as just now", () => {
    const view = describeMapStatus({
        computedAt: new Date().toISOString(),
        trackCount: 92,
        sampled: false,
        rebuildState: "idle",
        compact: false,
    });
    assert.equal(view.summary, `Built just now · ${formatSongCount(92)}`);
});

test("compact mode drops the song count from the summary", () => {
    const view = describeMapStatus({
        computedAt: builtHoursAgo(3),
        trackCount: 5617,
        sampled: false,
        rebuildState: "idle",
        compact: true,
    });
    assert.equal(view.summary, "Built 3h ago");
});

test("a sampled map explains the sample in its detail", () => {
    const view = describeMapStatus({
        computedAt: builtHoursAgo(1),
        trackCount: 7500,
        sampled: true,
        rebuildState: "idle",
        compact: false,
    });
    assert.equal(view.sampled, true);
    assert.match(view.detail, /random sample/);
});

test("rebuild states replace the summary and mark the chip busy while work runs", () => {
    const base = {
        computedAt: builtHoursAgo(2),
        trackCount: 10,
        sampled: false,
        compact: false,
    } as const;
    const requesting = describeMapStatus({
        ...base,
        rebuildState: "requesting",
    });
    assert.equal(requesting.summary, "Requesting a rebuild…");
    assert.equal(requesting.busy, true);

    const building = describeMapStatus({ ...base, rebuildState: "building" });
    assert.equal(building.summary, "Rebuilding the map…");
    assert.equal(building.busy, true);

    const stalled = describeMapStatus({ ...base, rebuildState: "stalled" });
    assert.match(stalled.summary, /Still rebuilding/);
    assert.equal(stalled.busy, false);

    const failed = describeMapStatus({ ...base, rebuildState: "failed" });
    assert.match(failed.summary, /Rebuild failed/);
    assert.equal(failed.busy, false);

    const error = describeMapStatus({ ...base, rebuildState: "error" });
    assert.match(error.summary, /Couldn't start a rebuild/);
    assert.equal(error.busy, false);
});
