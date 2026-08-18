import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { Client } from "pg";
import {
    ANN_INDEX_MIN_VECTOR_COUNT,
    ensureSpaceAnnIndex,
    runEmbeddingSpaceLifecycleCheck,
} from "../src/services/embeddingSpaceLifecycle";
import { invalidateActiveSpaceCache } from "../src/services/embeddingSpaces";
import {
    EmbeddingTargetInvalidatedError,
    upsertTrackEmbedding,
    VibeEmbeddingGenerationMismatchError,
} from "../src/services/trackEmbeddings";
import { runAnnQuery } from "../src/utils/annQuery";
import { prisma } from "../src/utils/db";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const TEACHER_SPACE_ID = "space_clap_music_audioset_v1";
const VECTOR = `[1,${Array(511).fill(0).join(",")}]`;
const MIGRATIONS = [
    "20260816120000_add_embedding_space_registry",
    "20260816130000_add_embedding_space_migration",
    "20260817120000_add_embedding_space_had_vectors",
    "20260817130000_drop_legacy_global_embedding_index",
    "20260817140000_harden_vibe_concurrency",
] as const;

interface IndexRow {
    name: string;
    isValid: boolean;
    options: string[] | null;
    predicate: string | null;
}

function baseDatabaseUrl(databaseUrl: string): string {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete("schema");
    return parsed.toString();
}

function migrationSql(name: (typeof MIGRATIONS)[number]): string {
    return readFileSync(
        join(__dirname, "../prisma/migrations", name, "migration.sql"),
        "utf8",
    );
}

async function loadEmbeddingIndexes(client: Client): Promise<IndexRow[]> {
    const result = await client.query<IndexRow>(`
        SELECT index_class.relname AS name,
               index_row.indisvalid AS "isValid",
               index_class.reloptions AS options,
               pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
        FROM pg_catalog.pg_index index_row
        JOIN pg_catalog.pg_class table_class
          ON table_class.oid = index_row.indrelid
        JOIN pg_catalog.pg_class index_class
          ON index_class.oid = index_row.indexrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = current_schema()
          AND table_class.relname = 'track_embeddings'
        ORDER BY index_class.relname
    `);
    return result.rows;
}

async function seedVersion22Schema(client: Client): Promise<void> {
    await client.query(`
        CREATE TYPE "TrackOrigin" AS ENUM ('LOCAL', 'FEDERATED');
        CREATE TABLE "Track" (
            "id" TEXT PRIMARY KEY,
            "origin" "TrackOrigin" NOT NULL DEFAULT 'LOCAL',
            "removedAt" TIMESTAMP(3),
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "vibeAnalysisStatus" TEXT,
            "vibeAnalysisStartedAt" TIMESTAMP(3),
            "vibeAnalysisError" TEXT,
            "vibeAnalysisRetryCount" INTEGER NOT NULL DEFAULT 0,
            "vibeAnalysisStatusUpdatedAt" TIMESTAMP(3)
        );
        CREATE TABLE "track_embeddings" (
            "track_id" TEXT PRIMARY KEY REFERENCES "Track"("id") ON DELETE CASCADE,
            "embedding" vector(512) NOT NULL,
            "model_version" VARCHAR(50) NOT NULL DEFAULT 'laion-clap-music',
            "analyzed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX "track_embeddings_model_version_idx"
            ON "track_embeddings"("model_version");
        CREATE INDEX "track_embeddings_embedding_idx"
            ON "track_embeddings" USING ivfflat
            ("embedding" vector_cosine_ops) WITH (lists = 224);
        INSERT INTO "Track" ("id") VALUES ('seed-track');
        INSERT INTO "track_embeddings" ("track_id", "embedding")
            VALUES ('seed-track', '${VECTOR}'::vector);
    `);
}

async function insertComparisonCorpus(
    client: Client,
    spaceId: string,
): Promise<void> {
    await client.query(
        `INSERT INTO embedding_spaces (
            id, family, checkpoint_hash, dim, preprocessing, status
         ) VALUES ($1, 'comparison', 'comparison-hash', 512, '{}'::jsonb, 'migrating')`,
        [spaceId],
    );
    await client.query(
        `INSERT INTO "Track" ("id")
         SELECT 'comparison-track-' || value
         FROM generate_series(1, $1::int) AS value`,
        [ANN_INDEX_MIN_VECTOR_COUNT],
    );
    await client.query(
        `INSERT INTO track_embeddings (track_id, space_id, embedding)
         SELECT 'comparison-track-' || value,
                $1,
                ('[' || (1 - value::double precision / 2000)::text || ',' ||
                 (value::double precision / 2000)::text || ',' ||
                 array_to_string(array_fill(0::integer, ARRAY[510]), ',') || ']')::vector
         FROM generate_series(1, $2::int) AS value`,
        [spaceId, ANN_INDEX_MIN_VECTOR_COUNT],
    );
}

async function queryNearestIds(
    client: Client,
    spaceId: string,
    exact: boolean,
): Promise<string[]> {
    await client.query("BEGIN");
    try {
        if (exact) {
            await client.query("SET LOCAL enable_indexscan = off");
        } else {
            // Route through the ivfflat scan (see loadAnnPlan): with seq,
            // bitmap, and sort disabled, the ordered ivfflat scan is the only
            // viable plan, so this result set genuinely exercises the index.
            await client.query("SET LOCAL enable_seqscan = off");
            await client.query("SET LOCAL enable_bitmapscan = off");
            await client.query("SET LOCAL enable_sort = off");
            await client.query("SET LOCAL ivfflat.probes = 32");
        }
        const result = await client.query<{ trackId: string }>(
            `SELECT track_id AS "trackId"
             FROM track_embeddings
             WHERE space_id = $1
             ORDER BY embedding <=> $2::vector, track_id
             LIMIT 10`,
            [spaceId, VECTOR],
        );
        return result.rows.map((row) => row.trackId);
    } finally {
        await client.query("ROLLBACK");
    }
}

async function loadAnnPlan(client: Client, spaceId: string): Promise<string> {
    await client.query("BEGIN");
    try {
        await client.query("SET LOCAL enable_seqscan = off");
        await client.query("SET LOCAL enable_bitmapscan = off");
        // The btree space_id index plus an explicit Sort can legitimately
        // out-cost the ivfflat scan on small corpora; disabling Sort leaves
        // the ordered ivfflat scan as the only viable plan, making both this
        // probe and the ANN result set deterministic.
        await client.query("SET LOCAL enable_sort = off");
        await client.query("SET LOCAL ivfflat.probes = 32");
        const result = await client.query<Record<string, string>>(
            `EXPLAIN (COSTS OFF)
             SELECT track_id
             FROM track_embeddings
             WHERE space_id = $1
             ORDER BY embedding <=> $2::vector
             LIMIT 10`,
            [spaceId, VECTOR],
        );
        return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
        await client.query("ROLLBACK");
    }
}

async function applyMigrations(client: Client): Promise<void> {
    for (const migration of MIGRATIONS) {
        await client.query(migrationSql(migration));
    }
}

async function insertVectors(
    client: Client,
    spaceId: string,
    prefix: string,
    first: number,
    last: number,
): Promise<void> {
    await client.query(
        `INSERT INTO "Track" ("id")
         SELECT $1 || value FROM generate_series($2::int, $3::int) AS value`,
        [prefix, first, last],
    );
    await client.query(
        `INSERT INTO "track_embeddings" ("track_id", "space_id", "embedding")
         SELECT $1 || value, $4, $5::vector
         FROM generate_series($2::int, $3::int) AS value`,
        [prefix, first, last, spaceId, VECTOR],
    );
}

describeWithPostgres("vibe search PostgreSQL correctness", () => {
    let admin: Client;
    let database: Client;
    let indexesBefore: IndexRow[];

    beforeAll(async () => {
        if (!/^vibe_x2_\d+_\d+$/.test(databaseName!)) {
            throw new Error("Integration database name is unsafe");
        }
        admin = new Client({
            connectionString: baseDatabaseUrl(integrationDatabaseUrl!),
        });
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        database = new Client({
            connectionString: process.env.DATABASE_URL,
        });
        await database.connect();
        await database.query("CREATE EXTENSION IF NOT EXISTS vector");
        await seedVersion22Schema(database);
        indexesBefore = await loadEmbeddingIndexes(database);
        await applyMigrations(database);
    });

    afterAll(async () => {
        await prisma.$disconnect();
        await database?.end();
        if (admin && databaseName) {
            await admin.query(
                `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
            );
            await admin.end();
        }
    });

    it("applies registry, composite-key, history, and global-index cleanup migrations", async () => {
        expect(indexesBefore.map((index) => index.name)).toContain(
            "track_embeddings_embedding_idx",
        );
        const indexesAfter = await loadEmbeddingIndexes(database);
        expect(indexesAfter.map((index) => index.name)).not.toContain(
            "track_embeddings_embedding_idx",
        );
        expect(indexesAfter.map((index) => index.name)).toEqual(
            expect.arrayContaining([
                "track_embeddings_pkey",
                "track_embeddings_space_id_idx",
            ]),
        );
        const key = await database.query<{ columns: string[] }>(`
            SELECT array_agg(attribute.attname ORDER BY key_column.ordinality) AS columns
            FROM pg_catalog.pg_constraint constraint_row
            JOIN LATERAL unnest(constraint_row.conkey)
              WITH ORDINALITY AS key_column(attnum, ordinality) ON true
            JOIN pg_catalog.pg_attribute attribute
              ON attribute.attrelid = constraint_row.conrelid
             AND attribute.attnum = key_column.attnum
            WHERE constraint_row.conrelid = 'track_embeddings'::regclass
              AND constraint_row.contype = 'p'
        `);
        expect(String(key.rows[0]?.columns)).toBe("{track_id,space_id}");
        const spaces = await database.query<{ hadVectors: boolean }>(`
            SELECT had_vectors AS "hadVectors"
            FROM embedding_spaces WHERE id = '${TEACHER_SPACE_ID}'
        `);
        expect(spaces.rows).toEqual([{ hadVectors: true }]);
    });

    it("keeps empty and small spaces exact, then builds a valid partial index at the floor", async () => {
        await database.query(`
            INSERT INTO embedding_spaces (
                id, family, checkpoint_hash, dim, preprocessing, status
            ) VALUES (
                'space_empty', 'empty', 'empty-hash', 512, '{}'::jsonb, 'retired'
            )
        `);
        await expect(ensureSpaceAnnIndex("space_empty")).resolves.toBe(false);
        await expect(ensureSpaceAnnIndex(TEACHER_SPACE_ID)).resolves.toBe(
            false,
        );
        await insertVectors(
            database,
            TEACHER_SPACE_ID,
            "floor-track-",
            2,
            ANN_INDEX_MIN_VECTOR_COUNT,
        );
        await expect(ensureSpaceAnnIndex(TEACHER_SPACE_ID)).resolves.toBe(true);

        const indexName = `track_embeddings_${TEACHER_SPACE_ID}_ivfflat_idx`;
        const indexes = await loadEmbeddingIndexes(database);
        expect(indexes).toContainEqual(
            expect.objectContaining({
                name: indexName,
                isValid: true,
                options: expect.arrayContaining(["lists=40"]),
                predicate: expect.stringContaining(
                    `space_id = '${TEACHER_SPACE_ID}'`,
                ),
            }),
        );
        expect(
            indexes.some((index) => index.name.includes("space_empty")),
        ).toBe(false);

        const adapterRows = await prisma.$queryRaw<Array<{ options: unknown }>>`
            SELECT reloptions AS options
            FROM pg_catalog.pg_class
            WHERE relname = ${indexName}
            LIMIT 1
        `;
        expect(adapterRows).toEqual([{ options: ["lists=40"] }]);

        const executeRawSpy = jest.spyOn(prisma, "$executeRawUnsafe");
        try {
            await expect(ensureSpaceAnnIndex(TEACHER_SPACE_ID)).resolves.toBe(
                true,
            );
            expect(executeRawSpy).not.toHaveBeenCalled();
        } finally {
            executeRawSpy.mockRestore();
        }
    });

    it("matches exact and ANN top-k at the first size band", async () => {
        const spaceId = "space_ann_comparison";
        await insertComparisonCorpus(database, spaceId);
        await expect(ensureSpaceAnnIndex(spaceId)).resolves.toBe(true);
        await database.query("ANALYZE track_embeddings");

        const exactIds = await queryNearestIds(database, spaceId, true);
        const annIds = await queryNearestIds(database, spaceId, false);
        const plan = await loadAnnPlan(database, spaceId);
        expect(annIds).toEqual(exactIds);
        expect(plan).toContain(`track_embeddings_${spaceId}_ivfflat_idx`);
    });

    it("rolls back a vector write when the generation CAS is stale", async () => {
        await database.query(`
            INSERT INTO "Track" (
                "id", "vibeAnalysisStatus", "vibeAnalysisGeneration"
            ) VALUES ('stale-generation-track', 'processing', 2)
        `);
        await expect(
            upsertTrackEmbedding(
                "stale-generation-track",
                Array(512).fill(0),
                "space_ann_comparison",
                { generation: 1, completedAt: new Date() },
            ),
        ).rejects.toBeInstanceOf(VibeEmbeddingGenerationMismatchError);

        const state = await database.query<{
            status: string;
            generation: number;
            vectors: string;
        }>(`
            SELECT track."vibeAnalysisStatus" AS status,
                   track."vibeAnalysisGeneration" AS generation,
                   COUNT(embedding.track_id)::text AS vectors
            FROM "Track" track
            LEFT JOIN track_embeddings embedding
              ON embedding.track_id = track.id
            WHERE track.id = 'stale-generation-track'
            GROUP BY track."vibeAnalysisStatus", track."vibeAnalysisGeneration"
        `);
        expect(state.rows).toEqual([
            { status: "processing", generation: 2, vectors: "0" },
        ]);
    });

    it("rejects writes into a retired embedding space", async () => {
        await database.query(`
            INSERT INTO embedding_spaces (
                id, family, checkpoint_hash, dim, preprocessing, status
            ) VALUES (
                'space_retired_write', 'retired-write', 'retired-write-hash',
                512, '{}'::jsonb, 'retired'
            )
        `);
        await database.query(`
            INSERT INTO "Track" (
                "id", "vibeAnalysisStatus", "vibeAnalysisGeneration"
            ) VALUES ('retired-write-track', 'processing', 0)
        `);
        await expect(
            upsertTrackEmbedding(
                "retired-write-track",
                Array(512).fill(0),
                "space_retired_write",
                { generation: 0, completedAt: new Date() },
            ),
        ).rejects.toBeInstanceOf(EmbeddingTargetInvalidatedError);

        const vectors = await database.query<{ count: string }>(`
            SELECT COUNT(*)::text AS count FROM track_embeddings
            WHERE track_id = 'retired-write-track'
        `);
        expect(vectors.rows).toEqual([{ count: "0" }]);
    });

    it("maps a real Prisma P2010 statement-timeout envelope carrying 57014", async () => {
        await expect(
            runAnnQuery(Prisma.sql`SELECT pg_sleep(0.05)`, undefined, {
                statementTimeoutMs: 1,
                timeoutMessage: "integration statement timed out",
            }),
        ).rejects.toMatchObject({
            message: "integration statement timed out",
        });
    });

    it("deletes at most twenty retirement batches and resumes idempotently", async () => {
        const retiredAt = new Date("2026-07-01T00:00:00.000Z");
        await database.query(
            `
                INSERT INTO embedding_spaces (
                    id, family, checkpoint_hash, dim, preprocessing,
                    status, had_vectors, retired_at
                ) VALUES (
                    'space_retired', 'retired', 'retired-hash', 512,
                    '{}'::jsonb, 'retired', true, $1
                )
            `,
            [retiredAt],
        );
        await insertVectors(
            database,
            "space_retired",
            "retired-track-",
            1,
            10_001,
        );
        invalidateActiveSpaceCache();

        const config = {
            threshold: 0.95,
            retirementGraceDays: 7,
            allowFailed: false,
            currentProviderSpaceId: TEACHER_SPACE_ID,
            now: () => new Date("2026-08-17T00:00:00.000Z"),
        };
        await runEmbeddingSpaceLifecycleCheck(config);
        const afterFirst = await database.query<{ count: string }>(`
            SELECT COUNT(*)::text AS count FROM track_embeddings
            WHERE space_id = 'space_retired'
        `);
        expect(afterFirst.rows[0]?.count).toBe("1");

        await runEmbeddingSpaceLifecycleCheck(config);
        const afterSecond = await database.query<{
            count: string;
            retiredAt: Date | null;
        }>(`
            SELECT COUNT(embedding.track_id)::text AS count,
                   space.retired_at AS "retiredAt"
            FROM embedding_spaces space
            LEFT JOIN track_embeddings embedding ON embedding.space_id = space.id
            WHERE space.id = 'space_retired'
            GROUP BY space.retired_at
        `);
        expect(afterSecond.rows).toEqual([{ count: "0", retiredAt: null }]);
    });

    it("preserves vectors when reactivation wins a cleanup interleaving", async () => {
        const cleanup = new Client({
            connectionString: process.env.DATABASE_URL,
        });
        const reactivation = new Client({
            connectionString: process.env.DATABASE_URL,
        });
        const retiredAt = new Date("2026-07-01T00:00:00.000Z");
        const claimedAt = new Date("2026-08-17T00:00:00.000Z");
        await Promise.all([cleanup.connect(), reactivation.connect()]);
        try {
            await database.query(
                `INSERT INTO embedding_spaces (
                    id, family, checkpoint_hash, dim, preprocessing,
                    status, retired_at
                 ) VALUES (
                    'space_reactivated', 'reactivated', 'reactivated-hash',
                    512, '{}'::jsonb, 'retired', $1
                 )`,
                [retiredAt],
            );
            await insertVectors(
                database,
                "space_reactivated",
                "reactivated-track-",
                1,
                1,
            );
            await cleanup.query(
                `UPDATE embedding_spaces SET cleaning_at = $1
                 WHERE id = 'space_reactivated' AND status = 'retired'`,
                [claimedAt],
            );
            await reactivation.query(`
                UPDATE embedding_spaces
                SET status = 'migrating', retired_at = NULL, cleaning_at = NULL
                WHERE id = 'space_reactivated'
            `);

            await cleanup.query("BEGIN");
            const claim = await cleanup.query(
                `UPDATE embedding_spaces SET cleaning_at = cleaning_at
                 WHERE id = 'space_reactivated'
                   AND status = 'retired'
                   AND retired_at = $1
                   AND cleaning_at = $2`,
                [retiredAt, claimedAt],
            );
            if (claim.rowCount === 1) {
                await cleanup.query(
                    "DELETE FROM track_embeddings WHERE space_id = 'space_reactivated'",
                );
            }
            await cleanup.query("COMMIT");

            expect(claim.rowCount).toBe(0);
            const remaining = await database.query<{ count: string }>(`
                SELECT COUNT(*)::text AS count FROM track_embeddings
                WHERE space_id = 'space_reactivated'
            `);
            expect(remaining.rows).toEqual([{ count: "1" }]);
        } finally {
            await Promise.all([cleanup.end(), reactivation.end()]);
        }
    });
});
