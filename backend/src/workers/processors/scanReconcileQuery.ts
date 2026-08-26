import { Prisma } from "@prisma/client";
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../../services/downloadJobStatus";
import { matchAlbum } from "../../utils/fuzzyMatch";
import { prisma } from "../../utils/db";
import { escapeLikePattern } from "../../utils/likePattern";
import { logger } from "../../utils/logger";
import { resolveDownloadJobMetadata } from "../../utils/downloadJobMetadata";

const log = logger.child("ScanReconcileQuery");
const ARTIST_PREFIX_LENGTH = 5;
const SCAN_RECONCILE_ALBUM_LOCATIONS = ["LIBRARY", "DISCOVER"] as const;

/** Maximum active download jobs reconciled after one scan. */
export const SCAN_RECONCILE_ACTIVE_JOB_LIMIT = 500;
/** Maximum artist patterns bound to one candidate query. */
export const SCAN_RECONCILE_PATTERN_CHUNK_SIZE = 100;
/** Maximum candidate albums retained from one pattern chunk. */
export const SCAN_RECONCILE_CANDIDATE_LIMIT = 1_000;
/** Query limit including one sentinel row used to detect truncation. */
export const SCAN_RECONCILE_CANDIDATE_FETCH_LIMIT =
    SCAN_RECONCILE_CANDIDATE_LIMIT + 1;

/** Flat album row used by post-scan download reconciliation. */
export interface ScanReconcileCandidate {
    id: string;
    title: string;
    artistName: string;
    trackCount: number;
}

type ScanReconcileAlbumRow = Omit<ScanReconcileCandidate, "trackCount">;

/** Active download-job fields used by the pure reconciliation matcher. */
export interface ReconcileJob {
    id: string;
    discoveryBatchId: string | null;
    artistName: string;
    albumTitle: string;
    expectedTracks: number | null;
}

/** Convert literal artist prefixes into case-insensitive contains patterns. */
export function buildScanReconcilePatterns(prefixes: string[]): string[] {
    return prefixes.map((prefix) => `%${escapeLikePattern(prefix)}%`);
}

/** Split candidate patterns into bounded query chunks. */
export function chunkScanReconcilePatterns(patterns: string[]): string[][] {
    const chunkCount = Math.ceil(
        patterns.length / SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
    );
    return Array.from({ length: chunkCount }, (_unused, index) =>
        patterns.slice(
            index * SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
            (index + 1) * SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
        ),
    );
}

/** Build one parameter-bound flat candidate query. */
export function buildScanReconcileCandidateQuery(
    patterns: string[],
): Prisma.Sql {
    if (
        patterns.length === 0 ||
        patterns.length > SCAN_RECONCILE_PATTERN_CHUNK_SIZE
    ) {
        throw new RangeError("Scan reconcile pattern chunk is out of bounds");
    }

    // PostgreSQL forbids an ESCAPE clause with operator ANY. Its default LIKE
    // escape is backslash, which buildScanReconcilePatterns applies literally.
    return Prisma.sql`
        SELECT
            al.id,
            al.title,
            ar.name AS "artistName"
        FROM "Album" AS al
        INNER JOIN "Artist" AS ar ON ar.id = al."artistId"
        WHERE ar.name ILIKE ANY(${patterns}::text[])
          AND al.location IN ('LIBRARY', 'DISCOVER')
        ORDER BY al."updatedAt" DESC, al.id ASC
        LIMIT ${SCAN_RECONCILE_CANDIDATE_FETCH_LIMIT}
    `;
}

/** Count active local tracks for eligible library album IDs. */
export async function loadActiveLocalTrackCounts(
    albumIds: string[],
): Promise<Map<string, number>> {
    if (albumIds.length === 0) return new Map();
    const counts = await prisma.track.groupBy({
        by: ["albumId"],
        where: {
            albumId: { in: albumIds },
            origin: "LOCAL",
            removedAt: null,
            album: {
                location: { in: [...SCAN_RECONCILE_ALBUM_LOCATIONS] },
            },
        },
        _count: { _all: true },
    });
    return new Map(counts.map((count) => [count.albumId, count._count._all]));
}

/** Load bounded, deduplicated album candidates for literal artist prefixes. */
export async function loadScanReconcileCandidates(
    prefixes: string[],
): Promise<ScanReconcileCandidate[]> {
    if (prefixes.length > SCAN_RECONCILE_ACTIVE_JOB_LIMIT) {
        throw new RangeError("Scan reconcile prefix count is out of bounds");
    }
    const chunks = chunkScanReconcilePatterns(
        buildScanReconcilePatterns(prefixes),
    );
    const candidates = new Map<string, ScanReconcileAlbumRow>();

    for (const [chunkIndex, patterns] of chunks.entries()) {
        const rows = await prisma.$queryRaw<ScanReconcileAlbumRow[]>(
            buildScanReconcileCandidateQuery(patterns),
        );
        if (rows.length > SCAN_RECONCILE_CANDIDATE_LIMIT) {
            log.warn("Scan reconciliation candidate cap truncated work", {
                chunkIndex,
                patternCount: patterns.length,
                retainedCandidates: SCAN_RECONCILE_CANDIDATE_LIMIT,
            });
        }
        for (const candidate of rows.slice(0, SCAN_RECONCILE_CANDIDATE_LIMIT)) {
            candidates.set(candidate.id, candidate);
        }
    }

    const candidateRows = [...candidates.values()];
    const trackCounts = await loadActiveLocalTrackCounts(
        candidateRows.map((candidate) => candidate.id),
    );
    return candidateRows.map((candidate) => ({
        ...candidate,
        trackCount: trackCounts.get(candidate.id) ?? 0,
    }));
}

function resolveReconcileJobs(
    activeJobs: Array<{
        id: string;
        metadata: unknown;
        discoveryBatchId: string | null;
    }>,
): ReconcileJob[] {
    return activeJobs.flatMap((job) => {
        const { artistName, albumTitle, metadata } = resolveDownloadJobMetadata(
            job.metadata,
        );
        if (!artistName || !albumTitle) return [];
        const expectedTracks = metadata.expectedTracks;
        return [
            {
                ...job,
                artistName,
                albumTitle,
                expectedTracks:
                    typeof expectedTracks === "number" &&
                    Number.isSafeInteger(expectedTracks) &&
                    expectedTracks > 0
                        ? expectedTracks
                        : null,
            },
        ];
    });
}

function candidateHasEnoughTracks(
    candidate: ScanReconcileCandidate,
    expectedTracks: number | null,
): boolean {
    return expectedTracks === null
        ? candidate.trackCount > 0
        : candidate.trackCount >= expectedTracks;
}

/** Return whether any eligible album candidate matches one active job. */
export function candidateMatchesJob(
    job: ReconcileJob,
    candidates: ScanReconcileCandidate[],
): boolean {
    const artistName = job.artistName.toLowerCase();
    const albumTitle = job.albumTitle.toLowerCase();
    const exactMatch = candidates.some(
        (candidate) =>
            candidateHasEnoughTracks(candidate, job.expectedTracks) &&
            candidate.artistName.toLowerCase().includes(artistName) &&
            candidate.title.toLowerCase().includes(albumTitle),
    );
    if (exactMatch) return true;

    return candidates.some(
        (candidate) =>
            candidateHasEnoughTracks(candidate, job.expectedTracks) &&
            matchAlbum(
                job.artistName,
                job.albumTitle,
                candidate.artistName,
                candidate.title,
                0.75,
            ),
    );
}

async function checkDiscoveryBatches(jobs: ReconcileJob[]): Promise<void> {
    const batchIds = [
        ...new Set(
            jobs.flatMap((job) =>
                job.discoveryBatchId ? [job.discoveryBatchId] : [],
            ),
        ),
    ];
    if (batchIds.length === 0) return;

    const { discoverWeeklyService } =
        await import("../../services/discoverWeekly");
    for (const batchId of batchIds) {
        await discoverWeeklyService.checkBatchCompletion(batchId);
    }
}

/** Reconcile the oldest bounded window of active download jobs after a scan. */
export async function reconcileDownloadJobsWithScan(): Promise<number> {
    const fetchedJobs = await prisma.downloadJob.findMany({
        where: { status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES } },
        select: { id: true, metadata: true, discoveryBatchId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: SCAN_RECONCILE_ACTIVE_JOB_LIMIT + 1,
    });
    const activeJobs = fetchedJobs.slice(0, SCAN_RECONCILE_ACTIVE_JOB_LIMIT);
    if (fetchedJobs.length > SCAN_RECONCILE_ACTIVE_JOB_LIMIT) {
        log.warn("Scan reconciliation active-job cap truncated work", {
            processedJobs: SCAN_RECONCILE_ACTIVE_JOB_LIMIT,
            deferredJobsAtLeast: 1,
        });
    }
    const jobs = resolveReconcileJobs(activeJobs);
    if (jobs.length === 0) return 0;

    const prefixes = [
        ...new Set(
            jobs.map((job) =>
                job.artistName.substring(0, ARTIST_PREFIX_LENGTH).toLowerCase(),
            ),
        ),
    ];
    const candidates = await loadScanReconcileCandidates(prefixes);
    const matchedJobs = jobs.filter((job) =>
        candidateMatchesJob(job, candidates),
    );
    if (matchedJobs.length === 0) return 0;

    await prisma.downloadJob.updateMany({
        where: { id: { in: matchedJobs.map((job) => job.id) } },
        data: {
            status: "completed",
            completedAt: new Date(),
            error: null,
        },
    });
    await checkDiscoveryBatches(matchedJobs);
    return matchedJobs.length;
}
