import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { config } from "../config";

interface AnnQueryOptions {
    statementTimeoutMs: number;
    timeoutMessage: string;
}

const STATEMENT_TIMEOUT_SQLSTATE = "57014";

function readNestedCode(candidate: unknown): string | undefined {
    if (typeof candidate !== "object" || candidate === null) return undefined;
    const record = candidate as Record<string, unknown>;
    return typeof record.code === "string" ? record.code : undefined;
}

/**
 * Recognize a PostgreSQL statement-timeout (SQLSTATE 57014) in every envelope
 * Prisma produces: a driver-level error with a direct `code`, the classic
 * P2010 envelope carrying `meta.code`, and the Prisma 7 driver-adapter
 * envelope nesting it at `meta.driverAdapterError.cause.code` (verified
 * against a live pgvector PostgreSQL 16).
 */
function isStatementTimeout(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const record = error as Record<string, unknown>;
    if (readNestedCode(record) === STATEMENT_TIMEOUT_SQLSTATE) return true;
    const meta = record.meta;
    if (typeof meta !== "object" || meta === null) return false;
    const metaRecord = meta as Record<string, unknown>;
    if (readNestedCode(metaRecord) === STATEMENT_TIMEOUT_SQLSTATE) return true;
    const adapterError = metaRecord.driverAdapterError;
    if (typeof adapterError !== "object" || adapterError === null) return false;
    const cause = (adapterError as Record<string, unknown>).cause;
    return readNestedCode(cause) === STATEMENT_TIMEOUT_SQLSTATE;
}

/**
 * Run a pgvector ANN query with `ivfflat.probes` applied on the SAME pooled
 * connection as the query (roadmap F14).
 *
 * The `track_embeddings` indexes use size-banded lists capped at 224. Postgres
 * defaults `ivfflat.probes` to 1, so an unconfigured ANN query scans only one
 * inverted list and recall can be silently near-random. This helper wraps the
 * caller's ANN query in an explicit
 * batch `$transaction` alongside a probes-setting statement.
 *
 * Two footguns this shape avoids, both verified on the live DB:
 *   1. A bare `SET LOCAL` (or set_config) issued as a separate Prisma call lands
 *      on a DIFFERENT pooled connection than the query and silently no-ops. The
 *      batch-array `$transaction([...])` runs both statements sequentially on one
 *      connection, and the GUC dies with the transaction — exactly `SET LOCAL`
 *      semantics.
 *   2. Utility statements reject bind parameters, so
 *      `SET LOCAL ivfflat.probes = ${probes}` is a runtime syntax error under
 *      Prisma's parameterization. `set_config(name, value, is_local => true)` is
 *      the parameterizable, transaction-scoped equivalent — `is_local = true`
 *      makes it behave like `SET LOCAL` (applies inside the tx, reverts on
 *      COMMIT). The value is passed as text because set_config's value arg is
 *      text.
 *
 * Callers build their existing ANN query shape with `Prisma.sql\`...\`` (tagged
 * template — interpolations stay bound parameters, never string-built SQL) and
 * route it through here. This helper does not mint new query shapes; it only
 * wraps the ones the blessed similarity/vibe sites already use.
 *
 * @param annQuery A `Prisma.Sql` ANN query ending in `ORDER BY ... <=> ... LIMIT`.
 * @param probes   Lists to scan; defaults to the benchmark-tuned `config.ivfflatProbes`.
 * @returns The rows produced by `annQuery`.
 */
export async function runAnnQuery<T>(
    annQuery: Prisma.Sql,
    probes: number = config.ivfflatProbes,
    options?: AnnQueryOptions,
): Promise<T> {
    // Clamp to ivfflat.probes' valid domain, 1..32768. An out-of-range value
    // does NOT error: Postgres emits only a server-log WARNING (invisible to
    // the app — db.ts never surfaces PG WARNINGs) and silently keeps the prior
    // value, i.e. probes=1 — which would silently resurrect the exact
    // near-random-recall bug this helper exists to fix. Truncate too:
    // set_config rejects non-integer text for an integer GUC. This is the
    // single consumption point, so a misconfigured IVFFLAT_PROBES (0, negative,
    // huge, fractional) degrades to the nearest valid value instead.
    const effectiveProbes = Math.min(32768, Math.max(1, Math.trunc(probes)));
    const statements = [
        prisma.$queryRaw`SELECT set_config('ivfflat.probes', ${String(effectiveProbes)}, true)`,
    ];
    if (options) {
        const timeoutMs = Math.min(
            60_000,
            Math.max(1, Math.trunc(options.statementTimeoutMs)),
        );
        statements.push(
            prisma.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`,
        );
    }
    statements.push(prisma.$queryRaw<T>(annQuery));
    try {
        const results = await prisma.$transaction(statements);
        return results[results.length - 1] as T;
    } catch (error) {
        if (options && isStatementTimeout(error)) {
            throw new Error(options.timeoutMessage, { cause: error });
        }
        throw error;
    }
}
