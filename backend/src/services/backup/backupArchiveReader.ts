import fs from "fs";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import {
    MAX_BACKUP_EXPANSION_RATIO,
    MAX_BACKUP_RECORD_BYTES,
    MIN_BACKUP_DECOMPRESSED_LIMIT_BYTES,
    parseBackupRecord,
    type BackupHeader,
    type BackupRecord,
} from "./backupFormat";
import { BackupFormatError } from "./backupErrors";
import { BoundedLineSplitter } from "./backupLineSplitter";

const NEWLINE = Buffer.from("\n");

async function maximumDecompressedBytes(filePath: string): Promise<number> {
    try {
        const { size } = await fs.promises.stat(filePath);
        return Math.min(
            Number.MAX_SAFE_INTEGER,
            Math.max(
                MIN_BACKUP_DECOMPRESSED_LIMIT_BYTES,
                size * MAX_BACKUP_EXPANSION_RATIO,
            ),
        );
    } catch (cause) {
        throw new BackupFormatError("Backup archive is truncated or invalid", {
            cause,
        });
    }
}

/** Stream and parse all records from a gzip-compressed archive. */
export async function* readBackupRecords(
    filePath: string,
    maximumRecordBytes = MAX_BACKUP_RECORD_BYTES,
    signal?: AbortSignal,
): AsyncGenerator<BackupRecord> {
    signal?.throwIfAborted();
    for await (const item of readBackupRecordLines(
        filePath,
        maximumRecordBytes,
        signal,
    )) {
        yield item.record;
    }
}

async function* readBackupRecordLines(
    filePath: string,
    maximumRecordBytes: number,
    signal?: AbortSignal,
): AsyncGenerator<{ record: BackupRecord; bytes: Buffer }> {
    signal?.throwIfAborted();
    const maximumTotalBytes = await maximumDecompressedBytes(filePath);
    const source = fs.createReadStream(filePath);
    const gunzip = createGunzip();
    const stream = new BoundedLineSplitter({
        maximumLineBytes: maximumRecordBytes,
        maximumTotalBytes,
    });
    const completion = pipeline(source, gunzip, stream, { signal });
    let consumed = false;
    try {
        for await (const line of stream) {
            signal?.throwIfAborted();
            if (!Buffer.isBuffer(line)) {
                throw new BackupFormatError("Backup record is invalid");
            }
            yield {
                record: parseBackupRecord(line.toString("utf8")),
                bytes: line,
            };
        }
        await completion;
        consumed = true;
    } catch (cause) {
        if (cause instanceof BackupFormatError) throw cause;
        throw new BackupFormatError("Backup archive is truncated or invalid", {
            cause,
        });
    } finally {
        source.destroy();
        gunzip.destroy();
        stream.destroy();
        if (!consumed) await completion.catch(() => undefined);
    }
}

/** Read only the first bounded record and require it to be a header. */
export async function readBackupHeader(
    filePath: string,
): Promise<BackupHeader> {
    for await (const record of readBackupRecords(filePath, 4 * 1024 * 1024)) {
        if (record.type !== "header") {
            throw new BackupFormatError("Backup header is missing");
        }
        return record;
    }
    throw new BackupFormatError("Backup is empty");
}

export interface ArchiveValidation {
    header: BackupHeader;
    rows: number;
}

function verifyArchiveCounts(
    header: BackupHeader,
    counts: Map<string, number>,
): number {
    let totalRows = 0;
    for (const table of header.tables) {
        const actual = counts.get(table.name) ?? 0;
        if (actual !== table.rowCount) {
            throw new BackupFormatError(
                `Backup row count mismatch for ${table.name}`,
            );
        }
        totalRows += actual;
        counts.delete(table.name);
    }
    if (counts.size !== 0) {
        throw new BackupFormatError(
            "Backup contains rows for an unknown table",
        );
    }
    return totalRows;
}

/** Validate full framing and exact per-table row counts before destructive work. */
export async function validateBackupArchive(
    filePath: string,
    macKey: Buffer,
    signal?: AbortSignal,
): Promise<ArchiveValidation> {
    signal?.throwIfAborted();
    let header: BackupHeader | null = null;
    let ended = false;
    const counts = new Map<string, number>();
    const hmac = crypto.createHmac("sha256", macKey);
    for await (const item of readBackupRecordLines(
        filePath,
        MAX_BACKUP_RECORD_BYTES,
        signal,
    )) {
        const { record } = item;
        if (ended) throw new BackupFormatError("Backup has trailing data");
        if (!header) {
            if (record.type !== "header") {
                throw new BackupFormatError("Backup header is missing");
            }
            header = record;
            hmac.update(item.bytes);
            hmac.update(NEWLINE);
            continue;
        }
        if (record.type === "header") {
            throw new BackupFormatError("Backup contains multiple headers");
        }
        if (record.type === "end") {
            verifyArchiveMac(hmac.digest(), record.mac);
            ended = true;
            continue;
        }
        hmac.update(item.bytes);
        hmac.update(NEWLINE);
        const nextCount = (counts.get(record.table) ?? 0) + record.rowCount;
        if (!Number.isSafeInteger(nextCount)) {
            throw new BackupFormatError(
                "Backup row count exceeds the safe limit",
            );
        }
        counts.set(record.table, nextCount);
    }
    if (!header || !ended)
        throw new BackupFormatError("Backup end record is missing");
    return { header, rows: verifyArchiveCounts(header, counts) };
}

function verifyArchiveMac(actual: Buffer, encoded: string): void {
    const expected = Buffer.from(encoded, "base64");
    if (
        expected.length !== actual.length ||
        !crypto.timingSafeEqual(actual, expected)
    ) {
        throw new BackupFormatError("Backup archive authentication failed");
    }
}
