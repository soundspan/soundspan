import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

// Fixtures mirror the EXACT payloads the backend read model returns:
// album gap items nest the artist object; track gap items and analysis
// failures are flat (artistName/albumTitle). See
// backend/src/services/libraryHealthDashboard/{metadataGaps,analysisCoverage}.ts.
const ALBUM_GAP_PAGE = {
    kind: "missing-art",
    counts: { artists: 1, albums: 1 },
    items: [
        {
            id: "album-1",
            title: "Bare Album",
            rgMbid: "temp-1",
            coverUrl: null,
            userCoverUrl: null,
            artist: { id: "artist-1", name: "Cover Artist" },
        },
    ],
    total: 1,
    limit: 50,
    offset: 0,
};
const TRACK_GAP_PAGE = {
    kind: "missing-genres",
    counts: { tracks: 1 },
    items: [
        {
            id: "track-1",
            title: "Genreless Track",
            filePath: "/music/track.flac",
            albumTitle: "Some Album",
            artistName: "Some Artist",
        },
    ],
    total: 1,
    limit: 50,
    offset: 0,
};
const ANALYSIS_PAGE = {
    total: 10,
    analysisStatus: { pending: 0, processing: 0, failed: 1, completed: 9 },
    vibeAnalysisStatus: { pending: 0, processing: 0, failed: 0, completed: 10 },
    loudness: { measured: 10, missing: 0 },
    failed: {
        items: [
            {
                id: "track-9",
                title: "Broken Track",
                analysisError: "decode failed",
                artistName: "Failing Artist",
                albumTitle: "Failing Album",
            },
        ],
        total: 1,
        limit: 50,
        offset: 0,
    },
};

let failGapLoads = 0;
const getLibraryHealthGaps = mock.fn(async (kind: string) => {
    if (failGapLoads > 0) {
        failGapLoads -= 1;
        throw new Error("network down");
    }
    return kind === "missing-art"
        ? ALBUM_GAP_PAGE
        : { ...TRACK_GAP_PAGE, kind };
});
const getLibraryHealthAnalysis = mock.fn(async () => ANALYSIS_PAGE);
const retryFailedAnalysis = mock.fn(async () => ({ enqueued: 1 }));

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getLibraryHealthGaps,
            getLibraryHealthAnalysis,
            retryFailedAnalysis,
        },
    },
});

mock.module("@/lib/enrichmentApi", {
    namedExports: {
        enrichmentApi: { retryVibeEmbeddings: async () => ({ enqueued: 0 }) },
    },
});

const SUMMARY_GAPS = {
    missingArt: { albums: 1, artists: 1 },
    missingMbid: { albums: 0, artists: 0 },
    missingGenres: 1,
    missingLyrics: 0,
};
const SUMMARY_COVERAGE = {
    total: 10,
    analysisStatus: { pending: 0, processing: 0, failed: 1, completed: 9 },
    vibeAnalysisStatus: { pending: 0, processing: 0, failed: 0, completed: 10 },
    loudness: { measured: 10, missing: 0 },
};

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    failGapLoads = 0;
    getLibraryHealthGaps.mock.resetCalls();
    getLibraryHealthAnalysis.mock.resetCalls();
    document.body.replaceChildren();
});

async function mountPanel(
    load: () => Promise<{ element: React.ReactElement }>,
) {
    const { element } = await load();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(element);
        await Promise.resolve();
    });
    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function click(target: Element | undefined | null) {
    assert.ok(target instanceof HTMLElement, "expected clickable element");
    await React.act(async () => {
        target.click();
        await Promise.resolve();
        await Promise.resolve();
    });
}

function panelHeader(): HTMLButtonElement {
    const header = document.querySelector("button[aria-expanded]");
    assert.ok(header instanceof HTMLButtonElement, "missing panel header");
    return header;
}

function tabButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
    );
    assert.ok(button instanceof HTMLButtonElement, `missing ${label} tab`);
    return button;
}

test("metadata gaps drill-down renders backend album and track shapes", async () => {
    const mounted = await mountPanel(async () => {
        const { MetadataGapsPanel } =
            await import("../../features/library-health/components/MetadataGapsPanel");
        return {
            element: React.createElement(MetadataGapsPanel, {
                gaps: SUMMARY_GAPS,
            }),
        };
    });

    await click(panelHeader());
    assert.equal(getLibraryHealthGaps.mock.callCount(), 1);
    assert.match(document.body.textContent ?? "", /Bare Album/);
    assert.match(document.body.textContent ?? "", /Cover Artist/);

    await click(tabButton("Genres"));
    assert.equal(getLibraryHealthGaps.mock.callCount(), 2);
    assert.equal(
        getLibraryHealthGaps.mock.calls[1]?.arguments[0],
        "missing-genres",
    );
    assert.match(document.body.textContent ?? "", /Genreless Track/);
    assert.match(document.body.textContent ?? "", /Some Artist — Some Album/);

    await mounted.unmount();
});

test("a failed panel load shows an error with a working Retry control", async () => {
    failGapLoads = 1;
    const mounted = await mountPanel(async () => {
        const { MetadataGapsPanel } =
            await import("../../features/library-health/components/MetadataGapsPanel");
        return {
            element: React.createElement(MetadataGapsPanel, {
                gaps: SUMMARY_GAPS,
            }),
        };
    });

    await click(panelHeader());
    assert.match(
        document.body.textContent ?? "",
        /Failed to load metadata gaps/,
    );
    assert.doesNotMatch(document.body.textContent ?? "", /Bare Album/);

    await click(tabButton("Retry"));
    assert.equal(getLibraryHealthGaps.mock.callCount(), 2);
    assert.doesNotMatch(
        document.body.textContent ?? "",
        /Failed to load metadata gaps/,
    );
    assert.match(document.body.textContent ?? "", /Bare Album/);

    await mounted.unmount();
});

test("analysis coverage drill-down renders backend failed-track shape", async () => {
    const mounted = await mountPanel(async () => {
        const { AnalysisCoveragePanel } =
            await import("../../features/library-health/components/AnalysisCoveragePanel");
        return {
            element: React.createElement(AnalysisCoveragePanel, {
                coverage: SUMMARY_COVERAGE,
            }),
        };
    });

    await click(panelHeader());
    assert.equal(getLibraryHealthAnalysis.mock.callCount(), 1);
    assert.match(document.body.textContent ?? "", /Broken Track/);
    assert.match(document.body.textContent ?? "", /Failing Artist/);
    assert.match(document.body.textContent ?? "", /decode failed/);

    await mounted.unmount();
});
