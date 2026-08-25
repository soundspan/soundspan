import assert from "node:assert/strict";
import test from "node:test";
import {
    browseCollectionCopy,
    formatTotalDuration,
    kindTitle,
} from "../../features/explore/browseCollectionCopy";
import { resolveConnectionTestOutcome } from "../../features/settings/hooks/useConnectionTest";

test("kindTitle renders title case for both kinds", () => {
    assert.equal(kindTitle("playlist"), "Playlist");
    assert.equal(kindTitle("mix"), "Mix");
});

test("browseCollectionCopy matches the pre-consolidation playlist wording", () => {
    const copy = browseCollectionCopy("playlist");
    assert.equal(copy.heroLabel, "TIDAL Playlist");
    assert.equal(copy.loadErrorFallback, "Failed to load playlist");
    assert.equal(copy.noPlayableTracks, "No playable tracks in this playlist");
    assert.equal(copy.notFoundTitle, "Playlist not found");
    assert.equal(
        copy.notFoundFallback,
        "This playlist may be private or no longer available.",
    );
    assert.equal(copy.emptyMessage, "This playlist appears to be empty");
});

test("browseCollectionCopy matches the pre-consolidation mix wording", () => {
    const copy = browseCollectionCopy("mix");
    assert.equal(copy.heroLabel, "TIDAL Mix");
    assert.equal(copy.loadErrorFallback, "Failed to load mix");
    assert.equal(copy.noPlayableTracks, "No playable tracks in this mix");
    assert.equal(copy.notFoundTitle, "Mix not found");
    assert.equal(
        copy.notFoundFallback,
        "This mix may be private or no longer available.",
    );
    assert.equal(copy.emptyMessage, "This mix appears to be empty");
});

test("formatTotalDuration matches the original hour and minute forms", () => {
    assert.equal(formatTotalDuration(9000), "about 2 hr 30 min");
    assert.equal(formatTotalDuration(3600), "about 1 hr 0 min");
    assert.equal(formatTotalDuration(2700), "45 min");
    assert.equal(formatTotalDuration(0), "0 min");
});

test("connection test outcome uses static success messages", () => {
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: true },
            { successMessage: "Connected to TIDAL" },
        ),
        { status: "success", message: "Connected to TIDAL" },
    );
});

test("connection test outcome derives version success messages", () => {
    const messages = {
        successMessage: (r: { success: boolean; version?: string }) =>
            r.version ? `v${r.version}` : "Connected",
        failureMessage: "Failed",
    };
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: true, version: "2.1" },
            messages,
        ),
        { status: "success", message: "v2.1" },
    );
    assert.deepEqual(
        resolveConnectionTestOutcome({ success: true }, messages),
        {
            status: "success",
            message: "Connected",
        },
    );
});

test("connection test outcome prefers the probe error then the fallback", () => {
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: false, error: "ECONNREFUSED" },
            { successMessage: "Connected", failureMessage: "Failed" },
        ),
        { status: "error", message: "ECONNREFUSED" },
    );
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: false },
            { successMessage: "Connected", failureMessage: "Failed" },
        ),
        { status: "error", message: "Failed" },
    );
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: false },
            { successMessage: "Connected" },
        ),
        { status: "error", message: "Connection failed" },
    );
});
