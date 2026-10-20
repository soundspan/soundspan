import fs from "fs";
import crypto from "crypto";
import { Transform, type TransformCallback } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import {
    MAX_BACKUP_RECORD_BYTES,
    parseBackupRecord,
    type BackupHeader,
    type BackupRecord,
} from "./backupFormat";
import { BackupFormatError } from "./backupErrors";

class BoundedLineSplitter extends Transform {
    private readonly parts: Buffer[] = [];
    private bufferedBytes = 0;

    constructor(private readonly maximumBytes = MAX_BACKUP_RECORD_BYTES) {
        super({ readableObjectMode: true });
    }

    override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback,
    ): void {
        try {
            this.consumeChunk(chunk);
            callback();
        } catch (error) {
            callback(error as Error);
        }
    }

    override _flush(callback: TransformCallback): void {
        if (this.bufferedBytes !== 0) {
            callback(
                new BackupFormatError(
                    "Backup record is not newline terminated",
                ),
            );
            return;
        }
        callback();
    }

    private addPart(part: Buffer): void {
        if (part.length === 0) return;
        this.parts.push(part);
        this.bufferedBytes += part.length;
        if (this.bufferedBytes > this.maximumBytes) {
            throw new BackupFormatError("Backup record exceeds the size limit");
        }
    }

    private emitLine(part: Buffer): void {
        this.addPart(part);
        if (this.bufferedBytes === 0) {
            throw new BackupFormatError("Backup contains an empty record");
        }
        this.push(
            Buffer.concat(this.parts, this.bufferedBytes).toString("utf8"),
        );
        this.parts.length = 0;
        this.bufferedBytes = 0;
    }

    private consumeChunk(chunk: Buffer): void {
        let offset = 0;
        for (
            let lineCount = 0;
            lineCount <= this.maximumBytes;
            lineCount += 1
        ) {
            const newline = chunk.indexOf(0x0a, offset);
            if (newline === -1) break;
            this.emitLine(chunk.subarray(offset, newline));
            offset = newline + 1;
        }
        this.addPart(chunk.subarray(offset));
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
    const source = fs.createReadStream(filePath);
    const gunzip = createGunzip();
    const stream = new BoundedLineSplitter(maximumRecordBytes);
    const completion = pipeline(source, gunzip, stream, { signal });
    let consumed = false;
    try {
        for await (const line of stream) {
            signal?.throwIfAborted();
            const text = String(line);
            yield {
                record: parseBackupRecord(text),
                bytes: Buffer.from(`${text}\n`, "utf8"),
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
