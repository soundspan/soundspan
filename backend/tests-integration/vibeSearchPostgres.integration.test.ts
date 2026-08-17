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
] as const;

interface IndexRow {
    name: string;
    isValid: boolean;
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
        CREATE TABLE "Track" ("id" TEXT PRIMARY KEY);
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
                predicate: expect.stringContaining(
                    `space_id = '${TEACHER_SPACE_ID}'`,
                ),
            }),
        );
        expect(
            indexes.some((index) => index.name.includes("space_empty")),
        ).toBe(false);
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
});
