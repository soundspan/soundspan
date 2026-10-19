import fs from "fs";
import { Transform, type TransformCallback } from "stream";
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
): AsyncGenerator<BackupRecord> {
    const source = fs.createReadStream(filePath);
    const gunzip = createGunzip();
    const stream = new BoundedLineSplitter(maximumRecordBytes);
    source.on("error", (error) => stream.destroy(error));
    gunzip.on("error", (error) => stream.destroy(error));
    source.pipe(gunzip).pipe(stream);
    try {
        for await (const line of stream) {
            yield parseBackupRecord(String(line));
        }
    } catch (cause) {
        if (cause instanceof BackupFormatError) throw cause;
        throw new BackupFormatError("Backup archive is truncated or invalid", {
            cause,
        });
    }
}

/** Read only the first bounded record and require it to be a header. */
export async function readBackupHeader(
    filePath: string,
): Promise<BackupHeader> {
    for await (const record of readBackupRecords(filePath)) {
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

/** Validate full framing and exact per-table row counts before destructive work. */
export async function validateBackupArchive(
    filePath: string,
): Promise<ArchiveValidation> {
    let header: BackupHeader | null = null;
    let ended = false;
    const counts = new Map<string, number>();
    for await (const record of readBackupRecords(filePath)) {
        if (ended) throw new BackupFormatError("Backup has trailing data");
        if (!header) {
            if (record.type !== "header") {
                throw new BackupFormatError("Backup header is missing");
            }
            header = record;
            continue;
        }
        if (record.type === "header") {
            throw new BackupFormatError("Backup contains multiple headers");
        }
        if (record.type === "end") {
            ended = true;
            continue;
        }
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
    return { header, rows: totalRows };
}
