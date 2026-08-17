import { recordVibeSpaceTransition } from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getActiveSpace, invalidateActiveSpaceCache } from "./embeddingSpaces";
import {
    loadVibeEmbeddingCoverage,
    loadVibeSpaceEmbeddedCount,
} from "./vibeEmbeddingCoverage";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;
const RETIRED_SPACE_SCAN_LIMIT = 10;
const SPACE_ID_PATTERN = /^[A-Za-z0-9_]{1,48}$/;
const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("EmbeddingSpaceLifecycle")
        : logger;

/** Rows deleted in one retirement-cleanup transaction. */
export const RETIREMENT_DELETE_BATCH_SIZE = 500;
/** Fixed per-run bound so a large retired space resumes on the next tick. */
export const MAX_RETIREMENT_DELETE_BATCHES = 20;

interface LifecycleConfig {
    threshold: number;
    retirementGraceDays: number;
    now(): Date;
}

interface LifecycleSpace {
    id: string;
    retiredAt: Date | null;
}

/** Decide whether measured coverage has reached the configured cutover floor. */
export function shouldCutOver(coverage: number, threshold: number): boolean {
    return Number.isFinite(coverage) && coverage >= threshold;
}

/** Decide whether an empty active space permits immediate cutover. */
export function shouldCutOverEmptyActiveSpace(
    activeEmbeddedCount: number,
): boolean {
    // Pending active-space work does not protect query results and may have no
    // deployed teacher worker capable of completing it on a fresh install.
    return activeEmbeddedCount === 0;
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

async function buildPartialAnnIndex(spaceId: string): Promise<void> {
    const validatedId = validatedSpaceId(spaceId);
    const indexName = partialIndexName(validatedId);
    const rows = await prisma.$queryRaw<Array<{ isValid: boolean }>>`
        SELECT index_row.indisvalid AS "isValid"
        FROM pg_catalog.pg_index index_row
        INNER JOIN pg_catalog.pg_class index_class
            ON index_class.oid = index_row.indexrelid
        INNER JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = index_class.relnamespace
        WHERE index_class.relname = ${indexName}
          AND namespace.nspname = current_schema()
        LIMIT 1
    `;
    if (rows[0]?.isValid === true) return;
    if (rows[0]?.isValid === false) await dropPartialAnnIndex(validatedId);
    // PostgreSQL cannot parameterize identifiers or a partial-index predicate,
    // and CREATE INDEX CONCURRENTLY must run outside a transaction. The value
    // is a registry-owned id validated above, never request or operator input.
    await prisma.$executeRawUnsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}" ` +
            `ON track_embeddings USING ivfflat (embedding vector_cosine_ops) ` +
            `WITH (lists = 224) WHERE space_id = '${validatedId}'`,
    );
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
            where: { id: migratingSpaceId, status: "migrating" },
            data: { status: "active", retiredAt: null },
        });
        if (activated.count !== 1) {
            throw new Error("Cutover target is no longer migrating");
        }
    });
}

async function loadCoverage(spaceId: string): Promise<number> {
    const coverage = await loadVibeEmbeddingCoverage(spaceId);
    const actionable = coverage.embedded + coverage.pending;
    return actionable === 0 ? 0 : coverage.embedded / actionable;
}

async function completeCutover(
    migratingSpaceId: string,
    retiredAt: Date,
): Promise<void> {
    await buildPartialAnnIndex(migratingSpaceId);
    await flipActiveSpace(migratingSpaceId, retiredAt);
    invalidateActiveSpaceCache();
    recordVibeSpaceTransition("cutover");
}

async function cutOverEmptyActiveSpace(
    activeSpaceId: string,
    migratingSpaceId: string,
    retiredAt: Date,
): Promise<void> {
    log.info(
        "Embedding-space cutover starting because active space has no embedded vectors",
        { activeSpaceId, migratingSpaceId },
    );
    await completeCutover(migratingSpaceId, retiredAt);
    log.info("Embedding-space cutover completed", {
        spaceId: migratingSpaceId,
        reason: "empty_active_space",
    });
}

async function cutOverIfReady(
    space: LifecycleSpace,
    config: LifecycleConfig,
): Promise<void> {
    const activeSpace = await getActiveSpace();
    const activeEmbeddedCount = await loadVibeSpaceEmbeddedCount(
        activeSpace.id,
    );
    if (shouldCutOverEmptyActiveSpace(activeEmbeddedCount)) {
        await cutOverEmptyActiveSpace(activeSpace.id, space.id, config.now());
        return;
    }
    const coverage = await loadCoverage(space.id);
    log.info("Embedding-space migration coverage sampled", {
        spaceId: space.id,
        coveragePercent: coverage * 100,
        thresholdPercent: config.threshold * 100,
    });
    if (!shouldCutOver(coverage, config.threshold)) return;
    await completeCutover(space.id, config.now());
    log.info("Embedding-space cutover completed", {
        spaceId: space.id,
        coverage,
    });
}

async function spaceStillRetired(space: LifecycleSpace): Promise<boolean> {
    const unchanged = await prisma.embeddingSpace.updateMany({
        where: {
            id: space.id,
            status: "retired",
            retiredAt: space.retiredAt,
        },
        data: { retiredAt: space.retiredAt },
    });
    return unchanged.count === 1;
}

async function deleteRetiredVectors(space: LifecycleSpace): Promise<boolean> {
    for (let batch = 0; batch < MAX_RETIREMENT_DELETE_BATCHES; batch += 1) {
        if (!(await spaceStillRetired(space))) return false;
        const rows = await prisma.trackEmbedding.findMany({
            where: { spaceId: space.id },
            select: { trackId: true, spaceId: true },
            orderBy: { trackId: "asc" },
            take: RETIREMENT_DELETE_BATCH_SIZE,
        });
        if (rows.length === 0) return true;
        await prisma.trackEmbedding.deleteMany({
            where: {
                spaceId: space.id,
                trackId: { in: rows.map((row) => row.trackId) },
            },
        });
        if (rows.length < RETIREMENT_DELETE_BATCH_SIZE) return true;
    }
    return false;
}

async function dropPartialAnnIndex(spaceId: string): Promise<void> {
    const indexName = partialIndexName(spaceId);
    // DROP INDEX CONCURRENTLY also cannot run in a transaction, and its
    // identifier is the validated, registry-derived name built above.
    await prisma.$executeRawUnsafe(
        `DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`,
    );
}

async function cleanRetiredSpace(space: LifecycleSpace): Promise<void> {
    if (!(await deleteRetiredVectors(space))) return;
    await dropPartialAnnIndex(space.id);
    const cleaned = await prisma.embeddingSpace.updateMany({
        where: {
            id: space.id,
            status: "retired",
            retiredAt: space.retiredAt,
        },
        data: { retiredAt: null },
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
        select: { id: true, retiredAt: true },
    });
    for (const space of spaces) {
        if (
            retirementDue(
                space.retiredAt,
                config.retirementGraceDays,
                config.now(),
            )
        ) {
            await cleanRetiredSpace(space);
        }
    }
}

/** Run one idempotent, bounded cutover and retirement lifecycle check. */
export async function runEmbeddingSpaceLifecycleCheck(
    config: LifecycleConfig,
): Promise<void> {
    const migrating = await prisma.embeddingSpace.findFirst({
        where: { status: "migrating" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, retiredAt: true },
    });
    if (migrating) await cutOverIfReady(migrating, config);
    await cleanDueRetiredSpaces(config);
}
