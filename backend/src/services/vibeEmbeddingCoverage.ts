import { setVibeEmbeddingCoverage } from "../metrics";
import type { VibeEmbeddingCoverage } from "../metrics/vibeEmbedMetrics";
import { prisma } from "../utils/db";
import { LOCAL_TRACK_WHERE } from "../utils/librarySorting";
import { getActiveSpace } from "./embeddingSpaces";

interface CoverageRefresherDependencies {
    loadCoverage(): Promise<VibeEmbeddingCoverage>;
    setCoverage(coverage: VibeEmbeddingCoverage): void;
}

/** Loads active-space coverage for local tracks eligible for audio analysis. */
export async function loadVibeEmbeddingCoverage(): Promise<VibeEmbeddingCoverage> {
    const activeSpace = await getActiveSpace();
    const eligibleWhere = {
        ...LOCAL_TRACK_WHERE,
        removedAt: null,
        filePath: { not: null },
    } as const;
    const [total, embedded, failed] = await Promise.all([
        prisma.track.count({ where: eligibleWhere }),
        prisma.track.count({
            where: {
                ...eligibleWhere,
                embedding: { is: { spaceId: activeSpace.id } },
            },
        }),
        prisma.track.count({
            where: {
                ...eligibleWhere,
                OR: [
                    { embedding: null },
                    {
                        embedding: {
                            is: { spaceId: { not: activeSpace.id } },
                        },
                    },
                ],
                vibeAnalysisStatus: "failed",
            },
        }),
    ]);
    return {
        embedded,
        failed,
        pending: Math.max(0, total - embedded - failed),
    };
}

/** Creates the slow worker-owned coverage refresh operation. */
export function createVibeEmbeddingCoverageRefresher(
    dependencies: CoverageRefresherDependencies,
): () => Promise<void> {
    return async () => {
        const coverage = await dependencies.loadCoverage();
        dependencies.setCoverage(coverage);
    };
}

/** Refreshes active-space coverage in the process-local metrics registry. */
export const refreshVibeEmbeddingCoverage =
    createVibeEmbeddingCoverageRefresher({
        loadCoverage: loadVibeEmbeddingCoverage,
        setCoverage: setVibeEmbeddingCoverage,
    });
