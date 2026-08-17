import {
    recordVibeSpaceTransition,
    setVibeMigrationActive,
    setVibeEmbeddingCoverage,
} from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getActiveSpace, invalidateActiveSpaceCache } from "./embeddingSpaces";
import {
    loadVibeEmbeddingCoverage,
    loadVibeSpaceVectorState,
} from "./vibeEmbeddingCoverage";
import type { VibeEmbeddingCoverage } from "../metrics/vibeEmbedMetrics";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;
const RETIRED_SPACE_SCAN_LIMIT = 10;
const CLEANING_CLAIM_STALE_MS = 60 * 60 * 1_000;
const SPACE_ID_PATTERN = /^[A-Za-z0-9_]{1,48}$/;
const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("EmbeddingSpaceLifecycle")
        : logger;

/** Rows deleted in one retirement-cleanup transaction. */
export const RETIREMENT_DELETE_BATCH_SIZE = 500;
/** Fixed per-run bound so a large retired space resumes on the next tick. */
export const MAX_RETIREMENT_DELETE_BATCHES = 20;
/**
 * Conservative training floor for the first size-banded IVFFlat shape.
 * Spaces below this size remain exact scans.
 */
export const ANN_INDEX_MIN_VECTOR_COUNT = 1_000;

/** Select the stable IVFFlat list band for a space's current vector count. */
export function annIndexListsForVectorCount(
    vectorCount: number,
): number | null {
    if (!Number.isSafeInteger(vectorCount) || vectorCount < 0) return null;
    if (vectorCount < ANN_INDEX_MIN_VECTOR_COUNT) return null;
    // pgvector's README recommends rows/1000 below one million rows as a
    // starting point, then measuring recall against exact search. Soundspan's
    // existing 15k-row benchmark selected 224 lists with 32 probes, so these
    // stepped rows/25 bands avoid per-insert rebuilds while converging on that
    // measured shape; the PostgreSQL integration suite pins exact top-k at the
    // first band edge.
    if (vectorCount < 2_500) return 40;
    if (vectorCount < 5_000) return 100;
    if (vectorCount < 10_000) return 200;
    return 224;
}

interface LifecycleConfig {
    threshold: number;
    retirementGraceDays: number;
    allowFailed: boolean;
    currentProviderSpaceId: string;
    now(): Date;
}

interface LifecycleSpace {
    id: string;
    retiredAt: Date | null;
    cleaningAt: Date | null;
}

/** Decide whether measured coverage has reached the configured cutover floor. */
export function shouldCutOver(coverage: number, threshold: number): boolean {
    return Number.isFinite(coverage) && coverage >= threshold;
}

/** Decide whether an empty active space permits immediate cutover. */
export function shouldCutOverEmptyActiveSpace(
    activeHasVectors: boolean,
    activeHadVectors: boolean,
): boolean {
    // Pending active-space work does not protect query results and may have no
    // deployed teacher worker capable of completing it on a fresh install.
    return !activeHasVectors && !activeHadVectors;
}

/** Decide whether a space is large enough to train its partial ANN index. */
export function shouldBuildAnnIndex(vectorCount: number): boolean {
    return (
        Number.isInteger(vectorCount) &&
        vectorCount >= ANN_INDEX_MIN_VECTOR_COUNT
    );
}

/** Decide whether a retired space has reached its cleanup boundary. */
export function retirementDue(
    retiredAt: Date | null,
    graceDays: number,
    now: Date,
): boolean {
    if (!retiredAt) return false;
    return now.getTime() - retiredAt.getTime() >= graceDays * MILLIS_PER_DAY;
}

function validatedSpaceId(spaceId: string): string {
    if (!SPACE_ID_PATTERN.test(spaceId)) {
        throw new Error("Registry returned an unsafe embedding-space id");
    }
    return spaceId;
}

function partialIndexName(spaceId: string): string {
    return `track_embeddings_${validatedSpaceId(spaceId)}_ivfflat_idx`;
}

interface AnnIndexState {
    isValid: boolean;
    lists: number | null;
}

function parseIndexLists(options: readonly string[] | null): number | null {
    const value = options?.find((option) => option.startsWith("lists="));
    if (!value) return null;
    const lists = Number.parseInt(value.slice("lists=".length), 10);
    return Number.isSafeInteger(lists) && lists > 0 ? lists : null;
}

async function loadPartialAnnIndex(
    spaceId: string,
): Promise<AnnIndexState | null> {
    const validatedId = validatedSpaceId(spaceId);
    const indexName = partialIndexName(validatedId);
    const rows = await prisma.$queryRaw<
        Array<{ isValid: boolean; options: string[] | null }>
    >`
        SELECT index_row.indisvalid AS "isValid",
               index_class.reloptions AS options
        FROM pg_catalog.pg_index index_row
        INNER JOIN pg_catalog.pg_class index_class
            ON index_class.oid = index_row.indexrelid
        INNER JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = index_class.relnamespace
        WHERE index_class.relname = ${indexName}
          AND namespace.nspname = current_schema()
        LIMIT 1
    `;
    const row = rows[0];
    return row
        ? { isValid: row.isValid, lists: parseIndexLists(row.options) }
        : null;
}

async function createPartialAnnIndex(
    spaceId: string,
    lists: number,
): Promise<void> {
    const validatedId = validatedSpaceId(spaceId);
    const indexName = partialIndexName(validatedId);
    // PostgreSQL cannot parameterize identifiers or a partial-index predicate,
    // and CREATE INDEX CONCURRENTLY must run outside a transaction. The value
    // is a registry-owned id validated above, never request or operator input.
    await prisma.$executeRawUnsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}" ` +
            `ON track_embeddings USING ivfflat (embedding vector_cosine_ops) ` +
            `WITH (lists = ${lists}) WHERE space_id = '${validatedId}'`,
    );
}

/** Build a valid partial ANN index once a space reaches its training floor. */
export async function ensureSpaceAnnIndex(spaceId: string): Promise<boolean> {
    const vectorCount = await prisma.trackEmbedding.count({
        where: { spaceId },
    });
    const desiredLists = annIndexListsForVectorCount(vectorCount);
    const current = await loadPartialAnnIndex(spaceId);
    if (desiredLists === null) {
        if (current) await dropPartialAnnIndex(spaceId);
        return false;
    }
    if (current?.isValid && current.lists === desiredLists) return true;
    if (current) await dropPartialAnnIndex(spaceId);
    await createPartialAnnIndex(spaceId, desiredLists);
    return true;
}

async function flipActiveSpace(
    migratingSpaceId: string,
    retiredAt: Date,
): Promise<void> {
    await prisma.$transaction(async (transaction) => {
        const retired = await transaction.embeddingSpace.updateMany({
            where: { status: "active" },
            data: { status: "retired", retiredAt },
        });
        if (retired.count !== 1) {
            throw new Error("Cutover requires exactly one active space");
        }
        const activated = await transaction.embeddingSpace.updateMany({
            where: {
                id: migratingSpaceId,
                status: "migrating",
                cleaningAt: null,
            },
            data: { status: "active", retiredAt: null, cleaningAt: null },
        });
        if (activated.count !== 1) {
            throw new Error("Cutover target is no longer migrating");
        }
    });
}

interface CoverageSample extends VibeEmbeddingCoverage {
    ratio: number;
}

async function sampleCoverage(
    spaceId: string,
    threshold: number,
): Promise<CoverageSample> {
    const coverage = await loadVibeEmbeddingCoverage(spaceId);
    if (
        ![coverage.embedded, coverage.pending, coverage.failed].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
        )
    ) {
        throw new Error("Embedding-space coverage returned invalid counts");
    }
    const actionable = coverage.embedded + coverage.pending;
    const ratio = actionable === 0 ? 0 : coverage.embedded / actionable;
    setVibeEmbeddingCoverage(coverage);
    log.info("Embedding-space migration coverage sampled", {
        spaceId,
        coveragePercent: ratio * 100,
        thresholdPercent: threshold * 100,
        embedded: coverage.embedded,
        pending: coverage.pending,
        failed: coverage.failed,
    });
    return { ...coverage, ratio };
}

function failureTailAllowsCutover(
    coverage: VibeEmbeddingCoverage,
    config: LifecycleConfig,
): boolean {
    if (coverage.failed === 0 || config.allowFailed) return true;
    const total = coverage.embedded + coverage.pending + coverage.failed;
    if (total <= 0) return false;
    const failureFraction = coverage.failed / total;
    if (failureFraction <= 1 - config.threshold) return true;
    log.warn("Embedding-space cutover held for unacknowledged failures", {
        spaceId: config.currentProviderSpaceId,
        failed: coverage.failed,
        failureFraction,
        toleratedFailureFraction: 1 - config.threshold,
        retryEndpoint: "/api/analysis/vibe/retry",
    });
    return false;
}

async function completeCutover(
    migratingSpaceId: string,
    retiredAt: Date,
): Promise<void> {
    await ensureSpaceAnnIndex(migratingSpaceId);
    await flipActiveSpace(migratingSpaceId, retiredAt);
    invalidateActiveSpaceCache();
    recordVibeSpaceTransition("cutover");
    setVibeMigrationActive(false);
}

async function cutOverEmptyActiveSpace(
    activeSpaceId: string,
    migratingSpaceId: string,
    retiredAt: Date,
    failed: number,
): Promise<void> {
    log.info(
        "Embedding-space cutover starting because active space has no embedded vectors",
        { activeSpaceId, migratingSpaceId },
    );
    await completeCutover(migratingSpaceId, retiredAt);
    log.info("Embedding-space cutover completed", {
        spaceId: migratingSpaceId,
        reason: "empty_active_space",
        failed,
    });
}

async function cutOverIfReady(
    space: LifecycleSpace,
    activeSpace: Awaited<ReturnType<typeof getActiveSpace>>,
    config: LifecycleConfig,
): Promise<boolean> {
    const activeVectorState = await loadVibeSpaceVectorState(activeSpace.id);
    const coverage = await sampleCoverage(space.id, config.threshold);
    if (!failureTailAllowsCutover(coverage, config)) return false;
    if (
        shouldCutOverEmptyActiveSpace(
            activeVectorState.hasVectors,
            activeVectorState.hadVectors,
        )
    ) {
        await cutOverEmptyActiveSpace(
            activeSpace.id,
            space.id,
            config.now(),
            coverage.failed,
        );
        return true;
    }
    if (!shouldCutOver(coverage.ratio, config.threshold)) return false;
    await completeCutover(space.id, config.now());
    log.info("Embedding-space cutover completed", {
        spaceId: space.id,
        coverage: coverage.ratio,
        failed: coverage.failed,
    });
    return true;
}

async function claimRetiredSpace(
    space: LifecycleSpace,
    claimedAt: Date,
): Promise<Date | null> {
    if (space.cleaningAt) {
        const claimAgeMs = claimedAt.getTime() - space.cleaningAt.getTime();
        if (claimAgeMs < CLEANING_CLAIM_STALE_MS) return null;
        const reclaimed = await prisma.embeddingSpace.updateMany({
            where: {
                id: space.id,
                status: "retired",
                retiredAt: space.retiredAt,
                cleaningAt: space.cleaningAt,
            },
            data: { cleaningAt: claimedAt },
        });
        return reclaimed.count === 1 ? claimedAt : null;
    }
    const claimed = await prisma.embeddingSpace.updateMany({
        where: {
            id: space.id,
            status: "retired",
            retiredAt: space.retiredAt,
            cleaningAt: null,
        },
        data: { cleaningAt: claimedAt },
    });
    return claimed.count === 1 ? claimedAt : null;
}

type DeleteBatchResult = "complete" | "more" | "claim_lost";

async function deleteClaimedVectorBatch(
    space: LifecycleSpace,
    cleaningAt: Date,
): Promise<DeleteBatchResult> {
    return prisma.$transaction(async (transaction) => {
        const validated = await transaction.embeddingSpace.updateMany({
            where: {
                id: space.id,
                status: "retired",
                retiredAt: space.retiredAt,
                cleaningAt,
            },
            data: { cleaningAt },
        });
        if (validated.count !== 1) return "claim_lost";
        const rows = await transaction.trackEmbedding.findMany({
            where: { spaceId: space.id },
            select: { trackId: true, spaceId: true },
            orderBy: { trackId: "asc" },
            take: RETIREMENT_DELETE_BATCH_SIZE,
        });
        if (rows.length === 0) return "complete";
        await transaction.trackEmbedding.deleteMany({
            where: {
                spaceId: space.id,
                trackId: { in: rows.map((row) => row.trackId) },
            },
        });
        return rows.length < RETIREMENT_DELETE_BATCH_SIZE ? "complete" : "more";
    });
}

async function deleteRetiredVectors(
    space: LifecycleSpace,
    cleaningAt: Date,
): Promise<"complete" | "bounded" | "claim_lost"> {
    for (let batch = 0; batch < MAX_RETIREMENT_DELETE_BATCHES; batch += 1) {
        const result = await deleteClaimedVectorBatch(space, cleaningAt);
        if (result === "claim_lost") return "claim_lost";
        if (result === "complete") return "complete";
    }
    return "bounded";
}

async function releaseBoundedCleaningClaim(
    space: LifecycleSpace,
    cleaningAt: Date,
): Promise<void> {
    await prisma.embeddingSpace.updateMany({
        where: {
            id: space.id,
            status: "retired",
            retiredAt: space.retiredAt,
            cleaningAt,
        },
        data: { cleaningAt: null },
    });
}

async function dropPartialAnnIndex(spaceId: string): Promise<void> {
    const indexName = partialIndexName(spaceId);
    // DROP INDEX CONCURRENTLY also cannot run in a transaction, and its
    // identifier is the validated, registry-derived name built above.
    await prisma.$executeRawUnsafe(
        `DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`,
    );
}

async function cleanRetiredSpace(
    space: LifecycleSpace,
    claimedAt: Date,
): Promise<void> {
    const cleaningAt = await claimRetiredSpace(space, claimedAt);
    if (!cleaningAt) return;
    const deletion = await deleteRetiredVectors(space, cleaningAt);
    if (deletion === "claim_lost") return;
    if (deletion === "bounded") {
        await releaseBoundedCleaningClaim(space, cleaningAt);
        return;
    }
    const claimValid = await prisma.embeddingSpace.updateMany({
        where: {
            id: space.id,
            status: "retired",
            retiredAt: space.retiredAt,
            cleaningAt,
        },
        data: { cleaningAt },
    });
    if (claimValid.count !== 1) return;
    await dropPartialAnnIndex(space.id);
    const cleaned = await prisma.embeddingSpace.updateMany({
        where: {
            id: space.id,
            status: "retired",
            retiredAt: space.retiredAt,
            cleaningAt,
        },
        data: { retiredAt: null, cleaningAt: null },
    });
    if (cleaned.count !== 1) return;
    recordVibeSpaceTransition("retired_cleaned");
    log.info("Retired embedding-space vectors cleaned", {
        spaceId: space.id,
    });
}

async function cleanDueRetiredSpaces(config: LifecycleConfig): Promise<void> {
    const spaces = await prisma.embeddingSpace.findMany({
        where: { status: "retired", retiredAt: { not: null } },
        orderBy: [{ retiredAt: "asc" }, { id: "asc" }],
        take: RETIRED_SPACE_SCAN_LIMIT,
        select: { id: true, retiredAt: true, cleaningAt: true },
    });
    for (const space of spaces) {
        if (
            retirementDue(
                space.retiredAt,
                config.retirementGraceDays,
                config.now(),
            )
        ) {
            await cleanRetiredSpace(space, config.now());
        }
    }
}

async function refreshCurrentProviderMigration(
    config: LifecycleConfig,
): Promise<void> {
    await prisma.embeddingSpace.updateMany({
        where: {
            id: config.currentProviderSpaceId,
            status: "migrating",
            cleaningAt: null,
        },
        data: { lastSeenAt: config.now() },
    });
}

async function retireAbandonedMigrations(
    config: LifecycleConfig,
): Promise<void> {
    const cutoff = new Date(
        config.now().getTime() - config.retirementGraceDays * MILLIS_PER_DAY,
    );
    const retired = await prisma.embeddingSpace.updateMany({
        where: {
            status: "migrating",
            id: { not: config.currentProviderSpaceId },
            lastSeenAt: { lte: cutoff },
            cleaningAt: null,
        },
        data: { status: "retired", retiredAt: config.now() },
    });
    if (retired.count > 0) {
        log.warn("Abandoned embedding-space migrations retired", {
            count: retired.count,
            lastSeenCutoff: cutoff,
        });
    }
}

/** Run one idempotent, bounded cutover and retirement lifecycle check. */
export async function runEmbeddingSpaceLifecycleCheck(
    config: LifecycleConfig,
): Promise<void> {
    if (
        !Number.isFinite(config.threshold) ||
        config.threshold < 0.5 ||
        config.threshold > 1
    ) {
        throw new Error("Embedding-space cutover threshold is invalid");
    }
    if (
        !Number.isSafeInteger(config.retirementGraceDays) ||
        config.retirementGraceDays < 1
    ) {
        throw new Error("Embedding-space retirement grace is invalid");
    }
    validatedSpaceId(config.currentProviderSpaceId);
    await refreshCurrentProviderMigration(config);
    await retireAbandonedMigrations(config);
    const [migrating, activeSpace] = await Promise.all([
        prisma.embeddingSpace.findFirst({
            where: {
                id: config.currentProviderSpaceId,
                status: "migrating",
                cleaningAt: null,
            },
            select: { id: true, retiredAt: true, cleaningAt: true },
        }),
        getActiveSpace(),
    ]);
    const cutOver = migrating
        ? await cutOverIfReady(migrating, activeSpace, config)
        : false;
    if (!cutOver) await ensureSpaceAnnIndex(activeSpace.id);
    await cleanDueRetiredSpaces(config);
}
