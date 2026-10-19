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
        for (const name of archiveColumns) {
            if (!targetColumns.has(name))
                mismatches.push(`${table.name}.${name} absent`);
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
): Promise<void> {
    if (tables.length === 0) return;
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
): Promise<void> {
    for (const table of tables) {
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
): Promise<void> {
    const archiveByName = new Map(
        archive.map((sequence) => [sequence.name, sequence]),
    );
    for (const sequence of target) {
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
): Promise<Map<string, number>> {
    const targetByName = new Map(target.map((table) => [table.name, table]));
    const inserted = new Map<string, number>();
    const completed = new Set<string>();
    const totalRows = header.tables.reduce(
        (sum, table) => sum + table.rowCount,
        0,
    );
    let completedRows = 0;
    for await (const record of readBackupRecords(filePath)) {
        if (record.type !== "rows") continue;
        const table = targetByName.get(record.table);
        if (!table)
            throw new RestoreError("BACKUP_SCHEMA_MISMATCH", "Unknown table");
        const columns = table.columns.map((column) => quoteIdent(column.name));
        const tableIdent = quoteIdent(table.name);
        const result = await client.query(
            `INSERT INTO public.${tableIdent} (${columns.join(", ")}) OVERRIDING SYSTEM VALUE
             SELECT ${columns.join(", ")}
               FROM jsonb_populate_recordset(NULL::public.${tableIdent}, $1::jsonb)`,
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

/** Load a validated data-only archive in one all-or-nothing transaction. */
export async function loadBackupData(
    client: Client,
    filePath: string,
    header: BackupHeader,
    onProgress: (progress: RestoreProgress) => void | Promise<void>,
): Promise<void> {
    await client.query("BEGIN");
    try {
        const tables = await readApplicationTables(client);
        validateSchema(header, tables);
        const foreignKeys = await readForeignKeys(client);
        const vectorIndexes = await readVectorIndexes(client);
        const sequences = await readOwnedSequences(client, tables);
        await prepareTables(client, tables);
        for (const foreignKey of foreignKeys) {
            await client.query(
                `ALTER TABLE public.${quoteIdent(foreignKey.table)} DROP CONSTRAINT ${quoteIdent(foreignKey.name)}`,
            );
        }
        await setUserTriggers(client, tables, false);
        const inserted = await insertArchiveRows(
            client,
            filePath,
            header,
            tables,
            onProgress,
        );
        await setUserTriggers(client, tables, true);
        for (const foreignKey of foreignKeys) {
            await client.query(
                `ALTER TABLE public.${quoteIdent(foreignKey.table)} ADD CONSTRAINT ${quoteIdent(foreignKey.name)} ${foreignKey.definition}`,
            );
        }
        await restoreSequences(client, sequences, header.sequences);
        for (const index of vectorIndexes) {
            await client.query(
                `REINDEX INDEX public.${quoteIdent(index.name)}`,
            );
        }
        verifyCounts(header, inserted);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
}
