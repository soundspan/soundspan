import { setVibeEmbeddingCoverage } from "../metrics";
import type { VibeEmbeddingCoverage } from "../metrics/vibeEmbedMetrics";
import { prisma } from "../utils/db";
import { getVibeEmbeddingTargetSpaceId } from "./embeddingSpaces";
import { vibeEmbeddingEligibleTrackWhere } from "./vibeEmbeddingEligibility";

interface CoverageRefresherDependencies {
    loadCoverage(): Promise<VibeEmbeddingCoverage>;
    setCoverage(coverage: VibeEmbeddingCoverage): void;
}

/** Counts every stored vector in one embedding space. */
export async function loadVibeSpaceEmbeddedCount(
    spaceId: string,
): Promise<number> {
    return prisma.trackEmbedding.count({ where: { spaceId } });
}

/** Loads target-space coverage for local tracks eligible for audio analysis. */
export async function loadVibeEmbeddingCoverage(
    targetSpaceId?: string,
): Promise<VibeEmbeddingCoverage> {
    const resolvedTargetSpaceId =
        targetSpaceId ?? (await getVibeEmbeddingTargetSpaceId());
    const eligibleWhere = vibeEmbeddingEligibleTrackWhere();
    const [total, embedded, failed] = await Promise.all([
        prisma.track.count({ where: eligibleWhere }),
        prisma.track.count({
            where: {
                ...eligibleWhere,
                embeddings: { some: { spaceId: resolvedTargetSpaceId } },
            },
        }),
        prisma.track.count({
            where: {
                ...eligibleWhere,
                embeddings: { none: { spaceId: resolvedTargetSpaceId } },
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

/** Refreshes target-space coverage in the process-local metrics registry. */
export async function refreshVibeEmbeddingCoverage(
    targetSpaceId?: string,
): Promise<void> {
    const coverage = await loadVibeEmbeddingCoverage(targetSpaceId);
    setVibeEmbeddingCoverage(coverage);
}
