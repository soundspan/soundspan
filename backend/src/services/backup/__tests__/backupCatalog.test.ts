import type { Client } from "pg";
import {
    quoteIdent,
    readApplicationTables,
    readForeignKeys,
    readOwnedSequences,
    readVectorIndexes,
} from "../backupCatalog";

function clientWith(results: unknown[]): Client {
    return {
        query: jest.fn(async () => results.shift()),
    } as unknown as Client;
}

describe("backup catalog", () => {
    it("quotes catalog-owned identifiers and groups ordinary and generated columns", async () => {
        const client = clientWith([
            {
                rows: [
                    {
                        table_name: 'Album"Data',
                        column_name: "id",
                        type_name: "text",
                        ordinal: 1,
                        generated: false,
                    },
                    {
                        table_name: 'Album"Data',
                        column_name: "search",
                        type_name: "tsvector",
                        ordinal: 2,
                        generated: true,
                    },
                    {
                        table_name: "Empty",
                        column_name: null,
                        type_name: null,
                        ordinal: null,
                        generated: null,
                    },
                ],
            },
        ]);

        await expect(readApplicationTables(client)).resolves.toEqual([
            {
                name: 'Album"Data',
                columns: [{ name: "id", type: "text" }],
                generatedColumns: ["search"],
            },
            { name: "Empty", columns: [], generatedColumns: [] },
        ]);
        expect(quoteIdent('a"b')).toBe('"a""b"');
    });

    it("rejects catalogs beyond the format column bound", async () => {
        const rows = Array.from({ length: 10_001 }, (_, index) => ({
            table_name: "Wide",
            column_name: `column_${index}`,
            type_name: "text",
            ordinal: index + 1,
            generated: false,
        }));
        await expect(
            readApplicationTables(clientWith([{ rows }])),
        ).rejects.toThrow("catalog exceeds");
    });

    it("reads states only for sequences owned by exported tables", async () => {
        const client = clientWith([
            {
                rows: [
                    {
                        sequence_name: 'kept"seq',
                        table_name: "Kept",
                        column_name: "id",
                    },
                    {
                        sequence_name: "ignored_seq",
                        table_name: "Ignored",
                        column_name: "id",
                    },
                    {
                        sequence_name: "empty_seq",
                        table_name: "Kept",
                        column_name: "other",
                    },
                ],
            },
            { rows: [{ last_value: "19", is_called: true }] },
            { rows: [] },
        ]);

        await expect(
            readOwnedSequences(client, [
                { name: "Kept", columns: [], generatedColumns: [] },
            ]),
        ).resolves.toEqual([
            {
                name: 'kept"seq',
                table: "Kept",
                column: "id",
                lastValue: "19",
                isCalled: true,
            },
        ]);
        const query = client.query as jest.Mock;
        expect(query.mock.calls[1][0]).toContain('public."kept""seq"');
        expect(query).toHaveBeenCalledTimes(3);
    });

    it("maps foreign keys and vector indexes from catalog rows", async () => {
        const foreignClient = clientWith([
            {
                rows: [
                    {
                        table_name: "Track",
                        constraint_name: "Track_albumId_fkey",
                        definition:
                            'FOREIGN KEY ("albumId") REFERENCES "Album"(id)',
                    },
                ],
            },
        ]);
        await expect(readForeignKeys(foreignClient)).resolves.toEqual([
            {
                table: "Track",
                name: "Track_albumId_fkey",
                definition: 'FOREIGN KEY ("albumId") REFERENCES "Album"(id)',
            },
        ]);

        const indexClient = clientWith([
            {
                rows: [
                    {
                        table_name: "track_embeddings",
                        index_name: "embedding_idx",
                    },
                ],
            },
        ]);
        await expect(readVectorIndexes(indexClient)).resolves.toEqual([
            { table: "track_embeddings", name: "embedding_idx" },
        ]);
    });
});
