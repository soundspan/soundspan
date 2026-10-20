import type { Client } from "pg";

export interface CatalogColumn {
    name: string;
    type: string;
}

export interface CatalogTable {
    name: string;
    columns: CatalogColumn[];
    generatedColumns: string[];
}

export interface CatalogSequence {
    name: string;
    table: string;
    column: string;
    lastValue: string;
    isCalled: boolean;
}

export interface CatalogForeignKey {
    table: string;
    name: string;
    definition: string;
}

export interface CatalogIndex {
    table: string;
    name: string;
}

/** Quote an identifier that has already been obtained from PostgreSQL's catalog. */
export function quoteIdent(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

export async function readApplicationTables(
    client: Client,
): Promise<CatalogTable[]> {
    const result = await client.query<{
        table_name: string;
        column_name: string | null;
        type_name: string | null;
        ordinal: number | null;
        generated: boolean | null;
    }>(`
        SELECT c.relname AS table_name,
               a.attname AS column_name,
               format_type(a.atttypid, a.atttypmod) AS type_name,
               a.attnum AS ordinal,
               a.attgenerated <> '' AS generated
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attribute a
            ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND c.relname <> '_prisma_migrations'
           AND NOT EXISTS (
               SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_class'::regclass
                  AND d.objid = c.oid AND d.deptype = 'e'
           )
         ORDER BY c.relname, a.attnum
    `);
    const tables = new Map<
        string,
        { columns: CatalogColumn[]; generatedColumns: string[] }
    >();
    for (const row of result.rows) {
        const table = tables.get(row.table_name) ?? {
            columns: [],
            generatedColumns: [],
        };
        if (row.column_name !== null && row.type_name !== null) {
            if (row.generated) table.generatedColumns.push(row.column_name);
            else
                table.columns.push({
                    name: row.column_name,
                    type: row.type_name,
                });
        }
        tables.set(row.table_name, table);
    }
    const catalog = [...tables].map(([name, table]) => ({ name, ...table }));
    if (
        catalog.length > 10_000 ||
        catalog.some(
            (table) =>
                table.columns.length + table.generatedColumns.length > 10_000,
        )
    ) {
        throw new Error("Application catalog exceeds the backup format limits");
    }
    return catalog;
}

export async function readOwnedSequences(
    client: Client,
    tables: CatalogTable[],
): Promise<CatalogSequence[]> {
    const result = await client.query<{
        sequence_name: string;
        table_name: string;
        column_name: string;
    }>(`
        SELECT seq.relname AS sequence_name, tab.relname AS table_name,
               attr.attname AS column_name
          FROM pg_class seq
          JOIN pg_namespace n ON n.oid = seq.relnamespace
          JOIN pg_depend dep ON dep.classid = 'pg_class'::regclass
              AND dep.objid = seq.oid AND dep.deptype IN ('a', 'i')
          JOIN pg_class tab ON tab.oid = dep.refobjid
          JOIN pg_attribute attr ON attr.attrelid = tab.oid
              AND attr.attnum = dep.refobjsubid
         WHERE n.nspname = 'public' AND seq.relkind = 'S'
         ORDER BY seq.relname
    `);
    const tableNames = new Set(tables.map((table) => table.name));
    const sequences: CatalogSequence[] = [];
    for (const row of result.rows) {
        if (!tableNames.has(row.table_name)) continue;
        const value = await client.query<{
            last_value: string;
            is_called: boolean;
        }>(
            `SELECT last_value::text, is_called FROM public.${quoteIdent(row.sequence_name)}`,
        );
        const state = value.rows[0];
        if (!state) continue;
        sequences.push({
            name: row.sequence_name,
            table: row.table_name,
            column: row.column_name,
            lastValue: state.last_value,
            isCalled: state.is_called,
        });
    }
    return sequences;
}

export async function readForeignKeys(
    client: Client,
): Promise<CatalogForeignKey[]> {
    const result = await client.query<{
        table_name: string;
        constraint_name: string;
        definition: string;
    }>(`
        SELECT rel.relname AS table_name, con.conname AS constraint_name,
               pg_get_constraintdef(con.oid, true) AS definition
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname = 'public' AND con.contype = 'f'
         ORDER BY rel.relname, con.conname
    `);
    return result.rows.map((row) => ({
        table: row.table_name,
        name: row.constraint_name,
        definition: row.definition,
    }));
}

export async function readVectorIndexes(
    client: Client,
): Promise<CatalogIndex[]> {
    const result = await client.query<{
        table_name: string;
        index_name: string;
    }>(`
        SELECT tab.relname AS table_name, idx.relname AS index_name
          FROM pg_index i
          JOIN pg_class idx ON idx.oid = i.indexrelid
          JOIN pg_class tab ON tab.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = tab.relnamespace
          JOIN pg_am am ON am.oid = idx.relam
         WHERE n.nspname = 'public' AND am.amname IN ('ivfflat', 'hnsw')
         ORDER BY idx.relname
    `);
    return result.rows.map((row) => ({
        table: row.table_name,
        name: row.index_name,
    }));
}
