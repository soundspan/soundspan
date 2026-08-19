import { prisma } from "../../utils/db";
import {
    normalizePagination,
    type LibraryHealthPagination,
} from "./pagination";
import { VISIBLE_LOCAL_TRACK_WHERE } from "./predicates";

/** Analysis lifecycle values written by the enrichment and vibe workers. */
export const ANALYSIS_STATUS_VALUES = [
    "pending",
    "processing",
    "failed",
    "completed",
] as const;
type AnalysisStatus = (typeof ANALYSIS_STATUS_VALUES)[number];
type StatusCounts = Record<AnalysisStatus, number>;

function emptyStatusCounts(): StatusCounts {
    return { pending: 0, processing: 0, failed: 0, completed: 0 };
}

function analysisCounts(
    rows: Array<{ analysisStatus: string; _count: number }>,
): StatusCounts {
    const counts = emptyStatusCounts();
    for (const row of rows) {
        if (
            ANALYSIS_STATUS_VALUES.includes(
                row.analysisStatus as AnalysisStatus,
            )
        ) {
            counts[row.analysisStatus as AnalysisStatus] += row._count;
        } else {
            // Legacy worker values have no public bucket; keep totals visible as pending work.
            counts.pending += row._count;
        }
    }
    return counts;
}

function vibeCounts(
    rows: Array<{ vibeAnalysisStatus: string | null; _count: number }>,
): StatusCounts {
    const counts = emptyStatusCounts();
    for (const row of rows) {
        const status = row.vibeAnalysisStatus ?? "pending";
        if (ANALYSIS_STATUS_VALUES.includes(status as AnalysisStatus)) {
            counts[status as AnalysisStatus] += row._count;
        } else {
            // Legacy worker values have no public bucket; keep totals visible as pending work.
            counts.pending += row._count;
        }
    }
    return counts;
}

/** Returns aggregate status and loudness coverage for visible local tracks. */
export async function getAnalysisCoverageSummary() {
    const [analysisRows, vibeRows, total, measured, missing] =
        await Promise.all([
            prisma.track.groupBy({
                by: ["analysisStatus"],
                where: VISIBLE_LOCAL_TRACK_WHERE,
                _count: true,
            }),
            prisma.track.groupBy({
                by: ["vibeAnalysisStatus"],
                where: VISIBLE_LOCAL_TRACK_WHERE,
                _count: true,
            }),
            prisma.track.count({ where: VISIBLE_LOCAL_TRACK_WHERE }),
            prisma.track.count({
                where: {
                    ...VISIBLE_LOCAL_TRACK_WHERE,
                    loudnessLufs: { not: null },
                    truePeakDb: { not: null },
                },
            }),
            prisma.track.count({
                where: {
                    ...VISIBLE_LOCAL_TRACK_WHERE,
                    OR: [{ loudnessLufs: null }, { truePeakDb: null }],
                },
            }),
        ]);
    const statuses = analysisCounts(analysisRows);
    return {
        total,
        analysisStatus: statuses,
        vibeAnalysisStatus: vibeCounts(vibeRows),
        loudness: { measured, missing },
    };
}

async function listAnalysisFailures(pagination: LibraryHealthPagination) {
    const page = normalizePagination(pagination);
    const where = {
        ...VISIBLE_LOCAL_TRACK_WHERE,
        analysisStatus: "failed",
    } as const;
    const [total, rows] = await Promise.all([
        prisma.track.count({ where }),
        prisma.track.findMany({
            where,
            select: {
                id: true,
                title: true,
                analysisError: true,
                album: {
                    select: { title: true, artist: { select: { name: true } } },
                },
            },
            orderBy: [{ title: "asc" }, { id: "asc" }],
            take: page.limit,
            skip: page.offset,
        }),
    ]);
    const items = rows.map((row) => ({
        id: row.id,
        title: row.title,
        artistName: row.album.artist.name,
        albumTitle: row.album.title,
        analysisError: row.analysisError,
    }));
    return { items, total, ...page };
}

/** Returns analysis coverage plus a bounded audio-analysis failure page. */
export async function getAnalysisCoverage(pagination: LibraryHealthPagination) {
    const [summary, failed] = await Promise.all([
        getAnalysisCoverageSummary(),
        listAnalysisFailures(pagination),
    ]);
    return { ...summary, failed };
}
