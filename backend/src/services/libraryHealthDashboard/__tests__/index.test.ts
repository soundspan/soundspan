const getCachedPanel = jest.fn();
const metadataSummary = jest.fn();
const analysisSummary = jest.fn();
const loadStorage = jest.fn();
const loadQuality = jest.fn();
const qualityOutliers = jest.fn();
const loadDuplicates = jest.fn();
const listDuplicates = jest.fn();
const artistCount = jest.fn();

jest.mock("../cache", () => ({
    getCachedLibraryHealthPanel: (...args: unknown[]) =>
        getCachedPanel(...args),
    invalidateLibraryHealthDashboardCache: jest.fn(),
}));
jest.mock("../metadataGaps", () => ({
    METADATA_GAP_KINDS: [],
    getMetadataGapSummary: (...args: unknown[]) => metadataSummary(...args),
    listMetadataGap: jest.fn(),
}));
jest.mock("../analysisCoverage", () => ({
    getAnalysisCoverage: jest.fn(),
    getAnalysisCoverageSummary: (...args: unknown[]) =>
        analysisSummary(...args),
}));
jest.mock("../storageAnalytics", () => ({
    loadStorageAnalytics: (...args: unknown[]) => loadStorage(...args),
}));
jest.mock("../qualityOutliers", () => ({
    loadLossyAlbumQualityStats: (...args: unknown[]) => loadQuality(...args),
    getQualityOutliers: (...args: unknown[]) => qualityOutliers(...args),
}));
jest.mock("../duplicateClusters", () => ({
    loadDuplicateClusterCatalog: (...args: unknown[]) =>
        loadDuplicates(...args),
    listDuplicateClusters: (...args: unknown[]) => listDuplicates(...args),
}));
jest.mock("../../../utils/db", () => ({
    prisma: { artist: { count: (...args: unknown[]) => artistCount(...args) } },
}));

import { getLibraryHealthDashboardSummary } from "../index";

describe("library health dashboard summary", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getCachedPanel.mockImplementation(
            (_panel: string, loader: () => Promise<unknown>) => loader(),
        );
        metadataSummary.mockResolvedValue({ missingLyrics: 0 });
        analysisSummary.mockResolvedValue({ total: 30 });
        loadStorage.mockResolvedValue({
            formats: [
                { trackCount: 20, totalFileSize: 2_000 },
                { trackCount: 10, totalFileSize: 1_000 },
            ],
            topArtists: Array.from({ length: 25 }, (_, index) => ({
                artistId: `artist-${index}`,
            })),
            isTruncated: false,
        });
        loadQuality.mockResolvedValue({});
        qualityOutliers.mockReturnValue({
            floorKbps: 192,
            total: 2,
            isTruncated: false,
        });
        loadDuplicates.mockResolvedValue({});
        listDuplicates.mockReturnValue({
            total: 3,
            byTier: { audioHash: 1, recordingMbid: 1, isrc: 1 },
            isTruncated: false,
        });
        artistCount.mockResolvedValue(41);
    });

    it("reports the distinct visible local artist count, not the top-artists sample", async () => {
        const result = await getLibraryHealthDashboardSummary();

        expect(result.storage.artists).toBe(41);
        expect(artistCount).toHaveBeenCalledWith({
            where: {
                albums: {
                    some: {
                        location: "LIBRARY",
                        tracks: {
                            some: {
                                origin: "LOCAL",
                                removedAt: null,
                                album: {
                                    location: {
                                        in: [
                                            "LIBRARY",
                                            "DISCOVER",
                                            "REMOTE",
                                            "FEDERATED",
                                        ],
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
    });
});
