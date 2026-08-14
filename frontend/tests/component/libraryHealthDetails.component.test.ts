import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        AlertTriangle: Icon,
        FileWarning: Icon,
        Loader2: Icon,
        RefreshCw: Icon,
        Trash2: Icon,
    },
});

test("library health distinguishes and counts removed tracks pending purge", async () => {
    const { LibraryHealthDetails } =
        await import("../../features/settings/components/sections/libraryHealthDetails");

    const html = renderToStaticMarkup(
        React.createElement(LibraryHealthDetails, {
            records: [
                {
                    id: "removed-record",
                    trackId: "removed-track",
                    status: "MISSING_FROM_DISK",
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
                    status: "MISSING_FROM_DISK",
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
            ],
            total: 2,
            removedPendingPurgeCount: 1,
            trackRemovalRetentionDays: 90,
            isLoading: false,
            error: null,
            onRefresh: () => undefined,
            onDismiss: () => undefined,
        }),
    );

    assert.match(html, /2 issues detected/);
    assert.match(html, /1 removed, pending purge/);
    assert.match(html, /Removed, pending purge/);
    assert.match(html, />Missing</);
    assert.match(
        html,
        /A rescan restores these tracks if their files return\./,
    );
    assert.match(html, /TRACK_REMOVAL_RETENTION_DAYS/);
    assert.match(html, /90 days/);
});
