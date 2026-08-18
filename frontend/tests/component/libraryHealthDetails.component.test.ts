import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        AlertTriangle: Icon,
        ChevronDown: Icon,
        ChevronRight: Icon,
        FileWarning: Icon,
        Loader2: Icon,
        RefreshCw: Icon,
        Trash2: Icon,
        X: Icon,
    },
});

const RECORDS = [
    {
        id: "removed-record",
        trackId: "removed-track",
        status: "MISSING_FROM_DISK" as const,
        filePath: "/music/removed.flac",
        detail: null,
        detectedAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        track: {
            id: "removed-track",
            title: "Removed Track",
            removedAt: "2026-08-14T00:00:00.000Z",
        },
    },
    {
        id: "missing-record",
        trackId: "missing-track",
        status: "MISSING_FROM_DISK" as const,
        filePath: "/music/missing.flac",
        detail: null,
        detectedAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        track: {
            id: "missing-track",
            title: "Transiently Missing Track",
            removedAt: null,
        },
    },
];

const DETAILS_PROPS = {
    records: RECORDS,
    total: 2,
    removedPendingPurgeCount: 1,
    trackRemovalRetentionDays: 90,
    isLoading: false,
    isPurging: false,
    error: null,
    purgeNotice: null,
    onRefresh: () => undefined,
    onDismiss: () => undefined,
    onPurgeAll: () => undefined,
};

test("library health summarizes removed tracks and collapses the record list by default", async () => {
    const { LibraryHealthDetails } =
        await import("../../features/settings/components/sections/libraryHealthDetails");

    const html = renderToStaticMarkup(
        React.createElement(LibraryHealthDetails, DETAILS_PROPS),
    );

    assert.match(html, /2 issues detected/);
    assert.match(html, /1 removed, pending purge/);
    assert.match(
        html,
        /A rescan restores these tracks if their files return\./,
    );
    assert.match(html, /TRACK_REMOVAL_RETENTION_DAYS/);
    assert.match(html, /90 days/);

    // Collapsed by default: the toggle advertises the hidden rows and no
    // per-record content is mounted.
    assert.match(html, /Show 2 records/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /\/music\/removed\.flac/);
    assert.doesNotMatch(html, /Removed Track/);
});

test("library health offers a purge-all button only when removed tracks are pending", async () => {
    const { LibraryHealthDetails } =
        await import("../../features/settings/components/sections/libraryHealthDetails");

    const withRemoved = renderToStaticMarkup(
        React.createElement(LibraryHealthDetails, DETAILS_PROPS),
    );
    assert.match(withRemoved, /Delete all now/);

    const withoutRemoved = renderToStaticMarkup(
        React.createElement(LibraryHealthDetails, {
            ...DETAILS_PROPS,
            removedPendingPurgeCount: 0,
        }),
    );
    assert.doesNotMatch(withoutRemoved, /Delete all now/);
});

test("library health surfaces purge notices", async () => {
    const { LibraryHealthDetails } =
        await import("../../features/settings/components/sections/libraryHealthDetails");

    const html = renderToStaticMarkup(
        React.createElement(LibraryHealthDetails, {
            ...DETAILS_PROPS,
            purgeNotice: "Purge started for 1 removed track.",
        }),
    );
    assert.match(html, /Purge started for 1 removed track\./);
});

test("library health expanded list distinguishes removed tracks pending purge", async () => {
    const { LibraryHealthDetails } =
        await import("../../features/settings/components/sections/libraryHealthDetails");

    const html = renderToStaticMarkup(
        React.createElement(LibraryHealthDetails, {
            ...DETAILS_PROPS,
            defaultExpanded: true,
        }),
    );

    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /Hide records/);
    assert.match(html, /Removed, pending purge/);
    assert.match(html, />Missing</);
    assert.match(html, /\/music\/removed\.flac/);
    assert.match(html, /Transiently Missing Track/);
});
