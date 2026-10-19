import { Client } from "pg";
import type { BackupHeader, BackupSequence } from "./backupFormat";
import { readBackupRecords } from "./backupArchiveReader";
import {
    quoteIdent,
    readApplicationTables,
    readForeignKeys,
    readOwnedSequences,
    readVectorIndexes,
    type CatalogTable,
} from "./backupCatalog";
import { RestoreError } from "./backupErrors";

export interface RestoreProgress {
    completedTables: number;
    totalTables: number;
    completedRows: number;
    totalRows: number;
}

function capped(values: string[]): string {
    return values.slice(0, 10).join(", ");
}

function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function validateSchema(header: BackupHeader, target: CatalogTable[]): void {
    const targetByName = new Map(target.map((table) => [table.name, table]));
    const archiveNames = new Set(header.tables.map((table) => table.name));
    const targetNames = new Set(targetByName.keys());
    const mismatches: string[] = [];
    for (const name of archiveNames) {
        if (!targetNames.has(name))
            mismatches.push(`missing target table ${name}`);
    }
    for (const name of targetNames) {
        if (!archiveNames.has(name))
            mismatches.push(`missing archive table ${name}`);
    }
    for (const table of header.tables) {
        const targetTable = targetByName.get(table.name);
        if (!targetTable) continue;
        const archiveColumns = new Set(
            table.columns.map((column) => column.name),
        );
        const targetColumns = new Set(
            targetTable.columns.map((column) => column.name),
        );
        const targetTypes = new Map(
            targetTable.columns.map((column) => [column.name, column.type]),
        );
        for (const name of archiveColumns) {
            if (!targetColumns.has(name))
                mismatches.push(`${table.name}.${name} absent`);
        }
        for (const column of table.columns) {
            const targetType = targetTypes.get(column.name);
            if (targetType && targetType !== column.type) {
                mismatches.push(
                    `${table.name}.${column.name} type ${column.type} != ${targetType}`,
                );
            }
        }
        for (const name of targetColumns) {
            if (!archiveColumns.has(name))
                mismatches.push(`${table.name}.${name} missing`);
        }
    }
    if (mismatches.length !== 0) {
        throw new RestoreError(
            "BACKUP_SCHEMA_MISMATCH",
            `Backup schema does not match: ${capped(mismatches)}`,
        );
    }
}

async function prepareTables(
    client: Client,
    tables: CatalogTable[],
    signal?: AbortSignal,
): Promise<void> {
    if (tables.length === 0) return;
    signal?.throwIfAborted();
    const names = tables.map((table) => `public.${quoteIdent(table.name)}`);
    await client.query(
        `LOCK TABLE ${names.join(", ")} IN ACCESS EXCLUSIVE MODE`,
    );
    await client.query(`TRUNCATE TABLE ${names.join(", ")} CASCADE`);
}

async function setUserTriggers(
    client: Client,
    tables: CatalogTable[],
    enabled: boolean,
    signal?: AbortSignal,
): Promise<void> {
    for (const table of tables) {
        signal?.throwIfAborted();
        await client.query(
            `ALTER TABLE public.${quoteIdent(table.name)} ${
                enabled ? "ENABLE" : "DISABLE"
            } TRIGGER USER`,
        );
    }
}

async function restoreSequences(
    client: Client,
    target: Awaited<ReturnType<typeof readOwnedSequences>>,
    archive: BackupSequence[],
    signal?: AbortSignal,
): Promise<void> {
    const archiveByName = new Map(
        archive.map((sequence) => [sequence.name, sequence]),
    );
    for (const sequence of target) {
        signal?.throwIfAborted();
        const saved = archiveByName.get(sequence.name);
        if (
            !saved ||
            saved.table !== sequence.table ||
            saved.column !== sequence.column
        ) {
            throw new RestoreError(
                "BACKUP_SCHEMA_MISMATCH",
                `Backup sequence does not match target: ${sequence.name}`,
            );
        }
        const regclass = `public.${quoteIdent(sequence.name)}`;
        await client.query("SELECT setval($1::regclass, $2::bigint, $3)", [
            regclass,
            saved.lastValue,
            saved.isCalled,
        ]);
        archiveByName.delete(sequence.name);
    }
    if (archiveByName.size !== 0) {
        throw new RestoreError(
            "BACKUP_SCHEMA_MISMATCH",
            "Backup has unknown sequences",
        );
    }
}

async function insertArchiveRows(
    client: Client,
    filePath: string,
    header: BackupHeader,
    target: CatalogTable[],
    onProgress: (progress: RestoreProgress) => void | Promise<void>,
    signal?: AbortSignal,
): Promise<Map<string, number>> {
    const targetByName = new Map(target.map((table) => [table.name, table]));
    const inserted = new Map<string, number>();
    const completed = new Set<string>();
    const totalRows = header.tables.reduce(
        (sum, table) => sum + table.rowCount,
        0,
    );
    let completedRows = 0;
    for await (const record of readBackupRecords(filePath, undefined, signal)) {
        signal?.throwIfAborted();
        if (record.type !== "rows") continue;
        const table = targetByName.get(record.table);
        if (!table)
            throw new RestoreError("BACKUP_SCHEMA_MISMATCH", "Unknown table");
        const columns = table.columns.map((column) => quoteIdent(column.name));
        const tableIdent = quoteIdent(table.name);
        const values = table.columns.map((column) => {
            const columnIdent = quoteIdent(column.name);
            if (column.type === "json" || column.type === "jsonb") {
                const key = quoteLiteral(column.name);
                return `CASE WHEN e->${key} = 'null'::jsonb THEN NULL ELSE ((e->${key})->0)::${column.type} END`;
            }
            return `r.${columnIdent}`;
        });
        const result = await client.query(
            `INSERT INTO public.${tableIdent} (${columns.join(", ")}) OVERRIDING SYSTEM VALUE
             SELECT ${values.join(", ")}
               FROM jsonb_array_elements($1::jsonb) AS e
               CROSS JOIN LATERAL jsonb_populate_record(NULL::public.${tableIdent}, e) AS r`,
            [record.rows],
        );
        const rowCount = result.rowCount ?? 0;
        inserted.set(
            record.table,
            (inserted.get(record.table) ?? 0) + rowCount,
        );
        completedRows += rowCount;
        if (
            (inserted.get(record.table) ?? 0) ===
            header.tables.find((item) => item.name === record.table)?.rowCount
        ) {
            completed.add(record.table);
        }
        await onProgress({
            completedTables: completed.size,
            totalTables: header.tables.length,
            completedRows,
            totalRows,
        });
    }
    return inserted;
}

function verifyCounts(
    header: BackupHeader,
    inserted: Map<string, number>,
): void {
    for (const table of header.tables) {
        if ((inserted.get(table.name) ?? 0) !== table.rowCount) {
            throw new RestoreError(
                "BACKUP_ROW_COUNT_MISMATCH",
                `Restored row count mismatch for ${table.name}`,
            );
        }
    }
}

async function loadTransactionData(
    client: Client,
    filePath: string,
    header: BackupHeader,
    onProgress: (progress: RestoreProgress) => void | Promise<void>,
    beforeCommit: ((client: Client) => void | Promise<void>) | undefined,
    signal: AbortSignal | undefined,
): Promise<void> {
    const tables = await readApplicationTables(client);
    signal?.throwIfAborted();
    validateSchema(header, tables);
    const foreignKeys = await readForeignKeys(client);
    signal?.throwIfAborted();
    const vectorIndexes = await readVectorIndexes(client);
    signal?.throwIfAborted();
    const sequences = await readOwnedSequences(client, tables);
    await prepareTables(client, tables, signal);
    for (const foreignKey of foreignKeys) {
        signal?.throwIfAborted();
        await client.query(
            `ALTER TABLE public.${quoteIdent(foreignKey.table)} DROP CONSTRAINT ${quoteIdent(foreignKey.name)}`,
        );
    }
    await setUserTriggers(client, tables, false, signal);
    const inserted = await insertArchiveRows(
        client,
        filePath,
        header,
        tables,
        onProgress,
        signal,
    );
    await setUserTriggers(client, tables, true, signal);
    for (const foreignKey of foreignKeys) {
        signal?.throwIfAborted();
        await client.query(
            `ALTER TABLE public.${quoteIdent(foreignKey.table)} ADD CONSTRAINT ${quoteIdent(foreignKey.name)} ${foreignKey.definition}`,
        );
    }
    await restoreSequences(client, sequences, header.sequences, signal);
    for (const index of vectorIndexes) {
        signal?.throwIfAborted();
        await client.query(`REINDEX INDEX public.${quoteIdent(index.name)}`);
    }
    verifyCounts(header, inserted);
    signal?.throwIfAborted();
    if (beforeCommit) await beforeCommit(client);
    signal?.throwIfAborted();
}

/** Load a validated data-only archive in one all-or-nothing transaction. */
export async function loadBackupData(
    client: Client,
    filePath: string,
    header: BackupHeader,
    onProgress: (progress: RestoreProgress) => void | Promise<void>,
    beforeCommit?: (client: Client) => void | Promise<void>,
    onCommitStarting?: () => void,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    await client.query("BEGIN");
    try {
        await loadTransactionData(
            client,
            filePath,
            header,
            onProgress,
            beforeCommit,
            signal,
        );
        onCommitStarting?.();
        await client.query("COMMIT");
    } catch (error) {
        if (!signal?.aborted) {
            await client.query("ROLLBACK").catch(() => undefined);
        }
        throw error;
    }
}
