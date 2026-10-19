import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";

let maxFinishedListeners = 0;
const gzipStreams: PassThrough[] = [];
jest.mock("zlib", () => {
    const actual = jest.requireActual("zlib") as typeof import("zlib");
    return {
        ...actual,
        createGzip: () => {
            const stream = new PassThrough();
            const write = stream.write.bind(stream);
            stream.write = ((...args: Parameters<typeof stream.write>) => {
                maxFinishedListeners = Math.max(
                    maxFinishedListeners,
                    stream.listenerCount("finish"),
                    stream.listenerCount("error"),
                    stream.listenerCount("close"),
                );
                write(...args);
                setImmediate(() => stream.emit("drain"));
                return false;
            }) as typeof stream.write;
            gzipStreams.push(stream);
            return stream;
        },
    };
});

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
        maxFinishedListeners = 0;
        gzipStreams.splice(0, gzipStreams.length);
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

    it("reuses one completion listener set across repeated backpressure", async () => {
        readApplicationTables.mockResolvedValue(
            Array.from({ length: 20 }, (_, index) => ({
                name: `Example${index}`,
                columns: [{ name: "id", type: "text" }],
                generatedColumns: [],
            })),
        );
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

        expect(maxFinishedListeners).toBeLessThanOrEqual(4);
    });

    it("destroys and observes the output pipeline when setup queries fail", async () => {
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.startsWith("SET statement_timeout")) {
                throw new Error("session setup failed");
            }
            if (sql === "ROLLBACK") throw new Error("rollback failed");
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
            "session setup failed",
        );

        expect(gzipStreams[0]?.destroyed).toBe(true);
        expect(client.query).toHaveBeenCalledWith("ROLLBACK");
        await exporter.close();
    });

    it("exports migration metadata and wraps JSON columns while excluding generated columns", async () => {
        readApplicationTables.mockResolvedValue([
            {
                name: "JsonExample",
                columns: [
                    { name: "id", type: "text" },
                    { name: "meta'json", type: "jsonb" },
                ],
                generatedColumns: ["search'column"],
            },
        ]);
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) {
                return {
                    rows: [{ migration_name: "001_init", checksum: "sum" }],
                };
            }
            if (sql.includes("count(*)")) return { rows: [{ count: "1" }] };
            if (sql.startsWith("FETCH")) {
                return { rows: [{ row: `{"id":"one","meta'json":null}` }] };
            }
            if (sql === "CLOSE backup_rows") throw new Error("already closed");
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

        await exporter.streamTo(output);
        await exporter.close();

        const declare = client.query.mock.calls
            .map(([sql]) => String(sql))
            .find((sql) => sql.startsWith("DECLARE backup_rows"));
        expect(declare).toContain("search''column");
        expect(declare).toContain("meta''json");
        expect(declare).toContain("jsonb_build_array");
    });

    it("rejects unsafe table row counts", async () => {
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) {
                return { rows: [{ count: "9007199254740993" }] };
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
            "row count exceeds",
        );
        await exporter.close();
    });

    it("releases a failed lock acquisition and reports backup busy", async () => {
        client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
        client.end.mockRejectedValueOnce(new Error("already closed"));
        const { openBackupExport } = await import("../backupExport");

        await expect(
            openBackupExport({
                wrappedKey,
                macKey: Buffer.alloc(32, 1),
                appVersion: "test",
            }),
        ).rejects.toMatchObject({ code: "BACKUP_IN_PROGRESS" });
    });

    it("probes both busy and available export-lock states", async () => {
        const { isBackupExportBusy } = await import("../backupExport");
        client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
        await expect(isBackupExportBusy()).resolves.toBe(true);

        client.query
            .mockResolvedValueOnce({ rows: [{ acquired: true }] })
            .mockResolvedValueOnce({ rows: [] });
        await expect(isBackupExportBusy()).resolves.toBe(false);
    });

    it("fails an export-lock probe after an asynchronous client error", async () => {
        const { isBackupExportBusy } = await import("../backupExport");
        client.query.mockImplementationOnce(async () => {
            client.emit("error", new Error("probe connection lost"));
            return { rows: [{ acquired: true }] };
        });

        await expect(isBackupExportBusy()).rejects.toThrow(
            "probe connection lost",
        );
    });

    it("ignores advisory-unlock failure while closing idempotently", async () => {
        const { openBackupExport } = await import("../backupExport");
        const exporter = await openBackupExport({
            wrappedKey,
            macKey: Buffer.alloc(32, 1),
            appVersion: "test",
        });
        client.query.mockRejectedValueOnce(new Error("unlock failed"));
        client.end.mockRejectedValueOnce(new Error("already closed"));

        await expect(exporter.close()).resolves.toBeUndefined();
        await expect(exporter.close()).resolves.toBeUndefined();
    });

    it("closes the database client when an export reaches its deadline", async () => {
        jest.useFakeTimers();
        try {
            client.query.mockImplementation(async (sql: string) => {
                if (sql.includes("pg_try_advisory_lock")) {
                    return { rows: [{ acquired: true }] };
                }
                if (sql.startsWith("SET statement_timeout")) {
                    return new Promise(() => undefined);
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
            const rejected = expect(streaming).rejects.toThrow(
                "connection terminated",
            );

            await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
            expect(client.end).toHaveBeenCalledTimes(1);
            client.emit("error", new Error("connection terminated"));

            await rejected;
            await exporter.close();
        } finally {
            jest.useRealTimers();
        }
    });
});
