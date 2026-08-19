import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        ChevronDown: Icon,
        ChevronRight: Icon,
        Loader2: Icon,
        RefreshCw: Icon,
    },
});

mock.module("@/lib/enrichmentApi", {
    namedExports: {
        enrichmentApi: {
            retryVibeEmbeddings: async () => ({ enqueued: 0 }),
        },
    },
});

const SUMMARY = {
    metadataGaps: {
        missingArt: { albums: 12, artists: 3 },
        missingMbid: { albums: 7, artists: 2 },
        missingGenres: 44,
        missingLyrics: 310,
    },
    analysisCoverage: {
        total: 200,
        analysisStatus: {
            pending: 10,
            processing: 0,
            failed: 4,
            completed: 186,
        },
        vibeAnalysisStatus: {
            pending: 20,
            processing: 0,
            failed: 0,
            completed: 180,
        },
        loudness: { measured: 150, missing: 50 },
    },
    storage: {
        tracks: 200,
        totalFileSize: 5 * 1024 ** 3,
        mimeTypes: 3,
        artists: 25,
        isTruncated: false,
    },
    quality: { floorKbps: 192, albumsBelowFloor: 6, isTruncated: false },
    duplicates: {
        clusters: 9,
        byTier: { audioHash: 5, recordingMbid: 3, isrc: 1 },
        isTruncated: true,
    },
};

async function renderPanels() {
    const [gaps, analysis, duplicates, storage, quality] = await Promise.all([
        import("../../features/library-health/components/MetadataGapsPanel"),
        import("../../features/library-health/components/AnalysisCoveragePanel"),
        import("../../features/library-health/components/DuplicatesPanel"),
        import("../../features/library-health/components/StoragePanel"),
        import("../../features/library-health/components/QualityPanel"),
    ]);
    return renderToStaticMarkup(
        React.createElement(
            "div",
            null,
            React.createElement(gaps.MetadataGapsPanel, {
                gaps: SUMMARY.metadataGaps,
            }),
            React.createElement(analysis.AnalysisCoveragePanel, {
                coverage: SUMMARY.analysisCoverage,
            }),
            React.createElement(duplicates.DuplicatesPanel, {
                duplicates: SUMMARY.duplicates,
            }),
            React.createElement(storage.StoragePanel, {
                storage: SUMMARY.storage,
            }),
            React.createElement(quality.QualityPanel, {
                quality: SUMMARY.quality,
            }),
        ),
    );
}

test("library insights panels summarize every panel family while collapsed", async () => {
    const html = await renderPanels();

    assert.match(html, /Metadata gaps/);
    assert.match(html, /12 albums without art/);
    assert.match(html, /7 albums without MBIDs/);
    assert.match(html, /44 tracks without genres/);
    assert.match(html, /310 tracks without lyrics/);

    assert.match(html, /Analysis coverage/);
    assert.match(html, /Audio 93%/);
    assert.match(html, /Vibe 90%/);
    assert.match(html, /Loudness 75%/);
    assert.match(html, /4 failed/);

    assert.match(html, /Duplicates and versions/);
    assert.match(html, /9 clusters/);
    assert.match(html, /5 exact/);
    assert.match(html, /large library: counts are sampled/);

    assert.match(html, /Storage/);
    assert.match(html, /200 tracks/);
    assert.match(html, /5\.0 GB/);

    assert.match(html, /Quality outliers/);
    assert.match(html, /6 lossy albums below 192 kbps/);
});

test("library insights panels start collapsed with no drill-down content mounted", async () => {
    const html = await renderPanels();

    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /Retry failed audio analysis/);
    assert.doesNotMatch(html, /Bitrate floor/);
    assert.doesNotMatch(html, /report-only/);
});
