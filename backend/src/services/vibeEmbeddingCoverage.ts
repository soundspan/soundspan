import { metricsRegistry, setVibeEmbeddingCoverage } from "../metrics";
import type { VibeEmbeddingCoverage } from "../metrics/vibeEmbedMetrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getVibeEmbeddingTargetSpaceId } from "./embeddingSpaces";
import { vibeEmbeddingEligibleTrackWhere } from "./vibeEmbeddingEligibility";

interface CoverageRefresherDependencies {
    loadCoverage(): Promise<VibeEmbeddingCoverage>;
    setCoverage(coverage: VibeEmbeddingCoverage): void;
}

const COVERAGE_STATEMENT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_SQLSTATE = "57014";
const COLLECTION_ERRORS_METRIC = "soundspan_metrics_collection_errors_total";
const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("VibeEmbeddingCoverage")
        : logger;

class VibeEmbeddingCoverageTimeoutError extends Error {
    constructor(cause: unknown) {
        super("Vibe embedding coverage sampling timed out", { cause });
        this.name = "VibeEmbeddingCoverageTimeoutError";
    }
}

function nestedErrorCode(candidate: unknown): string | undefined {
    if (typeof candidate !== "object" || candidate === null) return undefined;
    const code = (candidate as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
}

function isStatementTimeout(error: unknown): boolean {
    if (nestedErrorCode(error) === STATEMENT_TIMEOUT_SQLSTATE) return true;
    if (typeof error !== "object" || error === null) return false;
    const meta = (error as Record<string, unknown>).meta;
    if (nestedErrorCode(meta) === STATEMENT_TIMEOUT_SQLSTATE) return true;
    if (typeof meta !== "object" || meta === null) return false;
    const adapter = (meta as Record<string, unknown>).driverAdapterError;
    if (typeof adapter !== "object" || adapter === null) return false;
    return (
        nestedErrorCode((adapter as Record<string, unknown>).cause) ===
        STATEMENT_TIMEOUT_SQLSTATE
    );
}

function recordCoverageCollectionError(): void {
    const counter = metricsRegistry.getSingleMetric(
        COLLECTION_ERRORS_METRIC,
    ) as { inc(labels: Readonly<{ collector: string }>): void } | undefined;
    counter?.inc({ collector: "vibe_embedding_coverage" });
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
    try {
        const [, embedded, missingByStatus] = await prisma.$transaction([
            prisma.$queryRaw`SELECT set_config('statement_timeout', ${String(COVERAGE_STATEMENT_TIMEOUT_MS)}, true)`,
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
                row.vibeAnalysisStatus === "failed"
                    ? count
                    : count + row._count,
            0,
        );
        return { embedded, failed, pending };
    } catch (error) {
        if (!isStatementTimeout(error)) throw error;
        recordCoverageCollectionError();
        log.warn("Vibe embedding coverage sampling timed out", {
            targetSpaceId: resolvedTargetSpaceId,
            timeoutMs: COVERAGE_STATEMENT_TIMEOUT_MS,
        });
        throw new VibeEmbeddingCoverageTimeoutError(error);
    }
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
    previousCoverage: VibeEmbeddingCoverage | null = null,
): Promise<VibeEmbeddingCoverage | null> {
    try {
        const coverage = await loadVibeEmbeddingCoverage(targetSpaceId);
        setVibeEmbeddingCoverage(coverage);
        return coverage;
    } catch (error) {
        if (error instanceof VibeEmbeddingCoverageTimeoutError) {
            return previousCoverage;
        }
        throw error;
    }
}
