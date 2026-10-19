import { once } from "events";
import { Client } from "pg";
import type { Writable } from "stream";
import { finished } from "stream/promises";
import { createGzip } from "zlib";
import { config } from "../../config";
import { getPepperFingerprint } from "../../utils/apiKeyHash";
import {
    BACKUP_FORMAT_MAGIC,
    BACKUP_FORMAT_VERSION,
    encodeBackupRecord,
    type BackupHeader,
    type BackupMigration,
    type BackupRowsRecord,
    type WrappedEncryptionKey,
} from "./backupFormat";
import {
    quoteIdent,
    readApplicationTables,
    readOwnedSequences,
    type CatalogTable,
} from "./backupCatalog";
import { BackupBusyError } from "./backupErrors";

export const BACKUP_ADVISORY_LOCK = 5_331_001_001;
const QUERY_ROW_LIMIT = 1_000;
const QUERY_BYTE_TARGET = 15 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_BATCHES_PER_TABLE = 10_000_000;

interface ExportOptions {
    wrappedKey: WrappedEncryptionKey;
    appVersion: string;
}

export interface OpenBackupExport {
    streamTo(output: Writable): Promise<void>;
    close(): Promise<void>;
}

async function writeCompressed(gzip: Writable, value: string): Promise<void> {
    if (!gzip.write(value)) await once(gzip, "drain");
}

async function readMigrations(client: Client): Promise<BackupMigration[]> {
    const result = await client.query<{
        migration_name: string;
        checksum: string;
    }>(`
        SELECT migration_name, checksum
          FROM public._prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
         ORDER BY migration_name
    `);
    return result.rows.map((row) => ({
        name: row.migration_name,
        checksum: row.checksum,
    }));
}

async function countTables(
    client: Client,
    tables: CatalogTable[],
): Promise<Array<CatalogTable & { rowCount: number }>> {
    const counted = [];
    for (const table of tables) {
        const result = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM public.${quoteIdent(table.name)}`,
        );
        const rowCount = Number(result.rows[0]?.count ?? "0");
        if (!Number.isSafeInteger(rowCount)) {
            throw new Error("Table row count exceeds the supported range");
        }
        counted.push({ ...table, rowCount });
    }
    return counted;
}

async function readRowBatch(
    client: Client,
    table: CatalogTable,
    cursor: string,
): Promise<{ rows: string; rowCount: number; cursor: string } | null> {
    // pg_column_size(to_jsonb(row)) plus a 1 MiB framing margin keeps ordinary
    // batches below 16 MiB even for bytea JSON expansion. The first row is
    // always admitted so one intrinsically larger row can make progress alone.
    const sql = `
        WITH candidates AS (
            SELECT source.*, source.ctid::text AS _backup_ctid,
                   pg_column_size(to_jsonb(source)) AS _backup_bytes,
                   row_number() OVER (ORDER BY source.ctid) AS _backup_number
              FROM public.${quoteIdent(table.name)} AS source
             WHERE source.ctid > $1::tid
             ORDER BY source.ctid
             LIMIT $2
        ), sized AS (
            SELECT candidates.*,
                   sum(_backup_bytes) OVER (ORDER BY _backup_number) AS _backup_total
              FROM candidates
        ), page AS (
            SELECT * FROM sized
             WHERE _backup_total <= $3 OR _backup_number = 1
             ORDER BY _backup_number
             LIMIT $2
        )
        SELECT jsonb_agg(to_jsonb(page) - (ARRAY[
                   '_backup_ctid', '_backup_bytes', '_backup_number', '_backup_total'
               ]::text[] || $4::text[]))::text AS rows,
               count(*)::int AS row_count,
               (array_agg(_backup_ctid ORDER BY _backup_number DESC))[1] AS cursor
          FROM page
    `;
    const result = await client.query<{
        rows: string | null;
        row_count: number;
        cursor: string | null;
    }>(sql, [
        cursor,
        QUERY_ROW_LIMIT,
        QUERY_BYTE_TARGET,
        table.generatedColumns,
    ]);
    const row = result.rows[0];
    if (!row?.rows || !row.cursor || row.row_count === 0) return null;
    return { rows: row.rows, rowCount: row.row_count, cursor: row.cursor };
}

async function writeTableRows(
    client: Client,
    gzip: Writable,
    table: CatalogTable,
): Promise<void> {
    let cursor = "(0,0)";
    for (
        let batchNumber = 0;
        batchNumber < MAX_BATCHES_PER_TABLE;
        batchNumber += 1
    ) {
        const batch = await readRowBatch(client, table, cursor);
        if (!batch) return;
        const record: BackupRowsRecord = {
            type: "rows",
            table: table.name,
            rowCount: batch.rowCount,
            rows: batch.rows,
        };
        await writeCompressed(gzip, encodeBackupRecord(record));
        cursor = batch.cursor;
    }
    throw new Error("Table exceeds the supported backup batch limit");
}

async function buildHeader(
    client: Client,
    options: ExportOptions,
): Promise<{ header: BackupHeader; tables: CatalogTable[] }> {
    const tables = await readApplicationTables(client);
    const counted = await countTables(client, tables);
    return {
        tables,
        header: {
            type: "header",
            magic: BACKUP_FORMAT_MAGIC,
            formatVersion: BACKUP_FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            appVersion: options.appVersion,
            pepperFingerprint: getPepperFingerprint(),
            wrappedKey: options.wrappedKey,
            migrations: await readMigrations(client),
            tables: counted.map(({ name, columns, rowCount }) => ({
                name,
                columns,
                rowCount,
            })),
            sequences: await readOwnedSequences(client, tables),
        },
    };
}

async function streamSnapshot(
    client: Client,
    output: Writable,
    options: ExportOptions,
): Promise<void> {
    const gzip = createGzip();
    gzip.pipe(output);
    await client.query("SET statement_timeout = '10min'");
    await client.query("SET idle_in_transaction_session_timeout = '30min'");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
        const { header, tables } = await buildHeader(client, options);
        await writeCompressed(gzip, encodeBackupRecord(header));
        for (const table of tables) await writeTableRows(client, gzip, table);
        await writeCompressed(gzip, encodeBackupRecord({ type: "end" }));
        gzip.end();
        await Promise.all([finished(gzip), finished(output)]);
        await client.query("COMMIT");
    } catch (error) {
        gzip.destroy();
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
}

/** Acquire the database-wide export lock before the HTTP response is committed. */
export async function openBackupExport(
    options: ExportOptions,
): Promise<OpenBackupExport> {
    const client = new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 10 * 60 * 1000,
    });
    await client.connect();
    const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [BACKUP_ADVISORY_LOCK],
    );
    if (!lock.rows[0]?.acquired) {
        await client.end();
        throw new BackupBusyError();
    }
    let closed = false;
    return {
        async streamTo(output) {
            const timeout = setTimeout(
                () => client.end().catch(() => undefined),
                EXPORT_TIMEOUT_MS,
            );
            timeout.unref();
            const abort = () => {
                if (!output.writableFinished) {
                    void client.end().catch(() => undefined);
                }
            };
            output.once("close", abort);
            try {
                await streamSnapshot(client, output, options);
            } finally {
                clearTimeout(timeout);
                output.off("close", abort);
            }
        },
        async close() {
            if (closed) return;
            closed = true;
            await client
                .query("SELECT pg_advisory_unlock($1)", [BACKUP_ADVISORY_LOCK])
                .catch(() => undefined);
            await client.end().catch(() => undefined);
        },
    };
}

/** Probe the export lock without retaining it. */
export async function isBackupExportBusy(): Promise<boolean> {
    const client = new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    try {
        const result = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS acquired",
            [BACKUP_ADVISORY_LOCK],
        );
        if (!result.rows[0]?.acquired) return true;
        await client.query("SELECT pg_advisory_unlock($1)", [
            BACKUP_ADVISORY_LOCK,
        ]);
        return false;
    } finally {
        await client.end();
    }
}
