import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { config } from "../config";

/**
 * Run a pgvector ANN query with `ivfflat.probes` applied on the SAME pooled
 * connection as the query (roadmap F14).
 *
 * The `track_embeddings` index is `ivfflat ... WITH (lists = 224)`. Postgres
 * defaults `ivfflat.probes` to 1, so an unconfigured ANN query scans only 1 of
 * the 224 inverted lists and recall is silently near-random. This helper is the
 * single place that fixes that: it wraps the caller's ANN query in an explicit
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
    const [, rows] = await prisma.$transaction([
        prisma.$queryRaw`SELECT set_config('ivfflat.probes', ${String(effectiveProbes)}, true)`,
        prisma.$queryRaw<T>(annQuery),
    ]);
    return rows;
}
