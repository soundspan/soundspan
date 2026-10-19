import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { assertSmoke, runCommand } from "./support";

export const SOURCE_DATABASE = "smoke_source";
export const TARGET_DATABASE = "smoke_target";
const MAX_TABLES = 10_000;

export function databaseUrl(adminUrl: string, database: string): string {
    const value = new URL(adminUrl);
    value.pathname = `/${database}`;
    value.searchParams.delete("schema");
    return value.toString();
}

export async function recreateDatabases(adminUrl: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
        await client.query(
            'DROP DATABASE IF EXISTS "smoke_source" WITH (FORCE)',
        );
        await client.query(
            'DROP DATABASE IF EXISTS "smoke_target" WITH (FORCE)',
        );
        await client.query('CREATE DATABASE "smoke_source"');
        await client.query('CREATE DATABASE "smoke_target"');
    } finally {
        await client.end();
    }
}

export async function migrateDatabase(
    backendRoot: string,
    targetUrl: string,
): Promise<void> {
    await runCommand(
        `${backendRoot}/node_modules/.bin/prisma`,
        ["migrate", "deploy"],
        {
            cwd: backendRoot,
            env: { ...process.env, DATABASE_URL: targetUrl },
            timeoutMs: 5 * 60 * 1_000,
        },
    );
}

async function seedEmbedding(client: Client): Promise<void> {
    await client.query("BEGIN");
    try {
        await client.query(`
            INSERT INTO embedding_spaces
                (id, family, checkpoint_hash, dim, preprocessing, status)
            VALUES ('smoke-space', 'smoke', 'smoke-checkpoint', 512, '{}'::jsonb, 'migrating')
        `);
        const vector = `[${Array.from({ length: 512 }, () => "0.125").join(",")}]`;
        await client.query(
            `INSERT INTO track_embeddings (track_id, embedding, space_id)
             VALUES ('smoke-track', $1::vector, 'smoke-space')`,
            [vector],
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
}

export async function seedLibrary(sourceUrl: string): Promise<void> {
    const client = new Client({ connectionString: sourceUrl });
    await client.connect();
    try {
        await client.query(`
            INSERT INTO "Artist" (id, mbid, name)
            VALUES ('smoke-artist', 'smoke-artist-mbid', 'Smoke Artist')
        `);
        await client.query(`
            INSERT INTO "Album" (id, "rgMbid", "artistId", title, "primaryType")
            VALUES ('smoke-album', 'smoke-album-mbid', 'smoke-artist', 'Smoke Album', 'Album')
        `);
        await client.query(`
            INSERT INTO "Track"
                (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "updatedAt")
            VALUES
                ('smoke-track', 'smoke-album', 'Smoke Track', 1, 180,
                 '/music/smoke.flac', now(), 1234, now())
        `);
        const lyrics = randomBytes(5 * 1024 * 1024).toString("base64");
        await client.query(
            `INSERT INTO "TrackLyrics" (id, "trackId", "plainLyrics", source, "updatedAt")
             VALUES ('smoke-lyrics', 'smoke-track', $1, 'embedded', now())`,
            [lyrics],
        );
        await seedEmbedding(client);
        process.stdout.write("Seeded one track embedding.\n");
    } finally {
        await client.end();
    }
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

async function tableCounts(client: Client): Promise<Map<string, string>> {
    const result = await client.query<{ table_name: string }>(`
        SELECT tablename AS table_name
          FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
         ORDER BY tablename
         LIMIT ${MAX_TABLES + 1}
    `);
    assertSmoke(
        result.rows.length <= MAX_TABLES,
        "Public table inventory exceeds smoke bound",
    );
    const counts = new Map<string, string>();
    for (const row of result.rows) {
        const count = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM public.${quoteIdentifier(row.table_name)}`,
        );
        counts.set(row.table_name, count.rows[0]?.count ?? "missing");
    }
    return counts;
}

export async function summarizeDatabase(
    database: string,
): Promise<{ tables: number; rows: number }> {
    const client = new Client({ connectionString: database });
    await client.connect();
    try {
        const counts = await tableCounts(client);
        let rows = 0;
        for (const count of counts.values()) {
            rows += Number(count);
        }
        assertSmoke(Number.isSafeInteger(rows), "Database row count is unsafe");
        return { tables: counts.size, rows };
    } finally {
        await client.end();
    }
}

async function migrationNames(client: Client): Promise<string[]> {
    const result = await client.query<{ migration_name: string }>(`
        SELECT migration_name
          FROM public._prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
         ORDER BY migration_name
    `);
    return result.rows.map((row) => row.migration_name);
}

export async function compareDatabases(
    sourceUrl: string,
    targetUrl: string,
): Promise<void> {
    const source = new Client({ connectionString: sourceUrl });
    const target = new Client({ connectionString: targetUrl });
    await source.connect();
    await target.connect();
    try {
        const sourceCounts = await tableCounts(source);
        const targetCounts = await tableCounts(target);
        const sourceMigrations = await migrationNames(source);
        const targetMigrations = await migrationNames(target);
        assertSmoke(
            JSON.stringify([...targetCounts]) ===
                JSON.stringify([...sourceCounts]),
            `Database table counts differ: source=${JSON.stringify([...sourceCounts])} target=${JSON.stringify([...targetCounts])}`,
        );
        assertSmoke(
            JSON.stringify(targetMigrations) ===
                JSON.stringify(sourceMigrations),
            "Applied migration sets differ between source and target",
        );
        const sourceVector = await source.query<{ embedding: string }>(
            `SELECT embedding::text AS embedding FROM track_embeddings
              WHERE track_id = 'smoke-track' AND space_id = 'smoke-space'`,
        );
        const targetVector = await target.query<{ embedding: string }>(
            `SELECT embedding::text AS embedding FROM track_embeddings
              WHERE track_id = 'smoke-track' AND space_id = 'smoke-space'`,
        );
        assertSmoke(
            sourceVector.rows[0]?.embedding === targetVector.rows[0]?.embedding,
            "Restored track embedding differs from the source",
        );
    } finally {
        await Promise.all([source.end(), target.end()]);
    }
}
