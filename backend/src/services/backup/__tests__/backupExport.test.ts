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
                return {
                    rows: [{ row: '{"id":"one"}', bytes: 12, ctid: null }],
                };
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
        const declare = sql.find((value) =>
            value.startsWith("DECLARE backup_rows"),
        );
        expect(declare).toContain("OFFSET 0");
        expect(declare).toContain("octet_length");
        expect(declare).toContain("tableoid");
        expect(declare).toContain("ctid");
        expect(sql).toContain("FETCH FORWARD 256 FROM backup_rows");
        expect(sql).toContain("CLOSE backup_rows");
    });

    it("fetches an oversized cursor row by tableoid and ctid and exports it", async () => {
        const oversizedRow = JSON.stringify({ value: "x".repeat(70_000) });
        client.query.mockImplementation(
            async (sql: string, parameters?: unknown[]) => {
                if (sql.includes("pg_try_advisory_lock")) {
                    return { rows: [{ acquired: true }] };
                }
                if (sql.includes("_prisma_migrations")) return { rows: [] };
                if (sql.includes("count(*)")) {
                    return { rows: [{ count: "1" }] };
                }
                if (sql.startsWith("FETCH")) {
                    return {
                        rows: [
                            {
                                row: null,
                                bytes: 70_012,
                                tableoid: "16422",
                                ctid: "(4,7)",
                            },
                        ],
                    };
                }
                if (
                    sql.includes(
                        "WHERE t.tableoid = $1::oid AND t.ctid = $2::tid",
                    )
                ) {
                    expect(parameters).toEqual(["16422", "(4,7)"]);
                    return { rows: [{ row: oversizedRow }] };
                }
                return { rows: [] };
            },
        );
        const { openBackupExport } = await import("../backupExport");
        const exporter = await openBackupExport({
            wrappedKey,
            macKey: Buffer.alloc(32, 1),
            appVersion: "test",
        });
        const output = new PassThrough();
        const chunks: Buffer[] = [];
        output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

        await exporter.streamTo(output);
        await exporter.close();

        const records = Buffer.concat(chunks)
            .toString("utf8")
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as { type: string; rows?: string });
        const rowRecord = records.find((record) => record.type === "rows");
        expect(JSON.parse(rowRecord?.rows ?? "[]")).toEqual([
            JSON.parse(oversizedRow),
        ]);
        expect(client.query).toHaveBeenCalledWith(
            expect.stringContaining(
                "WHERE t.tableoid = $1::oid AND t.ctid = $2::tid",
            ),
            ["16422", "(4,7)"],
        );
    });

    it("rejects a row above the record limit before fetching its ctid", async () => {
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) return { rows: [{ count: "1" }] };
            if (sql.startsWith("FETCH")) {
                return {
                    rows: [
                        {
                            row: null,
                            bytes: 16 * 1024 * 1024,
                            tableoid: "16422",
                            ctid: "(5,8)",
                        },
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
            "Table Example has a row larger than the backup record limit",
        );
        await exporter.close();
        expect(
            client.query.mock.calls.some(([sql]) =>
                String(sql).includes("WHERE t.tableoid = $1::oid"),
            ),
        ).toBe(false);
    });

    it("rejects when an oversized row changes before its ctid lookup", async () => {
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) return { rows: [{ count: "1" }] };
            if (sql.startsWith("FETCH")) {
                return {
                    rows: [
                        {
                            row: null,
                            bytes: 70_000,
                            tableoid: "16422",
                            ctid: "(6,9)",
                        },
                    ],
                };
            }
            if (sql.includes("WHERE t.tableoid = $1::oid")) return { rows: [] };
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
            "Table Example changed during backup",
        );
        await exporter.close();
    });

    it.each([undefined, "not-an-oid"])(
        "rejects invalid oversized-row tableoid metadata before lookup: %p",
        async (tableoid) => {
            client.query.mockImplementation(async (sql: string) => {
                if (sql.includes("pg_try_advisory_lock")) {
                    return { rows: [{ acquired: true }] };
                }
                if (sql.includes("_prisma_migrations")) return { rows: [] };
                if (sql.includes("count(*)")) {
                    return { rows: [{ count: "1" }] };
                }
                if (sql.startsWith("FETCH")) {
                    return {
                        rows: [
                            {
                                row: null,
                                bytes: 70_000,
                                tableoid,
                                ctid: "(7,10)",
                            },
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
                "Table Example changed during backup",
            );
            await exporter.close();
            expect(
                client.query.mock.calls.some(([sql]) =>
                    String(sql).includes("WHERE t.tableoid = $1::oid"),
                ),
            ).toBe(false);
        },
    );

    it.each([
        {
            bytes: "invalid",
            message: "Table Example returned an invalid row size",
        },
        {
            bytes: -1,
            message: "Table Example returned an invalid row size",
        },
        {
            bytes: 12,
            message: "Table Example returned an invalid cursor row",
        },
    ])("rejects invalid cursor metadata %#", async ({ bytes, message }) => {
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) {
                return { rows: [{ count: "1" }] };
            }
            if (sql.startsWith("FETCH")) {
                return { rows: [{ row: null, bytes, ctid: "(7,10)" }] };
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

        await expect(exporter.streamTo(output)).rejects.toThrow(message);
        await exporter.close();
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
        let settled = false;
        const outcome = streaming.then(
            () => {
                settled = true;
                return null;
            },
            (error: unknown) => {
                settled = true;
                return error;
            },
        );
        for (let attempt = 0; attempt < 20 && !fetchStarted; attempt += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(fetchStarted).toBeDefined();
        client.emit("error", new Error("connection terminated"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        fetchStarted?.();
        await expect(outcome).resolves.toMatchObject({
            message: "connection terminated",
        });
        await exporter.close();
        const sql = client.query.mock.calls.map(([value]) => String(value));
        expect(sql.indexOf("ROLLBACK")).toBeLessThan(
            sql.indexOf("SELECT pg_advisory_unlock($1)"),
        );
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
                const row = JSON.stringify({ value: "x".repeat(2048) });
                return {
                    rows: [{ row, bytes: Buffer.byteLength(row), ctid: null }],
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
            "Backup record for table Example exceeds the restore reader limit",
        );
        await exporter.close();
    });

    it("keeps the generic restore reader limit error for a header", async () => {
        jest.doMock("../backupFormat", () => {
            const actual = jest.requireActual("../backupFormat") as object;
            return { ...actual, MAX_BACKUP_RECORD_BYTES: 32 };
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
            "Backup record exceeds the restore reader limit",
        );
        await exporter.close();
    });

    it("splits batches so every encoded record stays under the record cap", async () => {
        const recordCap = 4 * 1024 * 1024 + 64 * 1024;
        jest.doMock("../backupFormat", () => {
            const actual = jest.requireActual("../backupFormat") as object;
            return { ...actual, MAX_BACKUP_RECORD_BYTES: recordCap };
        });
        const row = JSON.stringify({ value: "x".repeat(60 * 1024) });
        const cursorRows = Array.from({ length: 80 }, () => ({
            row,
            bytes: Buffer.byteLength(row),
            ctid: null,
        }));
        client.query.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("_prisma_migrations")) return { rows: [] };
            if (sql.includes("count(*)")) return { rows: [{ count: "80" }] };
            if (sql.startsWith("FETCH")) return { rows: cursorRows };
            return { rows: [] };
        });
        try {
            const { openBackupExport } = await import("../backupExport");
            const exporter = await openBackupExport({
                wrappedKey,
                macKey: Buffer.alloc(32, 1),
                appVersion: "test",
            });
            const output = new PassThrough();
            const chunks: Buffer[] = [];
            output.on("data", (chunk: Buffer) =>
                chunks.push(Buffer.from(chunk)),
            );

            await exporter.streamTo(output);
            await exporter.close();

            const records = Buffer.concat(chunks)
                .toString("utf8")
                .trimEnd()
                .split("\n");
            const rowRecords = records.filter(
                (line) =>
                    (JSON.parse(line) as { type?: string }).type === "rows",
            );
            expect(rowRecords).toHaveLength(2);
            expect(
                records.every(
                    (line) => Buffer.byteLength(`${line}\n`) <= recordCap,
                ),
            ).toBe(true);
        } finally {
            jest.dontMock("../backupFormat");
            jest.resetModules();
        }
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
                const row = `{"id":"one","meta'json":null}`;
                return {
                    rows: [{ row, bytes: Buffer.byteLength(row), ctid: null }],
                };
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
            let rejectSetup: ((error: Error) => void) | undefined;
            client.query.mockImplementation(async (sql: string) => {
                if (sql.includes("pg_try_advisory_lock")) {
                    return { rows: [{ acquired: true }] };
                }
                if (sql.startsWith("SET statement_timeout")) {
                    return new Promise((_resolve, reject) => {
                        rejectSetup = reject;
                    });
                }
                return { rows: [] };
            });
            client.end.mockImplementation(async () => {
                rejectSetup?.(new Error("connection terminated"));
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
            expect(client.end).toHaveBeenCalled();

            await rejected;
            await exporter.close();
        } finally {
            jest.useRealTimers();
        }
    });
});
