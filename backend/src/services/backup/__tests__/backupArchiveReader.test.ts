import fs from "fs/promises";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import {
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
    pepperFingerprint: null,
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
            gzipSync(
                encodeBackupRecord(header) +
                    encodeBackupRecord({ type: "end" }),
            ),
        );
        await expect(validateBackupArchive(filePath)).resolves.toEqual({
            header,
            rows: 0,
        });
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
        await expect(validateBackupArchive(filePath)).rejects.toThrow(
            "end record",
        );
    });

    it("rejects trailing records", async () => {
        const filePath = await write(
            "trailing",
            gzipSync(
                encodeBackupRecord(header) +
                    encodeBackupRecord({ type: "end" }) +
                    encodeBackupRecord({ type: "end" }),
            ),
        );
        await expect(validateBackupArchive(filePath)).rejects.toThrow(
            "trailing",
        );
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
});
