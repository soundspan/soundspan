import { setVibeEmbeddingCoverage } from "../metrics";
import type { VibeEmbeddingCoverage } from "../metrics/vibeEmbedMetrics";
import { prisma } from "../utils/db";
import { getVibeEmbeddingTargetSpaceId } from "./embeddingSpaces";
import { vibeEmbeddingEligibleTrackWhere } from "./vibeEmbeddingEligibility";

interface CoverageRefresherDependencies {
    loadCoverage(): Promise<VibeEmbeddingCoverage>;
    setCoverage(coverage: VibeEmbeddingCoverage): void;
}

/** Loads durable vector-presence history for instant-cutover decisions. */
export async function loadVibeSpaceVectorState(
    spaceId: string,
): Promise<{ hasVectors: boolean; hadVectors: boolean }> {
    const [embedding, space] = await Promise.all([
        prisma.trackEmbedding.findFirst({
            where: { spaceId },
            select: { trackId: true },
        }),
        prisma.embeddingSpace.findUnique({
            where: { id: spaceId },
            select: { hadVectors: true },
        }),
    ]);
    if (!space) throw new Error(`Embedding space ${spaceId} is not registered`);
    return { hasVectors: embedding !== null, hadVectors: space.hadVectors };
}

/** Loads target-space coverage for local tracks eligible for audio analysis. */
export async function loadVibeEmbeddingCoverage(
    targetSpaceId?: string,
): Promise<VibeEmbeddingCoverage> {
    const resolvedTargetSpaceId =
        targetSpaceId ?? (await getVibeEmbeddingTargetSpaceId());
    const eligibleWhere = vibeEmbeddingEligibleTrackWhere();
    const [embedded, missingByStatus] = await Promise.all([
        prisma.track.count({
            where: {
                ...eligibleWhere,
                embeddings: { some: { spaceId: resolvedTargetSpaceId } },
            },
        }),
        prisma.track.groupBy({
            by: ["vibeAnalysisStatus"],
            where: {
                ...eligibleWhere,
                embeddings: { none: { spaceId: resolvedTargetSpaceId } },
            },
            _count: true,
        }),
    ]);
    const failed =
        missingByStatus.find((row) => row.vibeAnalysisStatus === "failed")
            ?._count ?? 0;
    const pending = missingByStatus.reduce(
        (count, row) =>
            row.vibeAnalysisStatus === "failed" ? count : count + row._count,
        0,
    );
    return {
        embedded,
        failed,
        pending,
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
): Promise<VibeEmbeddingCoverage> {
    const coverage = await loadVibeEmbeddingCoverage(targetSpaceId);
    setVibeEmbeddingCoverage(coverage);
    return coverage;
}
