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

function qualityPage(floor: number) {
    return {
        floorKbps: floor,
        items: [
            {
                albumId: "album-q",
                title: `Album under ${floor}`,
                artist: { id: "artist-q", name: "Lossy Artist" },
                averageBitrateKbps: floor - 20,
                trackCount: 9,
            },
        ],
        total: 1,
        limit: 50,
        offset: 0,
        sampledTracks: 10,
        sampleLimit: 100_000,
        isTruncated: false,
    };
}

let deferQualityLoads = false;
let qualityResolvers: Array<() => void> = [];
const getLibraryHealthQuality = mock.fn((floor: number) => {
    if (!deferQualityLoads) return Promise.resolve(qualityPage(floor));
    return new Promise((resolve) => {
        qualityResolvers.push(() => resolve(qualityPage(floor)));
    });
});

// Section-level methods are attached below (Object.assign) once their
// fixtures are defined; the mocked module keeps this object's identity.
const apiMock: Record<string, unknown> = {
    getLibraryHealthGaps,
    getLibraryHealthAnalysis,
    getLibraryHealthQuality,
    retryFailedAnalysis,
};

mock.module("@/lib/api", {
    namedExports: { api: apiMock },
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
    deferQualityLoads = false;
    qualityResolvers = [];
    getLibraryHealthGaps.mock.resetCalls();
    getLibraryHealthAnalysis.mock.resetCalls();
    getLibraryHealthQuality.mock.resetCalls();
    retryFailedAnalysis.mock.resetCalls();
    getLibraryHealthSummary.mock.resetCalls();
    refreshLibraryHealthDashboard.mock.resetCalls();
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
        rerender: async (nextElement: React.ReactElement) => {
            await React.act(async () => {
                root.render(nextElement);
                await Promise.resolve();
                await Promise.resolve();
            });
        },
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
                refreshToken: 0,
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
                refreshToken: 0,
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
                refreshToken: 0,
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

test("quality panel fetches on expand and floor selection, latest selection wins", async () => {
    const { QualityPanel } =
        await import("../../features/library-health/components/QualityPanel");
    const mounted = await mountPanel(async () => ({
        element: React.createElement(QualityPanel, {
            quality: {
                floorKbps: 192,
                albumsBelowFloor: 1,
                isTruncated: false,
            },
            refreshToken: 0,
        }),
    }));

    await click(panelHeader());
    assert.equal(getLibraryHealthQuality.mock.callCount(), 1);
    assert.equal(getLibraryHealthQuality.mock.calls[0]?.arguments[0], 192);
    assert.match(document.body.textContent ?? "", /Album under 192/);

    deferQualityLoads = true;
    await click(tabButton("128 kbps"));
    // While the replacement request is pending, the previous floor's rows
    // must not render beside the newly selected floor.
    assert.doesNotMatch(document.body.textContent ?? "", /Album under 192/);
    await click(tabButton("256 kbps"));
    assert.equal(getLibraryHealthQuality.mock.callCount(), 3);
    assert.equal(getLibraryHealthQuality.mock.calls[1]?.arguments[0], 128);
    assert.equal(getLibraryHealthQuality.mock.calls[2]?.arguments[0], 256);

    // Resolve out of order: the superseded 128 response must not render.
    const [resolve128, resolve256] = qualityResolvers;
    await React.act(async () => {
        resolve256?.();
        await Promise.resolve();
        resolve128?.();
        await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /Album under 256/);
    assert.doesNotMatch(document.body.textContent ?? "", /Album under 128/);

    await mounted.unmount();
});

test("a refresh-token bump reloads an expanded panel", async () => {
    const { MetadataGapsPanel } =
        await import("../../features/library-health/components/MetadataGapsPanel");
    const mounted = await mountPanel(async () => ({
        element: React.createElement(MetadataGapsPanel, {
            gaps: SUMMARY_GAPS,
            refreshToken: 0,
        }),
    }));

    await click(panelHeader());
    assert.equal(getLibraryHealthGaps.mock.callCount(), 1);

    await mounted.rerender(
        React.createElement(MetadataGapsPanel, {
            gaps: SUMMARY_GAPS,
            refreshToken: 1,
        }),
    );
    assert.equal(getLibraryHealthGaps.mock.callCount(), 2);

    await mounted.unmount();
});

test("analysis retry action reports remediation to the section", async () => {
    const { AnalysisCoveragePanel } =
        await import("../../features/library-health/components/AnalysisCoveragePanel");
    const onRemediated = mock.fn();
    const mounted = await mountPanel(async () => ({
        element: React.createElement(AnalysisCoveragePanel, {
            coverage: SUMMARY_COVERAGE,
            refreshToken: 0,
            onRemediated,
        }),
    }));

    await click(panelHeader());
    await click(tabButton("Retry failed audio analysis"));
    assert.equal(retryFailedAnalysis.mock.callCount(), 1);
    assert.equal(onRemediated.mock.callCount(), 1);

    await mounted.unmount();
});

// --- Section-level integration: real wiring from Recompute/remediation to panels ---

const SECTION_SUMMARY_INITIAL = {
    metadataGaps: SUMMARY_GAPS,
    analysisCoverage: SUMMARY_COVERAGE,
    storage: {
        tracks: 10,
        totalFileSize: 1024,
        mimeTypes: 1,
        artists: 2,
        isTruncated: false,
    },
    quality: { floorKbps: 192, albumsBelowFloor: 1, isTruncated: false },
    duplicates: {
        clusters: 0,
        byTier: { audioHash: 0, recordingMbid: 0, isrc: 0 },
        isTruncated: false,
    },
};
const SECTION_SUMMARY_REFRESHED = {
    ...SECTION_SUMMARY_INITIAL,
    metadataGaps: { ...SUMMARY_GAPS, missingArt: { albums: 7, artists: 3 } },
    analysisCoverage: {
        ...SUMMARY_COVERAGE,
        analysisStatus: { pending: 0, processing: 0, failed: 0, completed: 10 },
    },
};

const getLibraryHealthSummary = mock.fn(async () => SECTION_SUMMARY_INITIAL);
const refreshLibraryHealthDashboard = mock.fn(
    async () => SECTION_SUMMARY_REFRESHED,
);
const getLibraryHealthStorage = mock.fn(async () => ({
    formats: [],
    topArtists: [],
    sampledTracks: 0,
    sampleLimit: 100_000,
    isTruncated: false,
}));
function duplicateMember(index: number) {
    return {
        id: `dup-${index}`,
        title: `Copy ${index}`,
        albumTitle: "Dup Album",
        artistName: "Dup Artist",
        filePath: `/music/copy-${index}.flac`,
        fileSize: 1024,
        mime: "FLAC",
    };
}

// Mirrors the backend's capped preview: memberCount counts every member,
// members embeds only the preview subset.
const DUPLICATES_PAGE = {
    clusters: [
        {
            tier: "audioHash",
            identity: "hash-1",
            memberCount: 11,
            totalFileSize: 11 * 1024,
            members: Array.from({ length: 8 }, (_, index) =>
                duplicateMember(index),
            ),
        },
    ],
    total: 1,
    byTier: { audioHash: 1, recordingMbid: 0, isrc: 0 },
    isTruncated: false,
    limit: 25,
    offset: 0,
};

const getLibraryHealthDuplicates = mock.fn(async () => DUPLICATES_PAGE);

Object.assign(apiMock, {
    getLibraryHealthSummary,
    refreshLibraryHealthDashboard,
    getLibraryHealthStorage,
    getLibraryHealthDuplicates,
});

mock.module("@/features/settings/components/ui", {
    namedExports: {
        SettingsSection: (props: {
            title: string;
            titleExtra?: React.ReactNode;
            description?: string;
            children?: React.ReactNode;
        }) =>
            React.createElement(
                "section",
                null,
                React.createElement("h2", null, props.title),
                props.titleExtra,
                props.children,
            ),
    },
});

function headerByTitle(title: string): HTMLButtonElement {
    const header = Array.from(
        document.querySelectorAll("button[aria-expanded]"),
    ).find((candidate) => candidate.textContent?.includes(title));
    assert.ok(header instanceof HTMLButtonElement, `missing ${title} header`);
    return header;
}

function sectionButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
            candidate.getAttribute("aria-label") === label ||
            candidate.textContent?.trim() === label,
    );
    assert.ok(button instanceof HTMLButtonElement, `missing ${label} button`);
    return button;
}

test("Recompute now reloads expanded panels and updates headlines through the real section wiring", async () => {
    const mounted = await mountPanel(async () => {
        const { LibraryInsightsSection } =
            await import("../../features/library-health/components/LibraryInsightsSection");
        return { element: React.createElement(LibraryInsightsSection) };
    });

    assert.equal(getLibraryHealthSummary.mock.callCount(), 1);
    assert.match(document.body.textContent ?? "", /1 albums without art/);

    await click(headerByTitle("Metadata gaps"));
    assert.equal(getLibraryHealthGaps.mock.callCount(), 1);

    await click(sectionButton("Recompute library insights"));
    assert.equal(refreshLibraryHealthDashboard.mock.callCount(), 1);
    assert.match(document.body.textContent ?? "", /7 albums without art/);
    assert.equal(getLibraryHealthGaps.mock.callCount(), 2);

    await mounted.unmount();
});

test("analysis retry refreshes the section headline through the real wiring", async () => {
    const mounted = await mountPanel(async () => {
        const { LibraryInsightsSection } =
            await import("../../features/library-health/components/LibraryInsightsSection");
        return { element: React.createElement(LibraryInsightsSection) };
    });

    assert.match(document.body.textContent ?? "", /1 failed/);

    await click(headerByTitle("Analysis coverage"));
    assert.equal(getLibraryHealthAnalysis.mock.callCount(), 1);

    await click(sectionButton("Retry failed audio analysis"));
    assert.equal(retryFailedAnalysis.mock.callCount(), 1);
    assert.equal(refreshLibraryHealthDashboard.mock.callCount(), 1);
    assert.match(document.body.textContent ?? "", /0 failed/);
    assert.equal(getLibraryHealthAnalysis.mock.callCount(), 2);

    await mounted.unmount();
});

test("duplicate clusters disclose capped member previews", async () => {
    const { DuplicatesPanel } =
        await import("../../features/library-health/components/DuplicatesPanel");
    const mounted = await mountPanel(async () => ({
        element: React.createElement(DuplicatesPanel, {
            duplicates: {
                clusters: 1,
                byTier: { audioHash: 1, recordingMbid: 0, isrc: 0 },
                isTruncated: false,
            },
            refreshToken: 0,
        }),
    }));

    await click(panelHeader());
    assert.equal(getLibraryHealthDuplicates.mock.callCount(), 1);
    assert.match(document.body.textContent ?? "", /11 tracks/);
    assert.match(document.body.textContent ?? "", /Copy 0/);
    assert.match(document.body.textContent ?? "", /Showing 8 of 11 tracks\./);

    await mounted.unmount();
});
