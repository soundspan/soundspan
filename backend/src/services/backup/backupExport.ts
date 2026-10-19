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
    type BackupRowsRecord,
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
const QUERY_BYTE_TARGET = 15 * 1024 * 1024;
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
    value: string,
): Promise<void> {
    if (Buffer.byteLength(value, "utf8") > MAX_BACKUP_RECORD_BYTES) {
        throw new Error("Backup record exceeds the restore reader limit");
    }
    if (!gzip.write(value)) {
        await Promise.race([
            once(gzip, "drain"),
            outputFinished.then(() => {
                throw new Error("Backup output closed before draining");
            }),
        ]);
    }
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
    await client.query(
        `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT (${cursorRowExpression(table)})::text AS row FROM public.${quoteIdent(table.name)} t`,
    );
}

async function writeTableRows(
    client: Client,
    gzip: Writable,
    outputFinished: Promise<void>,
    table: CatalogTable,
    hmac: crypto.Hmac,
): Promise<void> {
    await declareTableCursor(client, table);
    let rows: string[] = [];
    let bytes = 2;
    let batchCount = 0;
    const flush = async (): Promise<void> => {
        if (rows.length === 0) return;
        const record: BackupRowsRecord = {
            type: "rows",
            table: table.name,
            rowCount: rows.length,
            rows: `[${rows.join(",")}]`,
        };
        const encoded = encodeBackupRecord(record);
        hmac.update(encoded, "utf8");
        await writeCompressed(gzip, outputFinished, encoded);
        rows = [];
        bytes = 2;
        batchCount += 1;
        if (batchCount > MAX_BATCHES_PER_TABLE) {
            throw new Error("Table exceeds the supported backup batch limit");
        }
    };
    try {
        for (
            let fetchCount = 0;
            fetchCount < MAX_BATCHES_PER_TABLE;
            fetchCount += 1
        ) {
            const result = await client.query<{ row: string }>(
                "FETCH FORWARD 500 FROM backup_rows",
            );
            for (const item of result.rows) {
                const rowBytes = Buffer.byteLength(item.row, "utf8");
                const separator = rows.length === 0 ? 0 : 1;
                if (
                    rows.length >= QUERY_ROW_LIMIT ||
                    (rows.length > 0 &&
                        bytes + separator + rowBytes > QUERY_BYTE_TARGET)
                ) {
                    await flush();
                }
                rows.push(item.row);
                bytes += (rows.length === 1 ? 0 : 1) + rowBytes;
                if (rows.length === 1 && bytes > QUERY_BYTE_TARGET)
                    await flush();
            }
            if (result.rows.length < 500) {
                await flush();
                return;
            }
        }
        throw new Error("Table cursor exceeded the supported fetch limit");
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
        const encodedHeader = encodeBackupRecord(header);
        hmac.update(encodedHeader, "utf8");
        await writeCompressed(gzip, outputFinished, encodedHeader);
        for (const table of tables) {
            await writeTableRows(client, gzip, outputFinished, table, hmac);
        }
        await writeCompressed(
            gzip,
            outputFinished,
            encodeBackupRecord({
                type: "end",
                mac: hmac.digest("base64"),
            }),
        );
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

/** Acquire the database-wide export lock before the HTTP response is committed. */
export async function openBackupExport(
    options: ExportOptions,
): Promise<OpenBackupExport> {
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
    let closed = false;
    return {
        async streamTo(output) {
            activeOutput = output;
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
                await Promise.race([
                    streamSnapshot(client, output, options),
                    clientFailure.then((error) => {
                        throw error;
                    }),
                ]);
            } finally {
                activeOutput = null;
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
            client.off("error", onClientError);
        },
    };
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
