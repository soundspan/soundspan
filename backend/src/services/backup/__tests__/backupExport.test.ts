import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";

const client = Object.assign(new EventEmitter(), {
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
});
const readApplicationTables = jest.fn();
const readOwnedSequences = jest.fn();

jest.mock("pg", () => ({ Client: jest.fn(() => client) }));
jest.mock("../../../config", () => ({
    config: { databaseUrl: "postgresql://backup/database" },
}));
jest.mock("../backupCatalog", () => ({
    quoteIdent: (value: string) => `"${value}"`,
    readApplicationTables,
    readOwnedSequences,
}));

const wrappedKey = {
    salt: Buffer.alloc(16).toString("base64"),
    iv: Buffer.alloc(12).toString("base64"),
    tag: Buffer.alloc(16).toString("base64"),
    ciphertext: Buffer.from("payload").toString("base64"),
};

describe("backup export streaming", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.dontMock("../backupFormat");
        jest.clearAllMocks();
        client.connect.mockResolvedValue(undefined);
        client.end.mockResolvedValue(undefined);
        readApplicationTables.mockResolvedValue([
            {
                name: "Example",
                columns: [{ name: "id", type: "text" }],
                generatedColumns: [],
            },
        ]);
        readOwnedSequences.mockResolvedValue([]);
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) return { rows: [{ count: "1" }] };
            if (sql.startsWith("FETCH")) {
                return { rows: [{ row: '{"id":"one"}' }] };
            }
            return { rows: [] };
        });
    });

    it("uses a server-side cursor without a whole-table row-number sort", async () => {
        const { openBackupExport } = await import("../backupExport");
        const exporter = await openBackupExport({
            wrappedKey,
            macKey: Buffer.alloc(32, 1),
            appVersion: "test",
        });
        const output = new PassThrough();
        output.resume();
        await exporter.streamTo(output);
        await exporter.close();
        const sql = client.query.mock.calls.map(([value]) => String(value));
        expect(
            sql.some((value) => value.startsWith("DECLARE backup_rows")),
        ).toBe(true);
        expect(sql.some((value) => value.includes("row_number()"))).toBe(false);
        expect(sql).toContain("FETCH FORWARD 500 FROM backup_rows");
        expect(sql).toContain("CLOSE backup_rows");
    });

    it("fails the export when the dedicated client emits an error", async () => {
        let fetchStarted: (() => void) | undefined;
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) return { rows: [{ count: "1" }] };
            if (sql.startsWith("FETCH")) {
                return new Promise((resolve) => {
                    fetchStarted = () => resolve({ rows: [] });
                });
            }
            return { rows: [] };
        });
        const { openBackupExport } = await import("../backupExport");
        const exporter = await openBackupExport({
            wrappedKey,
            macKey: Buffer.alloc(32, 1),
            appVersion: "test",
        });
        const output = new PassThrough();
        output.resume();
        const streaming = exporter.streamTo(output);
        await new Promise<void>((resolve) => setImmediate(resolve));
        client.emit("error", new Error("connection terminated"));
        await expect(streaming).rejects.toThrow("connection terminated");
        fetchStarted?.();
        await exporter.close();
    });

    it("rejects promptly when the destination is destroyed", async () => {
        const { openBackupExport } = await import("../backupExport");
        const exporter = await openBackupExport({
            wrappedKey,
            macKey: Buffer.alloc(32, 1),
            appVersion: "test",
        });
        const output = new Writable({
            write(_chunk, _encoding, callback) {
                callback(new Error("client disconnected"));
            },
        });
        await expect(exporter.streamTo(output)).rejects.toThrow();
        await exporter.close();
        expect(client.end).toHaveBeenCalled();
    });

    it("rejects a record larger than the restore reader limit", async () => {
        jest.doMock("../backupFormat", () => {
            const actual = jest.requireActual("../backupFormat") as object;
            return { ...actual, MAX_BACKUP_RECORD_BYTES: 1024 };
        });
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) return { rows: [{ count: "1" }] };
            if (sql.startsWith("FETCH")) {
                return {
                    rows: [
                        { row: JSON.stringify({ value: "x".repeat(2048) }) },
                    ],
                };
            }
            return { rows: [] };
        });
        const { openBackupExport } = await import("../backupExport");
        const exporter = await openBackupExport({
            wrappedKey,
            macKey: Buffer.alloc(32, 1),
            appVersion: "test",
        });
        const output = new PassThrough();
        output.resume();
        await expect(exporter.streamTo(output)).rejects.toThrow(
            "restore reader limit",
        );
        await exporter.close();
    });
});
