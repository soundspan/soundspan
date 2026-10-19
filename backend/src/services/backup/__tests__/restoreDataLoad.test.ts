import type { Client } from "pg";
import type { BackupHeader, BackupRowsRecord } from "../backupFormat";

const records: BackupRowsRecord[] = [];
const readApplicationTables = jest.fn();
const readForeignKeys = jest.fn();
const readOwnedSequences = jest.fn();
const readVectorIndexes = jest.fn();

jest.mock("../backupArchiveReader", () => ({
    readBackupRecords: async function* () {
        for (const record of records) yield record;
    },
}));
jest.mock("../backupCatalog", () => {
    const actual = jest.requireActual("../backupCatalog") as object;
    return {
        ...actual,
        readApplicationTables,
        readForeignKeys,
        readOwnedSequences,
        readVectorIndexes,
    };
});

import { loadBackupData } from "../restoreDataLoad";

const tables = [
    {
        name: 'Track"Data',
        columns: [
            { name: "id", type: "text" },
            { name: "metadata", type: "jsonb" },
        ],
        generatedColumns: [],
    },
];

const header: BackupHeader = {
    type: "header",
    magic: "soundspan-backup",
    formatVersion: 1,
    createdAt: "2026-10-19T12:00:00.000Z",
    appVersion: "2.6.1",
    wrappedKey: {
        salt: "YQ==",
        iv: "YQ==",
        tag: "YQ==",
        ciphertext: "YQ==",
    },
    migrations: [],
    tables: [
        {
            name: 'Track"Data',
            columns: [
                { name: "id", type: "text" },
                { name: "metadata", type: "jsonb" },
            ],
            rowCount: 1,
        },
    ],
    sequences: [
        {
            name: "Track_seq",
            table: 'Track"Data',
            column: "id",
            lastValue: "7",
            isCalled: true,
        },
    ],
};

function createClient(failOn?: string): {
    client: Client;
    queries: Array<{ sql: string; params?: unknown[] }>;
} {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            queries.push({ sql, params });
            if (failOn && sql.includes(failOn)) throw new Error(failOn);
            if (sql.includes("INSERT INTO")) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        }),
    } as unknown as Client;
    return { client, queries };
}

describe("restore data load", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        records.splice(0, records.length, {
            type: "rows",
            table: 'Track"Data',
            rowCount: 1,
            rows: '[{"id":"track-1","metadata":{"metadata":[null]}}]',
        });
        readApplicationTables.mockResolvedValue(tables);
        readForeignKeys.mockResolvedValue([
            {
                table: 'Track"Data',
                name: 'fk"album',
                definition: 'FOREIGN KEY ("id") REFERENCES "Album"("id")',
            },
        ]);
        readOwnedSequences.mockResolvedValue([
            { name: "Track_seq", table: 'Track"Data', column: "id" },
        ]);
        readVectorIndexes.mockResolvedValue([
            { table: 'Track"Data', name: 'track"vector' },
        ]);
    });

    it("runs the destructive load in order with one lateral record expansion", async () => {
        const { client, queries } = createClient();
        const progress = jest.fn();
        const beforeCommit = jest.fn(async (transactionClient: Client) => {
            expect(transactionClient).toBe(client);
            await transactionClient.query("SELECT admin_check");
            await transactionClient.query("UPDATE encrypted_credentials");
        });

        await loadBackupData(
            client,
            "/tmp/archive",
            header,
            progress,
            beforeCommit,
        );

        const sql = queries.map((entry) => entry.sql);
        const positions = [
            "BEGIN",
            "TRUNCATE TABLE",
            "DROP CONSTRAINT",
            "DISABLE TRIGGER USER",
            "INSERT INTO",
            "ENABLE TRIGGER USER",
            "ADD CONSTRAINT",
            "SELECT setval",
            "REINDEX INDEX",
            "SELECT admin_check",
            "UPDATE encrypted_credentials",
            "COMMIT",
        ].map((fragment) => sql.findIndex((value) => value.includes(fragment)));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect(positions).toEqual(
            [...positions].sort((left, right) => left - right),
        );

        const insert = queries.find((entry) =>
            entry.sql.includes("INSERT INTO"),
        );
        expect(insert?.sql.match(/jsonb_populate_record/g)).toHaveLength(1);
        expect(insert?.sql).toContain(
            'CROSS JOIN LATERAL jsonb_populate_record(NULL::public."Track""Data", e) AS r',
        );
        expect(insert?.sql).toContain('r."id"');
        expect(insert?.sql).toContain("e->'metadata'");
        expect(insert?.params).toEqual([records[0]?.rows]);
        expect(sql.join("\n")).toContain('public."Track""Data"');
        expect(sql.join("\n")).toContain('"fk""album"');
        expect(sql.join("\n")).toContain('"track""vector"');
        expect(progress).toHaveBeenCalledWith({
            completedTables: 1,
            totalTables: 1,
            completedRows: 1,
            totalRows: 1,
        });
    });

    it("rejects type drift before locking or loading tables", async () => {
        readApplicationTables.mockResolvedValue([
            {
                ...tables[0],
                columns: [
                    { name: "id", type: "uuid" },
                    { name: "metadata", type: "jsonb" },
                ],
            },
        ]);
        const { client, queries } = createClient();

        await expect(
            loadBackupData(client, "/tmp/archive", header, jest.fn()),
        ).rejects.toMatchObject({
            code: "BACKUP_SCHEMA_MISMATCH",
            message: expect.stringContaining('Track"Data.id type text != uuid'),
        });
        expect(queries.map(({ sql }) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    });

    it.each([
        "LOCK TABLE",
        "DROP CONSTRAINT",
        "DISABLE TRIGGER USER",
        "INSERT INTO",
        "ENABLE TRIGGER USER",
        "ADD CONSTRAINT",
        "SELECT setval",
        "REINDEX INDEX",
        "admin_check",
        "COMMIT",
    ])("rolls back when %s fails", async (fragment) => {
        const { client, queries } = createClient(fragment);
        await expect(
            loadBackupData(
                client,
                "/tmp/archive",
                header,
                jest.fn(),
                async (transactionClient) => {
                    await transactionClient.query("SELECT admin_check");
                },
            ),
        ).rejects.toThrow(fragment);
        expect(queries.at(-1)?.sql).toBe("ROLLBACK");
    });

    it("rejects unknown row tables and row-count drift", async () => {
        const { client } = createClient();
        records[0] = { ...records[0]!, table: "Unknown" };
        await expect(
            loadBackupData(client, "/tmp/archive", header, jest.fn()),
        ).rejects.toMatchObject({ code: "BACKUP_SCHEMA_MISMATCH" });

        records.splice(0, records.length);
        const second = createClient();
        await expect(
            loadBackupData(second.client, "/tmp/archive", header, jest.fn()),
        ).rejects.toMatchObject({ code: "BACKUP_ROW_COUNT_MISMATCH" });
    });
});
