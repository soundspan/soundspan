/**
 * F15 benchmark: /tracks/shuffle's large-library sampling strategy.
 *
 * Compares the deleted raw-SQL `ORDER BY RANDOM()` full-table scan against
 * the new indexed `random`-column pivot-sampling query pair, on the same
 * live corpus, then runs a cheap uniformity sanity check on the new query.
 *
 * READ-ONLY: only ever SELECTs. Requires the F15 migration
 * (20260711012100_add_track_random_sample_column) already applied.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/benchmark-shuffle-sampling.ts
 *
 * Uses the repo-wide benchmark mutex at /home/tony/projects/soundspan/.bench-lock
 * (mkdir/rmdir) so it doesn't run concurrently with a sibling worktree's
 * benchmark against the same shared local Postgres instance.
 */

import fs from "fs";
import { execSync } from "child_process";
import { performance } from "perf_hooks";
import { prisma } from "../src/utils/db";

const LOCK_DIR = "/home/tony/projects/soundspan/.bench-lock";
const LOCK_POLL_MS = 5_000;
const LOCK_MAX_WAIT_MS = 20 * 60 * 1000;

const RUNS_PER_QUERY = 20;
const LIMITS = [100, 1000];
const UNIFORMITY_DRAWS = 2000;
const UNIFORMITY_BUCKETS = 20;

type Stats = { p50: number; p95: number; min: number; max: number; mean: number };

function stats(durationsMs: number[]): Stats {
    const sorted = [...durationsMs].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1], mean };
}

function fmt(s: Stats): string {
    return `p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms min=${s.min.toFixed(2)}ms max=${s.max.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms`;
}

async function timeRuns(runs: number, fn: () => Promise<unknown>): Promise<Stats> {
    const durations: number[] = [];
    for (let i = 0; i < runs; i++) {
        const start = performance.now();
        await fn();
        durations.push(performance.now() - start);
    }
    return stats(durations);
}

/** The OLD behavior: exact query deleted from library.ts's shuffle handler. */
async function beforeQuery(limit: number) {
    return prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Track"
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
}

/** The NEW behavior: exact pivot-sample + top-up pair from library.ts. */
async function afterQuery(limit: number) {
    const pivot = Math.random();
    const randomIds = await prisma.track.findMany({
        where: { random: { gte: pivot } },
        orderBy: { random: "asc" },
        take: limit,
        select: { id: true },
    });
    if (randomIds.length < limit) {
        const remaining = limit - randomIds.length;
        const topUpIds = await prisma.track.findMany({
            where: { random: { lt: pivot } },
            orderBy: { random: "asc" },
            take: remaining,
            select: { id: true },
        });
        randomIds.push(...topUpIds);
    }
    return randomIds;
}

/** Single-row draw used only by the uniformity check (needs the random value too). */
async function afterQuerySingleWithValue(): Promise<{ id: string; random: number }> {
    const pivot = Math.random();
    const page = await prisma.track.findMany({
        where: { random: { gte: pivot } },
        orderBy: { random: "asc" },
        take: 1,
        select: { id: true, random: true },
    });
    if (page.length > 0) return page[0];
    const topUp = await prisma.track.findMany({
        where: { random: { lt: pivot } },
        orderBy: { random: "asc" },
        take: 1,
        select: { id: true, random: true },
    });
    return topUp[0];
}

async function acquireLock(): Promise<void> {
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    for (;;) {
        try {
            fs.mkdirSync(LOCK_DIR);
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            if (Date.now() > deadline) {
                throw new Error(`Timed out after 20min waiting for benchmark lock at ${LOCK_DIR}`);
            }
            console.log(`  (benchmark lock held by another process, waiting ${LOCK_POLL_MS}ms...)`);
            await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        }
    }
}

function releaseLock(): void {
    try {
        fs.rmdirSync(LOCK_DIR);
    } catch (err) {
        console.error(`Warning: failed to release benchmark lock at ${LOCK_DIR}:`, err);
    }
}

function gitInfo(): string {
    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: __dirname }).toString().trim();
        const sha = execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim();
        return `${branch}@${sha}`;
    } catch {
        return "unknown (git unavailable)";
    }
}

async function main() {
    const corpusSize = await prisma.track.count();
    console.log("=".repeat(72));
    console.log("F15 benchmark: /tracks/shuffle sampling — before vs after");
    console.log(`Tree: ${gitInfo()}`);
    console.log(`Corpus: ${corpusSize} Track rows`);
    console.log("=".repeat(72));

    console.log("\nAcquiring benchmark mutex...");
    await acquireLock();
    console.log(`Lock acquired: ${LOCK_DIR}`);

    try {
        console.log("\n--- BEFORE: SELECT id FROM \"Track\" ORDER BY RANDOM() LIMIT n ---");
        for (const limit of LIMITS) {
            const s = await timeRuns(RUNS_PER_QUERY, () => beforeQuery(limit));
            console.log(`  LIMIT ${limit}: ${fmt(s)}  (n=${RUNS_PER_QUERY})`);
        }

        console.log("\n--- AFTER: indexed random-pivot query pair (gte pivot + lt-pivot top-up) ---");
        for (const limit of LIMITS) {
            const s = await timeRuns(RUNS_PER_QUERY, () => afterQuery(limit));
            console.log(`  LIMIT ${limit}: ${fmt(s)}  (n=${RUNS_PER_QUERY})`);
        }

        console.log(
            `\n--- Uniformity sanity check: ${UNIFORMITY_DRAWS} single-row draws, bucketed into ${UNIFORMITY_BUCKETS} equal-width random-value buckets ---`
        );
        const buckets = new Array(UNIFORMITY_BUCKETS).fill(0);
        const idCounts = new Map<string, number>();
        for (let i = 0; i < UNIFORMITY_DRAWS; i++) {
            const row = await afterQuerySingleWithValue();
            const bucket = Math.min(UNIFORMITY_BUCKETS - 1, Math.floor(row.random * UNIFORMITY_BUCKETS));
            buckets[bucket]++;
            idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
        }
        const expectedPerBucket = UNIFORMITY_DRAWS / UNIFORMITY_BUCKETS;
        const maxBucket = Math.max(...buckets);
        const minBucket = Math.min(...buckets);
        console.log(`  bucket counts: [${buckets.join(", ")}]`);
        console.log(`  expected/bucket: ${expectedPerBucket.toFixed(1)}`);
        console.log(
            `  max-bucket/expected ratio: ${(maxBucket / expectedPerBucket).toFixed(2)}  min-bucket/expected ratio: ${(minBucket / expectedPerBucket).toFixed(2)}`
        );
        const distinctIds = idCounts.size;
        const maxRepeat = Math.max(...idCounts.values());
        console.log(
            `  distinct track ids drawn: ${distinctIds} / ${UNIFORMITY_DRAWS} draws; max single-id repeat count: ${maxRepeat}`
        );
        console.log(
            "  (cheap statistical honesty, not a proof: with a uniform DB-side random() and no bias in the pivot/top-up split, no bucket should dominate; a healthy run stays within roughly ±30% of the expected/bucket value and shows no single track id repeating drastically more than the ~"
            + (UNIFORMITY_DRAWS / corpusSize).toFixed(2)
            + " expected average.)"
        );
    } finally {
        releaseLock();
        console.log(`\nLock released: ${LOCK_DIR}`);
    }
}

main()
    .catch((error) => {
        console.error("Benchmark failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
