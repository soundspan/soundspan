import fs from "fs/promises";
import nodeFs from "fs";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import crypto from "crypto";
import {
    readBackupHeader,
    readBackupRecords,
    validateBackupArchive,
} from "../backupArchiveReader";
import {
    BACKUP_FORMAT_MAGIC,
    BACKUP_FORMAT_VERSION,
    encodeBackupRecord,
    type BackupHeader,
} from "../backupFormat";

const header: BackupHeader = {
    type: "header",
    magic: BACKUP_FORMAT_MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-10-19T12:00:00.000Z",
    appVersion: "2.6.1",
    wrappedKey: {
        salt: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
        iv: "MTIzNDU2Nzg5MDEy",
        tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
        ciphertext: "aw==",
    },
    migrations: [],
    tables: [],
    sequences: [],
};

const macKey = Buffer.alloc(32, 7);

function archive(...records: string[]): Buffer {
    const body = records.join("");
    const mac = crypto
        .createHmac("sha256", macKey)
        .update(body)
        .digest("base64");
    return gzipSync(body + encodeBackupRecord({ type: "end", mac }));
}

describe("backup archive reader", () => {
    let directory: string;

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "backup-reader-"));
    });

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    async function write(name: string, bytes: Buffer): Promise<string> {
        const filePath = path.join(directory, name);
        await fs.writeFile(filePath, bytes);
        return filePath;
    }

    it("reads a complete archive", async () => {
        const filePath = await write(
            "valid",
            archive(encodeBackupRecord(header)),
        );
        await expect(validateBackupArchive(filePath, macKey)).resolves.toEqual({
            header,
            rows: 0,
        });
    });

    it("stops validation when its abort signal is already cancelled", async () => {
        const filePath = await write(
            "cancelled",
            archive(encodeBackupRecord(header)),
        );
        const controller = new AbortController();
        controller.abort(new Error("connection lost"));

        await expect(
            validateBackupArchive(filePath, macKey, controller.signal),
        ).rejects.toThrow("connection lost");
    });

    it("rejects a truncated gzip stream", async () => {
        const complete = gzipSync(encodeBackupRecord(header));
        const filePath = await write(
            "truncated",
            complete.subarray(0, complete.length - 4),
        );
        const consume = async () => {
            for await (const _record of readBackupRecords(filePath)) {
                // Consume through the gzip trailer so truncation is observed.
            }
        };
        await expect(consume()).rejects.toThrow();
    });

    it("rejects a missing end record", async () => {
        const filePath = await write(
            "missing-end",
            gzipSync(encodeBackupRecord(header)),
        );
        await expect(validateBackupArchive(filePath, macKey)).rejects.toThrow(
            "end record",
        );
    });

    it("rejects trailing records", async () => {
        const body = encodeBackupRecord(header);
        const mac = crypto
            .createHmac("sha256", macKey)
            .update(body)
            .digest("base64");
        const filePath = await write(
            "trailing",
            gzipSync(
                body +
                    encodeBackupRecord({ type: "end", mac }) +
                    encodeBackupRecord({ type: "end", mac }),
            ),
        );
        await expect(validateBackupArchive(filePath, macKey)).rejects.toThrow(
            "trailing",
        );
    });

    it("rejects a tampered row before restore", async () => {
        const rows = encodeBackupRecord({
            type: "rows",
            table: "User",
            rowCount: 1,
            rows: '[{"id":"safe"}]',
        });
        const withTable = {
            ...header,
            tables: [
                {
                    name: "User",
                    columns: [{ name: "id", type: "text" }],
                    rowCount: 1,
                },
            ],
        };
        const bytes = archive(encodeBackupRecord(withTable), rows);
        const filePath = await write(
            "tampered",
            Buffer.from(bytes.toString("base64"), "base64"),
        );
        const clear = (await import("zlib"))
            .gunzipSync(await fs.readFile(filePath))
            .toString("utf8")
            .replace("safe", "evil");
        await fs.writeFile(filePath, gzipSync(clear));
        await expect(
            validateBackupArchive(filePath, macKey),
        ).rejects.toMatchObject({ code: "BACKUP_FORMAT_INVALID" });
    });

    it("destroys the source when a consumer stops after the header", async () => {
        const originalCreateReadStream = nodeFs.createReadStream;
        let source: nodeFs.ReadStream | undefined;
        jest.spyOn(nodeFs, "createReadStream").mockImplementation(((
            ...args: Parameters<typeof nodeFs.createReadStream>
        ) => {
            source = originalCreateReadStream(...args);
            return source;
        }) as typeof nodeFs.createReadStream);
        const filePath = await write(
            "early",
            archive(encodeBackupRecord(header)),
        );
        const iterator = readBackupRecords(filePath);
        await iterator.next();
        await iterator.return(undefined);
        expect(source?.destroyed).toBe(true);
    });

    it("rejects a line larger than the configured bound", async () => {
        const filePath = await write(
            "oversized",
            gzipSync(`${"x".repeat(65)}\n`),
        );
        await expect(readBackupRecords(filePath, 64).next()).rejects.toThrow(
            "size limit",
        );
    });

    it("caps the header record at four MiB", async () => {
        const filePath = await write(
            "oversized-header",
            gzipSync(`${"x".repeat(4 * 1024 * 1024 + 1)}\n`),
        );
        await expect(readBackupHeader(filePath)).rejects.toMatchObject({
            code: "BACKUP_FORMAT_INVALID",
        });
    });
});
