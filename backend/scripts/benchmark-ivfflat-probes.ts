/**
 * F14 benchmark: recall@k + latency of pgvector ANN search vs `ivfflat.probes`.
 *
 * The track_embeddings index is `ivfflat ... WITH (lists = 224)`. Postgres
 * defaults probes to 1 (scans 1/224 lists), so "similar tracks" / vibe recall is
 * silently near-random. This script sweeps probes on the REAL local corpus to
 * choose config.ivfflatProbes: smallest probes with recall@10 >= ~0.95.
 *
 * READ-ONLY: SELECT + set_config(is_local) only; no writes, no external HTTP. It
 * exercises the real utils/annQuery.ts helper (which applies probes via a
 * transaction-scoped set_config), so a monotonic recall gain across the sweep is
 * itself proof the helper takes effect on the same pooled connection.
 *
 * Run (from backend/, DATABASE_URL pointing at the local pgvector DB):
 *   DATABASE_URL=... REDIS_URL=... SESSION_SECRET=<32+ chars> MUSIC_PATH=/music \
 *     npx tsx scripts/benchmark-ivfflat-probes.ts
 *
 * A cross-worktree mutex (mkdir /home/tony/projects/soundspan/.bench-lock) keeps
 * concurrent benchmarks from contaminating each other's latency numbers.
 */
import fs from "fs";
import { execSync } from "child_process";
import { performance } from "perf_hooks";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/utils/db";
import { runAnnQuery } from "../src/utils/annQuery";

const PROBES = [1, 2, 4, 8, 10, 16, 24, 32, 48, 64, 112, 224];
const GROUND_TRUTH_PROBES = 224; // = lists: scans every inverted list (exhaustive)
const SAMPLE_SIZE = 100;
const K = 50; // fetch top-50 per query -> serves both recall@10 and recall@50
const RECALL_TARGET = 0.95;
const LOCK_DIR = "/home/tony/projects/soundspan/.bench-lock";
const LOCK_POLL_MS = 15_000;
const LOCK_TIMEOUT_MS = 20 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function quantile(sorted: number[], q: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

function overlap(a: string[], b: string[]): number {
    const setB = new Set(b);
    let n = 0;
    for (const x of a) if (setB.has(x)) n++;
    return n;
}

function round(n: number, d = 4): number {
    const f = 10 ** d;
    return Math.round(n * f) / f;
}

/** The blessed CLAP-only ANN shape, projected to just the neighbor id. */
function annSql(trackId: string, k: number): Prisma.Sql {
    return Prisma.sql`
        WITH source AS (
            SELECT embedding FROM track_embeddings WHERE track_id = ${trackId}
        )
        SELECT te.track_id
        FROM track_embeddings te
        WHERE te.track_id != ${trackId}
        ORDER BY te.embedding <=> (SELECT embedding FROM source)
        LIMIT ${k}
    `;
}

async function acquireLock(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            fs.mkdirSync(LOCK_DIR);
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            if (Date.now() > deadline) {
                throw new Error(`bench lock ${LOCK_DIR} held > 20 min; aborting`);
            }
            console.log(`[lock] ${LOCK_DIR} held by another benchmark; polling...`);
            await sleep(LOCK_POLL_MS);
        }
    }
}

function treeLabel(): string {
    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
        const sha = execSync("git rev-parse --short HEAD").toString().trim();
        return `${branch}@${sha}`;
    } catch {
        return "unknown-tree";
    }
}

async function main(): Promise<void> {
    const tree = treeLabel();

    const [{ tracks }] = await prisma.$queryRaw<{ tracks: bigint }[]>`
        SELECT count(*)::bigint AS tracks FROM "Track"
    `;
    const [{ embeddings }] = await prisma.$queryRaw<{ embeddings: bigint }[]>`
        SELECT count(*)::bigint AS embeddings FROM track_embeddings
    `;

    // Deterministic pseudo-random sample of tracks that have embeddings.
    const sample = await prisma.$queryRaw<{ track_id: string }[]>`
        SELECT track_id FROM track_embeddings
        ORDER BY md5(track_id || 'f14') LIMIT ${SAMPLE_SIZE}
    `;

    // --- Mechanism proof (gate 5): the real helper applies probes inside its tx
    // and it reverts to the pg default outside. No recall math needed to see it.
    const inTx = await runAnnQuery<{ probes: string }[]>(
        Prisma.sql`SELECT current_setting('ivfflat.probes') AS probes`,
        7,
    );
    const outTx = await prisma.$queryRaw<{ probes: string }[]>`
        SELECT current_setting('ivfflat.probes') AS probes
    `;
    console.log(
        `[mechanism] ivfflat.probes inside runAnnQuery(tx, 7) = ${inTx[0]?.probes} (expect 7); ` +
        `outside tx = ${outTx[0]?.probes} (expect 1 = pg default) -> set_config is_local scoping confirmed`,
    );

    // Warm up (connection + plan cache) so the first timed query isn't an outlier.
    await runAnnQuery<{ track_id: string }[]>(annSql(sample[0].track_id, K), 1);

    const latency = new Map<number, number[]>(PROBES.map((p) => [p, []]));
    const recall10 = new Map<number, number[]>(PROBES.map((p) => [p, []]));
    const recall50 = new Map<number, number[]>(PROBES.map((p) => [p, []]));

    for (const { track_id } of sample) {
        const neighbors = new Map<number, string[]>();
        for (const p of PROBES) {
            const t0 = performance.now();
            const rows = await runAnnQuery<{ track_id: string }[]>(annSql(track_id, K), p);
            latency.get(p)!.push(performance.now() - t0);
            neighbors.set(p, rows.map((r) => r.track_id));
        }

        const gt = neighbors.get(GROUND_TRUTH_PROBES)!;
        const gt10 = gt.slice(0, 10);
        const gt50 = gt.slice(0, 50);
        for (const p of PROBES) {
            const got = neighbors.get(p)!;
            recall10.get(p)!.push(overlap(got.slice(0, 10), gt10) / Math.max(1, gt10.length));
            recall50.get(p)!.push(overlap(got.slice(0, 50), gt50) / Math.max(1, gt50.length));
        }
    }

    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    type Row = { probes: number; r10: number; r50: number; p50: number; p95: number };
    const rows: Row[] = PROBES.map((p) => {
        const lat = [...latency.get(p)!].sort((a, b) => a - b);
        return {
            probes: p,
            r10: round(mean(recall10.get(p)!)),
            r50: round(mean(recall50.get(p)!)),
            p50: round(quantile(lat, 0.5), 2),
            p95: round(quantile(lat, 0.95), 2),
        };
    });

    // Smallest probes clearing the recall@10 target.
    const chosen = rows.find((r) => r.r10 >= RECALL_TARGET) ?? rows[rows.length - 1];

    const lines: string[] = [];
    lines.push("## F14 ivfflat.probes benchmark");
    lines.push("");
    lines.push(`- Tree: \`${tree}\``);
    lines.push(`- Corpus: ${tracks} Tracks, ${embeddings} track_embeddings; index \`ivfflat lists=224\``);
    lines.push(`- Sample: ${sample.length} random tracks; ground truth = top-${K} at probes=${GROUND_TRUTH_PROBES} (exhaustive); latency = per-query wall time through runAnnQuery (tx + set_config included)`);
    lines.push("");
    lines.push("| probes | recall@10 | recall@50 | p50 ms | p95 ms |");
    lines.push("|-------:|----------:|----------:|-------:|-------:|");
    for (const r of rows) {
        const mark = r.probes === chosen.probes ? " **<- chosen default**" : r.probes === 1 ? " (before: pg default)" : "";
        lines.push(`| ${r.probes} | ${r.r10.toFixed(4)} | ${r.r50.toFixed(4)} | ${r.p50} | ${r.p95} |${mark}`);
    }
    lines.push("");
    lines.push(`Chosen default: **IVFFLAT_PROBES=${chosen.probes}** — smallest probes with recall@10 >= ${RECALL_TARGET} (recall@10=${chosen.r10.toFixed(4)}, p95=${chosen.p95}ms).`);

    console.log("\n" + lines.join("\n") + "\n");
}

(async () => {
    await acquireLock();
    try {
        await main();
    } finally {
        try {
            fs.rmdirSync(LOCK_DIR);
        } catch {
            /* best-effort release */
        }
        await prisma.$disconnect();
    }
})().catch((err) => {
    console.error("benchmark failed:", err);
    process.exitCode = 1;
});
