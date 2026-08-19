import {
    getAnalysisCoverage,
    getAnalysisCoverageSummary,
} from "./analysisCoverage";
import { prisma } from "../../utils/db";
import {
    getCachedLibraryHealthPanel,
    invalidateLibraryHealthDashboardCache,
} from "./cache";
import {
    listDuplicateClusters,
    loadDuplicateClusterCatalog,
} from "./duplicateClusters";
import {
    getMetadataGapSummary,
    listMetadataGap,
    type MetadataGapKind,
} from "./metadataGaps";
import type { LibraryHealthPagination } from "./pagination";
import { VISIBLE_LOCAL_TRACK_WHERE } from "./predicates";
import {
    getQualityOutliers,
    loadLossyAlbumQualityStats,
} from "./qualityOutliers";
import { loadStorageAnalytics } from "./storageAnalytics";

export { invalidateLibraryHealthDashboardCache } from "./cache";
export { METADATA_GAP_KINDS, type MetadataGapKind } from "./metadataGaps";

/** Returns one metadata gap page. */
export function getLibraryHealthMetadataGaps(
    kind: MetadataGapKind,
    pagination: LibraryHealthPagination,
) {
    return listMetadataGap(kind, pagination);
}

/** Returns analysis counts plus one failure page. */
export function getLibraryHealthAnalysis(pagination: LibraryHealthPagination) {
    return getAnalysisCoverage(pagination);
}

/** Returns cached storage analytics. */
export function getLibraryHealthStorage() {
    return getCachedLibraryHealthPanel("storage", loadStorageAnalytics);
}

/** Returns cached lossy album statistics filtered by the requested floor. */
export async function getLibraryHealthQuality(
    floorKbps: number,
    pagination: LibraryHealthPagination,
) {
    const stats = await getCachedLibraryHealthPanel(
        "quality",
        loadLossyAlbumQualityStats,
    );
    return getQualityOutliers(stats, floorKbps, pagination);
}

/** Returns one page from the cached duplicate-cluster catalog. */
export async function getLibraryHealthDuplicates(
    pagination: LibraryHealthPagination,
) {
    const catalog = await getCachedLibraryHealthPanel(
        "duplicates",
        loadDuplicateClusterCatalog,
    );
    return listDuplicateClusters(catalog, pagination);
}

async function loadSummary() {
    const [
        metadataGaps,
        analysisCoverage,
        storage,
        quality,
        duplicates,
        artists,
    ] = await Promise.all([
        getMetadataGapSummary(),
        getAnalysisCoverageSummary(),
        getLibraryHealthStorage(),
        getLibraryHealthQuality(192, { limit: 1, offset: 0 }),
        getLibraryHealthDuplicates({ limit: 1, offset: 0 }),
        prisma.artist.count({
            where: {
                albums: {
                    some: {
                        location: "LIBRARY",
                        tracks: { some: VISIBLE_LOCAL_TRACK_WHERE },
                    },
                },
            },
        }),
    ]);
    return {
        metadataGaps,
        analysisCoverage,
        storage: {
            tracks: storage.formats.reduce(
                (sum, row) => sum + row.trackCount,
                0,
            ),
            totalFileSize: storage.formats.reduce(
                (sum, row) => sum + row.totalFileSize,
                0,
            ),
            mimeTypes: storage.formats.length,
            artists,
            isTruncated: storage.isTruncated,
        },
        quality: {
            floorKbps: quality.floorKbps,
            albumsBelowFloor: quality.total,
            isTruncated: quality.isTruncated,
        },
        duplicates: {
            clusters: duplicates.total,
            byTier: duplicates.byTier,
            isTruncated: duplicates.isTruncated,
        },
    };
}

/** Returns every dashboard panel count in one cached payload. */
export function getLibraryHealthDashboardSummary() {
    return getCachedLibraryHealthPanel("summary", loadSummary);
}
