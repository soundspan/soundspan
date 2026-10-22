import { once } from "events";
import crypto from "crypto";
import { Client } from "pg";
import type { Writable } from "stream";
import { finished, pipeline } from "stream/promises";
import { createGzip } from "zlib";
import { config } from "../../config";
import {
    BACKUP_FORMAT_MAGIC,
    BACKUP_FORMAT_VERSION,
    encodeBackupRecord,
    type BackupHeader,
    type BackupMigration,
    type BackupRecord,
    type WrappedEncryptionKey,
    MAX_BACKUP_RECORD_BYTES,
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
// PostgreSQL's jsonb text has no raw control characters, so re-encoding the rows string only escapes
// quotes and backslashes: an encoded record is at most twice its raw batch plus the envelope.
const BATCH_RAW_BYTE_TARGET = 4 * 1024 * 1024;
const INLINE_ROW_BYTES = 64 * 1024;
const RECORD_ENVELOPE_BYTES = 64 * 1024;
const FETCH_ROWS = 256;
const EXPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_BATCHES_PER_TABLE = 10_000_000;

interface ExportOptions {
    wrappedKey: WrappedEncryptionKey;
    macKey: Buffer;
    appVersion: string;
}

export interface OpenBackupExport {
    streamTo(output: Writable): Promise<void>;
    close(): Promise<void>;
}

async function writeCompressed(
    gzip: Writable,
    outputFinished: Promise<void>,
    value: Buffer,
): Promise<void> {
    if (!gzip.write(value)) {
        await Promise.race([
            once(gzip, "drain"),
            outputFinished.then(() => {
                throw new Error("Backup output closed before draining");
            }),
        ]);
    }
}

function encodeRecordBuffer(record: BackupRecord): Buffer {
    const buffer = Buffer.from(encodeBackupRecord(record), "utf8");
    if (buffer.length > MAX_BACKUP_RECORD_BYTES) {
        if (record.type === "rows") {
            throw new Error(
                `Backup record for table ${record.table} exceeds the restore reader limit`,
            );
        }
        throw new Error("Backup record exceeds the restore reader limit");
    }
    return buffer;
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

function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function cursorRowExpression(table: CatalogTable): string {
    const removed = table.generatedColumns.length
        ? ` - ARRAY[${table.generatedColumns.map(quoteLiteral).join(", ")}]::text[]`
        : "";
    const jsonColumns = table.columns.filter(
        (column) => column.type === "json" || column.type === "jsonb",
    );
    const wrapped = jsonColumns.map((column) => {
        const name = quoteIdent(column.name);
        return `jsonb_build_object(${quoteLiteral(column.name)}, CASE WHEN t.${name} IS NULL THEN 'null'::jsonb ELSE jsonb_build_array(t.${name}::jsonb) END)`;
    });
    return [`to_jsonb(t)${removed}`, ...wrapped].join(" || ");
}

async function declareTableCursor(
    client: Client,
    table: CatalogTable,
): Promise<void> {
    const rowExpression = cursorRowExpression(table);
    // OFFSET 0 prevents PostgreSQL from recomputing the JSON expression for each outer reference.
    await client.query(
        `DECLARE backup_rows NO SCROLL CURSOR FOR
         SELECT CASE WHEN octet_length(x.row) <= ${INLINE_ROW_BYTES} THEN x.row END AS row,
                octet_length(x.row) AS bytes,
                CASE WHEN octet_length(x.row) > ${INLINE_ROW_BYTES} THEN x.tableoid::text END AS tableoid,
                CASE WHEN octet_length(x.row) > ${INLINE_ROW_BYTES} THEN x.ctid::text END AS ctid
           FROM (SELECT (${rowExpression})::text AS row, t.tableoid, t.ctid
                   FROM public.${quoteIdent(table.name)} t OFFSET 0) x`,
    );
}

interface TableBatch {
    rows: string[];
    bytes: number;
    count: number;
}

async function flushTableBatch(
    gzip: Writable,
    outputFinished: Promise<void>,
    table: CatalogTable,
    hmac: crypto.Hmac,
    batch: TableBatch,
): Promise<void> {
    if (batch.rows.length === 0) return;
    const rowCount = batch.rows.length;
    const rows = `[${batch.rows.join(",")}]`;
    batch.rows = [];
    batch.bytes = 2;
    const buffer = encodeRecordBuffer({
        type: "rows",
        table: table.name,
        rowCount,
        rows,
    });
    hmac.update(buffer);
    await writeCompressed(gzip, outputFinished, buffer);
    batch.count += 1;
    if (batch.count > MAX_BATCHES_PER_TABLE) {
        throw new Error("Table exceeds the supported backup batch limit");
    }
}

async function appendCursorRow(
    row: string,
    batch: TableBatch,
    flush: () => Promise<void>,
): Promise<void> {
    const rowBytes = Buffer.byteLength(row, "utf8");
    const separator = batch.rows.length === 0 ? 0 : 1;
    if (
        batch.rows.length >= QUERY_ROW_LIMIT ||
        (batch.rows.length > 0 &&
            batch.bytes + separator + rowBytes > BATCH_RAW_BYTE_TARGET)
    ) {
        await flush();
    }
    batch.rows.push(row);
    batch.bytes += (batch.rows.length === 1 ? 0 : 1) + rowBytes;
    if (batch.rows.length === 1 && batch.bytes > BATCH_RAW_BYTE_TARGET) {
        await flush();
    }
}

interface CursorRow {
    row: unknown;
    bytes: unknown;
    tableoid: unknown;
    ctid: unknown;
}

function readCursorBytes(table: CatalogTable, item: CursorRow): number {
    if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) {
        throw new Error(`Table ${table.name} returned an invalid row size`);
    }
    return Number(item.bytes);
}

async function fetchOversizedRow(
    client: Client,
    table: CatalogTable,
    tableoid: string,
    ctid: string,
): Promise<string> {
    const result = await client.query<{ row: unknown }>(
        `SELECT (${cursorRowExpression(table)})::text AS row
           FROM public.${quoteIdent(table.name)} t
          WHERE t.tableoid = $1::oid AND t.ctid = $2::tid`,
        [tableoid, ctid],
    );
    const row = result.rows[0]?.row;
    if (result.rows.length !== 1 || typeof row !== "string") {
        throw new Error(`Table ${table.name} changed during backup`);
    }
    return row;
}

async function resolveCursorRow(
    client: Client,
    table: CatalogTable,
    item: CursorRow,
): Promise<string> {
    const bytes = readCursorBytes(table, item);
    if (typeof item.row === "string" && bytes <= INLINE_ROW_BYTES) {
        return item.row;
    }
    if (item.row !== null || bytes <= INLINE_ROW_BYTES) {
        throw new Error(`Table ${table.name} returned an invalid cursor row`);
    }
    if (bytes > MAX_BACKUP_RECORD_BYTES - RECORD_ENVELOPE_BYTES) {
        throw new Error(
            `Table ${table.name} has a row larger than the backup record limit`,
        );
    }
    if (
        typeof item.tableoid !== "string" ||
        !/^[0-9]+$/.test(item.tableoid) ||
        typeof item.ctid !== "string"
    ) {
        throw new Error(`Table ${table.name} changed during backup`);
    }
    return fetchOversizedRow(client, table, item.tableoid, item.ctid);
}

async function writeCursorRows(
    client: Client,
    table: CatalogTable,
    batch: TableBatch,
    flush: () => Promise<void>,
): Promise<void> {
    for (
        let fetchCount = 0;
        fetchCount < MAX_BATCHES_PER_TABLE;
        fetchCount += 1
    ) {
        const result = await client.query<CursorRow>(
            `FETCH FORWARD ${FETCH_ROWS} FROM backup_rows`,
        );
        if (result.rows.length > FETCH_ROWS) {
            throw new Error("Table cursor returned too many rows");
        }
        for (let index = 0; index < FETCH_ROWS; index += 1) {
            const item = result.rows[index];
            if (!item) break;
            const row = await resolveCursorRow(client, table, item);
            await appendCursorRow(row, batch, flush);
        }
        if (result.rows.length < FETCH_ROWS) {
            await flush();
            return;
        }
    }
    throw new Error("Table cursor exceeded the supported fetch limit");
}

async function writeTableRows(
    client: Client,
    gzip: Writable,
    outputFinished: Promise<void>,
    table: CatalogTable,
    hmac: crypto.Hmac,
): Promise<void> {
    await declareTableCursor(client, table);
    const batch: TableBatch = { rows: [], bytes: 2, count: 0 };
    const flush = () =>
        flushTableBatch(gzip, outputFinished, table, hmac, batch);
    try {
        await writeCursorRows(client, table, batch, flush);
    } finally {
        await client.query("CLOSE backup_rows").catch(() => undefined);
    }
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
    const outputPipeline = pipeline(gzip, output);
    void outputPipeline.catch(() => undefined);
    const outputFinished = finished(gzip);
    void outputFinished.catch(() => undefined);
    try {
        await client.query("SET statement_timeout = '10min'");
        await client.query("SET idle_in_transaction_session_timeout = '30min'");
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const { header, tables } = await buildHeader(client, options);
        const hmac = crypto.createHmac("sha256", options.macKey);
        const encodedHeader = encodeRecordBuffer(header);
        hmac.update(encodedHeader);
        await writeCompressed(gzip, outputFinished, encodedHeader);
        for (const table of tables) {
            await writeTableRows(client, gzip, outputFinished, table, hmac);
        }
        const encodedEnd = encodeRecordBuffer({
            type: "end",
            mac: hmac.digest("base64"),
        });
        await writeCompressed(gzip, outputFinished, encodedEnd);
        gzip.end();
        await outputPipeline;
        await client.query("COMMIT");
    } catch (error) {
        gzip.destroy();
        await outputPipeline.catch(() => undefined);
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
}

interface ExportConnection {
    client: Client;
    clientFailure: Promise<Error>;
    setActiveOutput: (output: Writable | null) => void;
    detach: () => void;
}

async function acquireExportConnection(): Promise<ExportConnection> {
    const client = new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 10 * 60 * 1000,
    });
    let resolveClientFailure: ((error: Error) => void) | null = null;
    const clientFailure = new Promise<Error>((resolve) => {
        resolveClientFailure = resolve;
    });
    let activeOutput: Writable | null = null;
    const onClientError = (error: Error): void => {
        activeOutput?.destroy(error);
        resolveClientFailure?.(error);
    };
    client.on("error", onClientError);
    try {
        await client.connect();
        const lock = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS acquired",
            [BACKUP_ADVISORY_LOCK],
        );
        if (!lock.rows[0]?.acquired) throw new BackupBusyError();
    } catch (error) {
        await client.end().catch(() => undefined);
        client.off("error", onClientError);
        throw error;
    }
    return {
        client,
        clientFailure,
        setActiveOutput: (output) => {
            activeOutput = output;
        },
        detach: () => client.off("error", onClientError),
    };
}

function createExportHandle(
    connection: ExportConnection,
    options: ExportOptions,
): OpenBackupExport {
    const { client, clientFailure, setActiveOutput, detach } = connection;
    let closed = false;
    return {
        async streamTo(output) {
            setActiveOutput(output);
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
            const snapshot = streamSnapshot(client, output, options);
            try {
                await Promise.race([
                    snapshot,
                    clientFailure.then((error) => {
                        throw error;
                    }),
                ]);
            } catch (error) {
                await snapshot.catch(() => undefined);
                throw error;
            } finally {
                setActiveOutput(null);
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
            detach();
        },
    };
}

/** Acquire the database-wide export lock before the HTTP response is committed. */
export async function openBackupExport(
    options: ExportOptions,
): Promise<OpenBackupExport> {
    return createExportHandle(await acquireExportConnection(), options);
}

/** Probe the export lock without retaining it. */
export async function isBackupExportBusy(): Promise<boolean> {
    const client = new Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 5_000,
    });
    let clientFailure: Error | null = null;
    const onClientError = (error: Error): void => {
        clientFailure = error;
    };
    client.on("error", onClientError);
    await client.connect();
    try {
        const result = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS acquired",
            [BACKUP_ADVISORY_LOCK],
        );
        if (clientFailure) throw clientFailure;
        if (!result.rows[0]?.acquired) return true;
        await client.query("SELECT pg_advisory_unlock($1)", [
            BACKUP_ADVISORY_LOCK,
        ]);
        return false;
    } finally {
        await client.end().catch(() => undefined);
        client.off("error", onClientError);
    }
}
